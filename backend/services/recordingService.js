// ═══════════════════════════════════════════════════════════════════════════════
// 📼 Recording Service - Library of recordings saved on the server
// ═══════════════════════════════════════════════════════════════════════════════
//
// A recording goes through these states:
//   queued       waiting for its turn to be downloaded
//   downloading  being copied from the provider to this server
//   ready        downloaded; waiting for the user to mark where it starts and ends
//   waiting      marked; waiting for its turn to be converted
//   converting   being cut and converted to MP4
//   done         MP4 ready to watch or download
//   failed       something went wrong (see `error`); can be tried again
//
// Only one download and one conversion run at any time: the provider allows a
// single connection, and video conversion takes all the processor there is.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const config = require('../config/constants');
const logger = require('../utils/logger');
const userService = require('./userService');
const iptvService = require('./iptvService');
const archiveService = require('./archiveService');
const channelListService = require('./channelListService');
const streamService = require('./streamService');

const DIR = config.RECORDINGS_DIR;
const INDEX = path.join(DIR, 'library.json');

class RecordingService {
  constructor() {
    this.jobs = [];
    this.download = null;   // { id, handle }
    this.conversion = null; // { id, process }
    this.frames = new Map(); // `${id}:${second}` -> JPEG buffer
    this.frameQueue = Promise.resolve();
    this.tickets = new Map(); // ticket -> { id, userId, expiresAt }
    this.ffmpeg = null;       // true/false once checked

    this.load();
    this.checkFfmpeg();
    setInterval(() => this.pump(), 5000);
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  load() {
    try {
      this.jobs = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    } catch (_) {
      this.jobs = [];
    }

    // Work cut short by a restart starts again
    this.jobs.forEach(job => {
      if (job.state === 'downloading') { job.state = 'queued'; job.progress = 0; }
      if (job.state === 'converting') { job.state = 'waiting'; job.progress = 0; }
    });
  }

  save() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(INDEX, JSON.stringify(this.jobs, null, 1));
    } catch (error) {
      logger.error('data', 'Library could not be saved', { error: error.message });
    }
  }

  sourcePath(job) { return path.join(DIR, `${job.id}.ts`); }
  outputPath(job) { return path.join(DIR, `${job.id}.mp4`); }

  checkFfmpeg() {
    execFile('ffmpeg', ['-version'], (error) => {
      this.ffmpeg = !error;
      if (error) logger.warn('server', 'ffmpeg not found: the library cannot convert recordings');
    });
  }

  freeBytes() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const stat = fs.statfsSync(DIR);
      return stat.bavail * stat.bsize;
    } catch (_) {
      return null;
    }
  }

  // ── Listing ──────────────────────────────────────────────────────────────

  view(job) {
    const { request, ...shown } = job;
    return shown;
  }

  list(userId) {
    return this.jobs
      .filter(job => job.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(job => this.view(job));
  }

  find(userId, id) {
    const job = this.jobs.find(j => j.id === id && j.userId === userId);
    if (!job) throw new Error('Recording not found');
    return job;
  }

  status() {
    return { ffmpeg: this.ffmpeg !== false, freeBytes: this.freeBytes() };
  }

  // ── Adding ───────────────────────────────────────────────────────────────

  add(user, channel, request, title) {
    if (!channel.archive) throw new Error('This channel has no archive');

    const free = this.freeBytes();
    if (free !== null && free < config.RECORDINGS_MIN_FREE_BYTES) {
      throw new Error('Not enough free space on the server. Delete finished recordings first.');
    }

    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      userId: user.id,
      channelId: channel.id,
      channelName: channel.name,
      channelLogo: channel.logo || '',
      title: String(title || 'Recording').slice(0, 150),
      request,
      state: 'queued',
      progress: 0,
      error: '',
      createdAt: Date.now()
    };

    this.jobs.push(job);
    this.save();
    this.pump();

    return this.view(job);
  }

  // ── Downloading ──────────────────────────────────────────────────────────

  pump() {
    if (!this.download) {
      const next = this.jobs.find(job => job.state === 'queued');
      if (next) this.startDownload(next);
    }

    if (!this.conversion) {
      const next = this.jobs.find(job => job.state === 'waiting');
      if (next) this.startConversion(next);
    }

    // Keep the progress of the running download current
    if (this.download) {
      const job = this.jobs.find(j => j.id === this.download.id);
      const handle = this.download.handle;
      if (job && handle) {
        const { total, written } = handle.progress();
        job.progress = total ? Math.min(99, Math.round((written / total) * 100)) : 0;
        job.sourceBytes = total;
      }
    }
  }

  fail(job, error) {
    job.state = 'failed';
    job.error = error.message || String(error);
    job.progress = 0;
    logger.error('data', 'Recording failed', { title: job.title, error: job.error });
    this.save();
  }

  async startDownload(job) {
    this.download = { id: job.id, handle: null };
    job.state = 'downloading';
    job.progress = 0;
    job.error = '';
    this.save();

    try {
      const user = userService.findUserById(job.userId);
      if (!user) throw new Error('User no longer exists');

      const channel = channelListService.findVisibleChannel(user, job.channelId);
      if (!channel) throw new Error('Channel not available');

      const { sessionId, session } = await iptvService.connect(user);
      iptvService.touchSession(sessionId);

      const link = () => archiveService.createWindowLink(sessionId, user.id, channel, job.request);
      const window = await link();

      job.sourceStart = window.start;
      job.sourceDuration = window.duration;

      fs.mkdirSync(DIR, { recursive: true });

      const handle = streamService.downloadToFile({
        url: window.url,
        relink: async () => (await link()).url,
        name: job.title,
        username: session.username,
        userId: user.id
      }, this.sourcePath(job));

      this.download.handle = handle;

      // Removed while the link was being prepared
      if (job.state !== 'downloading') handle.cancel();

      // The portal session must stay alive while the file comes down
      const keepAlive = setInterval(() => iptvService.touchSession(sessionId), 60000);
      try {
        job.sourceBytes = await handle.done;
      } finally {
        clearInterval(keepAlive);
      }

      if (job.state !== 'downloading') throw new Error('Cancelled');

      job.duration = await this.probeDuration(this.sourcePath(job)) || job.sourceDuration;
      job.cutStart = 0;
      job.cutEnd = Math.floor(job.duration);
      job.state = 'ready';
      job.progress = 100;
      this.save();

      logger.info('data', 'Recording downloaded', { title: job.title, minutes: Math.round(job.duration / 60) });
    } catch (error) {
      fs.rm(this.sourcePath(job), { force: true }, () => {});
      if (job.state === 'downloading') this.fail(job, error);
    } finally {
      this.download = null;
      this.pump();
    }
  }

  probeDuration(file) {
    return new Promise(resolve => {
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], (error, stdout) => {
        const seconds = Number(String(stdout).trim());
        resolve(!error && Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
      });
    });
  }

  // ── Marking start and end ────────────────────────────────────────────────

  // One frame of a downloaded recording, as a small JPEG. Frames are extracted
  // one at a time and remembered, so dragging the markers stays light.
  frame(userId, id, seconds) {
    const job = this.find(userId, id);
    if (!['ready', 'waiting', 'converting'].includes(job.state)) throw new Error('Recording has no source to preview');

    const second = Math.min(Math.max(0, Math.floor(Number(seconds) || 0)), Math.max(0, Math.floor(job.duration) - 1));
    const key = `${id}:${second}`;
    if (this.frames.has(key)) return Promise.resolve(this.frames.get(key));

    const task = this.frameQueue.then(() => new Promise((resolve, reject) => {
      if (this.frames.has(key)) return resolve(this.frames.get(key));

      execFile('ffmpeg', [
        '-v', 'error', '-ss', String(second), '-i', this.sourcePath(job),
        '-frames:v', '1', '-vf', 'yadif,scale=640:-2', '-q:v', '6', '-f', 'image2', 'pipe:1'
      ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (error, stdout) => {
        if (error || !stdout.length) return reject(new Error('Frame not available'));

        if (this.frames.size > 300) this.frames.clear();
        this.frames.set(key, stdout);
        resolve(stdout);
      });
    }));

    // One failed frame must not block the ones after it
    this.frameQueue = task.catch(() => {});
    return task;
  }

  setCut(userId, id, start, end) {
    const job = this.find(userId, id);
    if (job.state !== 'ready') throw new Error('This recording is not waiting to be marked');
    if (this.ffmpeg === false) throw new Error('ffmpeg is not installed on the server');

    const from = Math.max(0, Math.floor(Number(start)));
    const to = Math.min(Math.floor(job.duration), Math.floor(Number(end)));

    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 5) {
      throw new Error('The end must be at least 5 seconds after the start');
    }

    job.cutStart = from;
    job.cutEnd = to;
    job.state = 'waiting';
    job.progress = 0;
    this.save();
    this.pump();

    return this.view(job);
  }

  // ── Converting ───────────────────────────────────────────────────────────

  startConversion(job) {
    const length = job.cutEnd - job.cutStart;
    const output = this.outputPath(job);
    const partial = `${output}.part`;

    job.state = 'converting';
    job.progress = 0;
    job.error = '';
    this.save();

    // Same picture size as the source, deinterlaced, in a format browsers play.
    // `nice` keeps the rest of the server responsive while it runs.
    const child = spawn('nice', [
      '-n', '10', 'ffmpeg', '-v', 'error', '-y',
      '-ss', String(job.cutStart), '-i', this.sourcePath(job), '-t', String(length),
      '-vf', 'yadif',
      '-c:v', 'libx264', '-preset', config.CONVERT_PRESET, '-crf', config.CONVERT_CRF, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      '-f', 'mp4', partial
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.conversion = { id: job.id, process: child };

    let errors = '';
    child.stderr.on('data', data => { errors = (errors + data).slice(-600); });
    child.stdout.on('data', data => {
      const match = /out_time_ms=(\d+)/g;
      let found;
      let last = null;
      while ((found = match.exec(String(data)))) last = found[1];
      if (last !== null) job.progress = Math.min(99, Math.round((Number(last) / 1e6 / length) * 100));
    });

    child.on('error', (error) => { errors = error.message; });

    child.on('close', (code) => {
      this.conversion = null;

      if (job.state !== 'converting') {
        // cancelled or deleted meanwhile
        fs.rm(partial, { force: true }, () => {});
      } else if (code === 0 && fs.existsSync(partial)) {
        fs.renameSync(partial, output);
        job.state = 'done';
        job.progress = 100;
        job.outputBytes = fs.statSync(output).size;
        job.outputDuration = length;
        job.finishedAt = Date.now();
        // The MP4 is the result; the original is no longer needed
        fs.rm(this.sourcePath(job), { force: true }, () => {});
        this.save();
        logger.info('data', 'Recording converted', { title: job.title, minutes: Math.round(length / 60) });
      } else {
        fs.rm(partial, { force: true }, () => {});
        // Back to marking, so it can be tried again without downloading again
        job.state = 'ready';
        job.progress = 0;
        job.error = `Conversion failed: ${errors.trim().split('\n').pop() || `ffmpeg exited with ${code}`}`;
        this.save();
        logger.error('data', 'Recording conversion failed', { title: job.title, error: job.error });
      }

      this.pump();
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  stopWork(job) {
    if (this.download?.id === job.id && this.download.handle) this.download.handle.cancel();
    if (this.conversion?.id === job.id) this.conversion.process.kill('SIGKILL');
  }

  // Stop what is running: a download is dropped, a conversion goes back to marking
  cancel(userId, id) {
    const job = this.find(userId, id);

    if (job.state === 'queued' || job.state === 'downloading') {
      return this.remove(userId, id);
    }

    if (job.state === 'waiting' || job.state === 'converting') {
      const wasConverting = job.state === 'converting';
      job.state = 'ready';
      job.progress = 0;
      if (wasConverting) this.stopWork(job);
      this.save();
    }

    return this.view(job);
  }

  retry(userId, id) {
    const job = this.find(userId, id);
    if (job.state !== 'failed') throw new Error('Only a failed recording can be tried again');

    job.state = 'queued';
    job.error = '';
    job.progress = 0;
    this.save();
    this.pump();

    return this.view(job);
  }

  remove(userId, id) {
    const job = this.find(userId, id);

    job.state = 'removed';
    this.stopWork(job);
    this.jobs = this.jobs.filter(j => j !== job);
    this.save();

    for (const file of [this.sourcePath(job), this.outputPath(job), `${this.outputPath(job)}.part`]) {
      fs.rm(file, { force: true }, () => {});
    }
    for (const key of this.frames.keys()) {
      if (key.startsWith(`${id}:`)) this.frames.delete(key);
    }

    return { id, removed: true };
  }

  // Removing a user removes their recordings
  removeUser(userId) {
    this.jobs.filter(job => job.userId === userId).forEach(job => this.remove(userId, job.id));
  }

  // ── Watching the result ──────────────────────────────────────────────────

  // A video element cannot send the login header, so it gets a temporary address
  createTicket(userId, id) {
    const job = this.find(userId, id);
    if (job.state !== 'done') throw new Error('This recording is not finished yet');

    const now = Date.now();
    for (const [key, ticket] of this.tickets.entries()) {
      if (ticket.expiresAt < now) this.tickets.delete(key);
    }

    const ticket = crypto.randomBytes(18).toString('hex');
    this.tickets.set(ticket, { id, userId, expiresAt: now + 12 * 60 * 60 * 1000 });
    return ticket;
  }

  resolveTicket(ticket) {
    const entry = this.tickets.get(ticket);
    if (!entry || entry.expiresAt < Date.now()) return null;

    const job = this.jobs.find(j => j.id === entry.id && j.userId === entry.userId && j.state === 'done');
    return job ? { job, file: this.outputPath(job) } : null;
  }
}

module.exports = new RecordingService();
