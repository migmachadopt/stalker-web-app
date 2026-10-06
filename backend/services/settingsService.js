// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ Settings Service - Application settings managed from the admin area
// ═══════════════════════════════════════════════════════════════════════════════
//
// storageRoot: the folder where the library keeps its files. The app creates
// and uses three folders inside it:
//   downloads/  recordings copied from the provider, waiting to be trimmed
//   library/    finished MP4 files (readable names, to browse the disk directly)
//   tmp/        conversions in progress
//
// The root itself must already exist: if it is on a disk that is not mounted,
// nothing is written to the system card in its place.
//
// castBaseUrl: address of this server on the home network, given to a
// Chromecast so videos do not travel through the internet address.
//
// tmdbKey: key for themoviedb.org, used to read film and episode details for
// the library (see metadataService). It never leaves the server.

const fs = require('fs');
const path = require('path');
const config = require('../config/constants');
const logger = require('../utils/logger');

const FILE = path.join(config.DATA_DIR, 'settings.json');

class SettingsService {
  constructor() {
    try {
      this.settings = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (_) {
      this.settings = {};
    }
  }

  get() {
    const { tmdbKey, ...shown } = this.settings;
    return { ...shown, tmdbKeySet: !!tmdbKey };
  }

  // Address the Chromecast uses to fetch videos ('' = the address the app was opened at)
  castBase() {
    return this.settings.castBaseUrl || '';
  }

  tmdbKey() {
    return this.settings.tmdbKey || '';
  }

  storageRoot() {
    return this.settings.storageRoot || config.RECORDINGS_DIR;
  }

  folders() {
    const root = this.storageRoot();
    return {
      root,
      downloads: path.join(root, 'downloads'),
      library: path.join(root, 'library'),
      temp: path.join(root, 'tmp')
    };
  }

  // Can the app work in this root? { ok, error, freeBytes, totalBytes }
  // The answer is reused for a little while: the library asks every few
  // seconds, and a disk should not be written to (or woken) that often.
  check(root, fresh = false) {
    const cached = this.lastCheck;
    if (!fresh && cached && cached.root === root && Date.now() - cached.at < 30000) {
      return cached.result;
    }

    const result = this.checkNow(root);
    this.lastCheck = { root, at: Date.now(), result };
    return result;
  }

  checkNow(root) {
    if (!root || !path.isAbsolute(root)) {
      return { ok: false, error: 'Use a full path, starting with /' };
    }

    // The default folder lives with the app data and may be created; any other
    // root must exist, so an unmounted disk is noticed instead of filled on the card
    const isDefault = root === config.RECORDINGS_DIR;
    if (!isDefault && !fs.existsSync(root)) {
      return { ok: false, error: `${root} does not exist. Is the disk mounted?` };
    }

    try {
      for (const name of ['downloads', 'library', 'tmp']) {
        fs.mkdirSync(path.join(root, name), { recursive: true });
      }

      const probe = path.join(root, 'tmp', `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);

      const stat = fs.statfsSync(root);
      return { ok: true, freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
    } catch (error) {
      const user = (() => { try { return require('os').userInfo().username; } catch (_) { return 'the app user'; } })();
      return {
        ok: false,
        error: error.code === 'EACCES' || error.code === 'EPERM'
          ? `The app (user "${user}") cannot write in ${root}. On the server run: sudo chown -R ${user}:${user} "${root}"`
          : error.message
      };
    }
  }

  update(patch) {
    const next = { ...this.settings };

    if (patch.storageRoot !== undefined) {
      const root = String(patch.storageRoot || '').trim().replace(/\/+$/, '') || config.RECORDINGS_DIR;
      const result = this.check(root, true);
      if (!result.ok) throw new Error(result.error);
      next.storageRoot = root === config.RECORDINGS_DIR ? undefined : root;
    }

    if (patch.castBaseUrl !== undefined) {
      const base = String(patch.castBaseUrl || '').trim().replace(/\/+$/, '');
      if (base && !/^https?:\/\/[^\/\s]+$/i.test(base)) {
        throw new Error('Use an address like http://192.168.1.159 (no path after it)');
      }
      next.castBaseUrl = base || undefined;
    }

    if (patch.tmdbKey !== undefined) {
      next.tmdbKey = String(patch.tmdbKey || '').trim() || undefined;
    }

    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    this.settings = next;

    logger.info('server', 'Settings updated', { storageRoot: this.storageRoot(), tmdbKey: !!next.tmdbKey });
    return this.get();
  }
}

module.exports = new SettingsService();
