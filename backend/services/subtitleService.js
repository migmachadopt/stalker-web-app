// ═══════════════════════════════════════════════════════════════════════════════
// 💬 Subtitle Service - Embedded MP4 subtitle tracks (tx3g / mov_text)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Films carry their subtitles as a text track inside the MP4, which browsers do
// not display. The provider allows a single connection per account, so nothing
// here opens one: both the file index (moov), which says where every subtitle
// sample lives, and the samples themselves are picked out of the bytes that
// already flow through the stream proxy while the film plays. What was found is
// stored per title, so the next playback has it without reading it again.

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const logger = require('../utils/logger');

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_TOP_BOXES = 16;
const STORE_DIR = path.join(config.DATA_DIR, 'subtitles');
const SAVE_INTERVAL = 20000;

class SubtitleService {
  // ── Storage ──────────────────────────────────────────────────────────────

  storePath(key) {
    return path.join(STORE_DIR, `${key}.json`);
  }

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
        status: subtitles.status,
        language: subtitles.language,
        complete: !!subtitles.complete,
        // [offset, size, start, end] of every line, so the index is not needed again
        samples: subtitles.samples.map(s => [s.offset, s.size, s.start, s.end]),
        cues: subtitles.cues
      }));
      subtitles.dirty = false;
      subtitles.savedAt = Date.now();
    } catch (error) {
      logger.warn('stream', 'Subtitles could not be stored', { error: error.message });
    }
  }

  // Subtitle state for a title: { status, language, samples, cues, key, complete }
  //   loading  the file index has not passed through the proxy yet
  //   ready    the track is known; lines are collected as the film is read
  //   none     the file has no text track
  open(key) {
    const stored = key ? this.load(key) : null;

    if (stored?.status === 'none') {
      return { status: 'none', samples: [], cues: [], key };
    }

    if (stored?.status === 'ready' && Array.isArray(stored.samples)) {
      const samples = stored.samples.map(([offset, size, start, end], i) => ({ offset, size, start, end, i }));
      stored.cues.forEach(cue => { if (samples[cue.i]) samples[cue.i].done = true; });

      // Lines that turned out empty leave no cue; when the track was complete, all are done
      if (stored.complete) samples.forEach(s => { s.done = true; });

      return {
        status: 'ready',
        language: stored.language,
        samples,
        cues: stored.cues,
        key,
        complete: !!stored.complete,
        collected: samples.filter(s => s.done).length
      };
    }

    return { status: 'loading', samples: [], cues: [], key, scan: { next: 0, boxes: 0, header: null, moov: null } };
  }

  // ── MP4 index ────────────────────────────────────────────────────────────

  // Copy the part of `chunk` (file offset `position`) that belongs to `target`
  // ({ offset, size, data, got }); true once the target is whole. Pieces only
  // count in order, so repeats and gaps are ignored.
  fill(target, position, chunk) {
    const from = Math.max(position, target.offset);
    const to = Math.min(position + chunk.length, target.offset + target.size);

    if (to <= from || from - target.offset > target.got) return target.got >= target.size;

    chunk.copy(target.data, from - target.offset, from - position, to - position);
    target.got = Math.max(target.got, to - target.offset);

    return target.got >= target.size;
  }

  // Follow the top-level boxes of the file as its bytes go by, until the index
  // (moov) has been seen whole; then work out the subtitle track from it.
  feedIndex(subtitles, position, chunk) {
    const scan = subtitles.scan;
    const end = position + chunk.length;

    while (subtitles.status === 'loading') {
      if (scan.moov) {
        if (!this.fill(scan.moov, position, chunk)) return;

        this.useIndex(subtitles, scan.moov.data);
        subtitles.scan = null;
        return;
      }

      if (!scan.header) {
        scan.header = { offset: scan.next, size: 16, data: Buffer.alloc(16), got: 0 };
      }

      // The next box header is not in this piece of the file
      if (scan.header.offset >= end || scan.header.offset + scan.header.got < position) return;
      if (!this.fill(scan.header, position, chunk)) return;

      const header = scan.header.data;
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (size === 1) size = Number(header.readBigUInt64BE(8));

      scan.header = null;

      if (size < 8 || ++scan.boxes > MAX_TOP_BOXES || !/^[\x20-\x7e]{4}$/.test(type)) {
        return this.setNone(subtitles);
      }

      if (type === 'moov') {
        if (size > MAX_INDEX_BYTES) return this.setNone(subtitles);
        scan.moov = { offset: scan.next, size, data: Buffer.alloc(size), got: 0 };
      } else {
        scan.next += size;
      }
    }
  }

  setNone(subtitles) {
    subtitles.status = 'none';
    subtitles.scan = null;
    subtitles.dirty = true;
    this.save(subtitles);
  }

  useIndex(subtitles, index) {
    try {
      const moov = this.children(index).moov?.[0];
      const tracks = (moov ? this.children(moov).trak || [] : [])
        .map(trak => this.parseTextTrack(trak))
        .filter(track => track && track.samples.length);

      if (!tracks.length) return this.setNone(subtitles);

      // Portuguese first (the one flagged as default if there are several)
      const track = tracks.find(t => t.language === 'por' && t.enabled)
        || tracks.find(t => t.language === 'por')
        || tracks.find(t => t.enabled)
        || tracks[0];

      subtitles.status = 'ready';
      subtitles.language = track.language;
      subtitles.samples = track.samples;
      subtitles.collected = 0;
      subtitles.dirty = true;
      this.save(subtitles);

      logger.info('stream', 'Subtitle track found', { language: track.language, lines: track.samples.length });
    } catch (error) {
      logger.warn('stream', 'Subtitle index not readable', { error: error.message });
      this.setNone(subtitles);
    }
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

  // ── Lines ────────────────────────────────────────────────────────────────

  // tx3g sample: 16-bit text length, the text, then optional style boxes
  decode(sample, data) {
    const length = Math.min(data.readUInt16BE(0), data.length - 2);
    const text = data.toString('utf8', 2, 2 + length).replace(/\r/g, '').trim();
    return text ? { i: sample.i, start: sample.start, end: sample.end, text } : null;
  }

  // Called with every piece of the file the proxy forwards to the player
  feed(subtitles, position, chunk) {
    if (subtitles.status === 'loading') this.feedIndex(subtitles, position, chunk);
    if (subtitles.status === 'ready' && !subtitles.complete) this.collect(subtitles, position, chunk);
  }

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

      if (this.fill(sample, position, chunk)) {
        const cue = this.decode(sample, sample.data);
        if (cue) subtitles.cues.push(cue);
        sample.done = true;
        sample.data = null;
        subtitles.collected = (subtitles.collected || 0) + 1;
        subtitles.dirty = true;
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
