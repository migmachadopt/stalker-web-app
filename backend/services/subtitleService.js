// ═══════════════════════════════════════════════════════════════════════════════
// 💬 Subtitle Service - Embedded MP4 subtitle tracks (tx3g / mov_text)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Films carry their subtitles as a text track inside the MP4, which browsers do
// not display. The track's samples are a few bytes each, scattered through the
// whole file, so fetching them separately would mean thousands of requests.
// Instead the file index (moov) is read once to learn where every subtitle
// sample lives, and the samples are picked out of the bytes that already flow
// through the stream proxy while the film plays. What was found is stored per
// title, so the next playback has the lines without reading them again.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config/constants');
const logger = require('../utils/logger');

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const STORE_DIR = path.join(config.DATA_DIR, 'subtitles');
const SAVE_INTERVAL = 20000;

class SubtitleService {
  async readRange(url, from, to) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': config.STALKER_HEADERS['User-Agent'],
        Range: `bytes=${from}-${to}`
      },
      validateStatus: (status) => status === 206 || status === 200
    });

    return Buffer.from(response.data);
  }

  // Walk the top-level boxes until the index (moov) is found, and download it
  async readIndex(url) {
    let offset = 0;

    for (let i = 0; i < 12; i++) {
      const header = await this.readRange(url, offset, offset + 15);
      if (header.length < 8) return null;

      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);

      if (size === 1 && header.length >= 16) size = Number(header.readBigUInt64BE(8));
      if (size < 8) return null;

      if (type === 'moov') {
        if (size > MAX_INDEX_BYTES) return null;
        return this.readRange(url, offset, offset + size - 1);
      }

      offset += size;
    }

    return null;
  }

  // Child boxes of a container as { type: [payload, ...] }
  children(buffer) {
    const boxes = {};
    let offset = 0;

    while (offset + 8 <= buffer.length) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      let headerSize = 8;

      if (size === 1) {
        size = Number(buffer.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = buffer.length - offset;
      }

      if (size < headerSize || offset + size > buffer.length) break;

      (boxes[type] = boxes[type] || []).push(buffer.subarray(offset + headerSize, offset + size));
      offset += size;
    }

    return boxes;
  }

  // Every sample of a text track: where it is in the file and when it shows
  parseTextTrack(trak) {
    const boxes = this.children(trak);
    const mdia = boxes.mdia?.[0];
    if (!mdia) return null;

    // tkhd flags, bit 0: the track the file wants shown by default
    const enabled = !!(boxes.tkhd?.[0] && (boxes.tkhd[0].readUInt8(3) & 1));

    const media = this.children(mdia);
    const handler = media.hdlr?.[0]?.toString('latin1', 8, 12);
    if (handler !== 'sbtl' && handler !== 'text') return null;

    const stbl = this.children(this.children(media.minf?.[0] || Buffer.alloc(0)).stbl?.[0] || Buffer.alloc(0));
    const { stsd, stts, stsc, stsz } = stbl;
    const chunkOffsets = stbl.stco?.[0] || stbl.co64?.[0];

    if (!stsd || !stts || !stsc || !stsz || !chunkOffsets) return null;
    if (stsd[0].toString('latin1', 12, 16) !== 'tx3g') return null;

    const mdhd = media.mdhd?.[0];
    if (!mdhd) return null;

    const longForm = mdhd.readUInt8(0) === 1;
    const timescale = mdhd.readUInt32BE(longForm ? 20 : 12) || 1000;
    const packedLanguage = mdhd.readUInt16BE(longForm ? 32 : 20);
    const language = [10, 5, 0].map(shift => String.fromCharCode(((packedLanguage >> shift) & 0x1f) + 0x60)).join('');

    // Sizes
    const fixedSize = stsz[0].readUInt32BE(4);
    const sampleCount = stsz[0].readUInt32BE(8);
    const sizeOf = (i) => fixedSize || stsz[0].readUInt32BE(12 + i * 4);

    // Timing
    const times = [];
    let clock = 0;
    for (let i = 0, entries = stts[0].readUInt32BE(4); i < entries; i++) {
      const count = stts[0].readUInt32BE(8 + i * 8);
      const delta = stts[0].readUInt32BE(12 + i * 8);
      for (let n = 0; n < count && times.length < sampleCount; n++) {
        times.push([clock / timescale, (clock + delta) / timescale]);
        clock += delta;
      }
    }

    // Placement: samples are grouped in chunks, and each chunk has a file offset
    const wide = !stbl.stco;
    const chunkCount = chunkOffsets.readUInt32BE(4);
    const chunkOffset = (c) => wide
      ? Number(chunkOffsets.readBigUInt64BE(8 + c * 8))
      : chunkOffsets.readUInt32BE(8 + c * 4);

    const runs = [];
    for (let i = 0, entries = stsc[0].readUInt32BE(4); i < entries; i++) {
      runs.push({ firstChunk: stsc[0].readUInt32BE(8 + i * 12), perChunk: stsc[0].readUInt32BE(12 + i * 12) });
    }

    const samples = [];
    let sample = 0;
    let run = 0;

    for (let chunk = 0; chunk < chunkCount && sample < sampleCount; chunk++) {
      while (run + 1 < runs.length && chunk + 1 >= runs[run + 1].firstChunk) run++;

      let offset = chunkOffset(chunk);
      for (let n = 0; n < runs[run].perChunk && sample < sampleCount; n++, sample++) {
        const size = sizeOf(sample);
        const [start, end] = times[sample] || [0, 0];
        // Two bytes or fewer is an empty sample: a gap between lines
        if (size > 2 && end > start) samples.push({ offset, size, start, end });
        offset += size;
      }
    }

    samples.sort((a, b) => a.offset - b.offset);
    samples.forEach((s, i) => { s.i = i; });

    return { language, enabled, samples };
  }

  storePath(key) {
    return path.join(STORE_DIR, `${key}.json`);
  }

  // Lines stored from earlier playbacks of this title
  load(key) {
    try {
      return JSON.parse(fs.readFileSync(this.storePath(key), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  save(subtitles) {
    if (!subtitles.key || !subtitles.dirty) return;

    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      fs.writeFileSync(this.storePath(subtitles.key), JSON.stringify({
        language: subtitles.language,
        complete: !!subtitles.complete,
        cues: subtitles.cues
      }));
      subtitles.dirty = false;
      subtitles.savedAt = Date.now();
    } catch (error) {
      logger.warn('stream', 'Subtitles could not be stored', { error: error.message });
    }
  }

  // Subtitle state for a file: { status, language, samples, cues, key, complete }
  // `key` identifies the title, so lines found once are kept for next time.
  async prepare(url, key) {
    const stored = key ? this.load(key) : null;

    // Everything was collected before: nothing to read from the file
    if (stored?.complete) {
      return { status: 'ready', language: stored.language, samples: [], cues: stored.cues, key, complete: true };
    }

    try {
      let index;
      try {
        index = await this.readIndex(url);
      } catch (error) {
        // The provider sometimes refuses a request made right after another one
        await new Promise(resolve => setTimeout(resolve, 1500));
        index = await this.readIndex(url);
      }
      if (!index) return { status: 'none', cues: [] };

      const moov = this.children(index).moov?.[0];
      if (!moov) return { status: 'none', cues: [] };

      const tracks = (this.children(moov).trak || [])
        .map(trak => this.parseTextTrack(trak))
        .filter(track => track && track.samples.length);

      if (!tracks.length) return { status: 'none', cues: [] };

      // Portuguese first (the one flagged as default if there are several)
      const track = tracks.find(t => t.language === 'por' && t.enabled)
        || tracks.find(t => t.language === 'por')
        || tracks.find(t => t.enabled)
        || tracks[0];

      const cues = [];
      if (stored && stored.language === track.language) {
        stored.cues.forEach(cue => {
          const sample = track.samples[cue.i];
          if (sample && !sample.done) { sample.done = true; cues.push(cue); }
        });
      }

      logger.info('stream', 'Subtitle track found', {
        language: track.language,
        lines: track.samples.length,
        stored: cues.length
      });

      return { status: 'ready', language: track.language, samples: track.samples, cues, key, complete: false };
    } catch (error) {
      logger.warn('stream', 'Subtitle index not readable', { error: error.message });
      return { status: 'none', cues: [] };
    }
  }

  // tx3g sample: 16-bit text length, the text, then optional style boxes
  decode(sample, data) {
    const length = Math.min(data.readUInt16BE(0), data.length - 2);
    const text = data.toString('utf8', 2, 2 + length).replace(/\r/g, '').trim();
    return text ? { i: sample.i, start: sample.start, end: sample.end, text } : null;
  }

  // Called with every piece of the file the proxy forwards
  collect(subtitles, position, chunk) {
    const samples = subtitles.samples;
    const end = position + chunk.length;

    // First sample that ends after the start of this piece
    let low = 0;
    let high = samples.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (samples[mid].offset + samples[mid].size <= position) low = mid + 1; else high = mid;
    }

    for (let i = low; i < samples.length && samples[i].offset < end; i++) {
      const sample = samples[i];
      if (sample.done) continue;

      if (!sample.data) {
        sample.data = Buffer.alloc(sample.size);
        sample.got = 0;
      }

      const from = Math.max(position, sample.offset);
      const to = Math.min(end, sample.offset + sample.size);

      // Pieces are only useful in order; anything else is a repeat or a gap
      if (from - sample.offset > sample.got) continue;

      chunk.copy(sample.data, from - sample.offset, from - position, to - position);
      sample.got = Math.max(sample.got, to - sample.offset);

      if (sample.got >= sample.size) {
        const cue = this.decode(sample, sample.data);
        if (cue) subtitles.cues.push(cue);
        sample.done = true;
        sample.data = null;
        subtitles.dirty = true;
        subtitles.collected = (subtitles.collected || samples.filter(x => x.done).length - 1) + 1;
      }
    }

    if (!subtitles.dirty) return;

    // Store what is new now and then, and at once when the whole track is in
    if (subtitles.collected >= samples.length) {
      subtitles.complete = true;
      this.save(subtitles);
    } else if (Date.now() - (subtitles.savedAt || 0) > SAVE_INTERVAL) {
      this.save(subtitles);
    }
  }
}

module.exports = new SubtitleService();
