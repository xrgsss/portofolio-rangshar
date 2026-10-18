/**
 * lib/session-store.js
 * ---------------------------------------------------------------------------
 * Session store sendiri: data disimpan di memori dan dicadangkan ke file JSON.
 *
 * Kenapa tidak memakai paket pihak ketiga?
 *  - penulisan ke disk dilakukan secara ATOMIK (tulis file sementara lalu
 *    rename), sehingga permintaan berikutnya tidak pernah membaca file
 *    setengah jadi;
 *  - data dibaca dari memori, jadi sesi langsung dikenal setelah login;
 *  - sesi tetap hidup walau server di-restart;
 *  - sesi kedaluwarsa dibersihkan otomatis.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

class FileSessionStore extends session.Store {
  /**
   * @param {{ dir:string, ttl:number, reapInterval?:number }} options
   *   ttl dalam milidetik
   */
  constructor({ dir, ttl, reapInterval = CLEANUP_INTERVAL_MS }) {
    super();
    this.dir = dir;
    this.ttl = ttl;
    this.reapInterval = reapInterval;
    this.cache = new Map();

    fs.mkdirSync(this.dir, { recursive: true });
    this.loadFromDisk();

    if (this.reapInterval > 0) {
      this.timer = setInterval(() => this.reap(), this.reapInterval);
      // Jangan menahan proses hanya karena timer ini.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  fileFor(sid) {
    // Hindari path traversal lewat sid yang nakal.
    const safe = String(sid).replace(/[^A-Za-z0-9_-]/g, '');
    return path.join(this.dir, `${safe}.json`);
  }

  loadFromDisk() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }

    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.dir, file);
      try {
        const entry = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!entry || typeof entry !== 'object' || !entry.session) throw new Error('rusak');
        if (entry.expiresAt && entry.expiresAt <= now) {
          fs.rmSync(full, { force: true });
          continue;
        }
        this.cache.set(entry.sid, entry);
      } catch {
        fs.rmSync(full, { force: true });
      }
    }
  }

  persist(sid) {
    const entry = this.cache.get(sid);
    const file = this.fileFor(sid);

    if (!entry) {
      fs.rmSync(file, { force: true });
      return;
    }

    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      console.error(`⚠  Gagal menyimpan sesi: ${error.message}`);
    }
  }

  entryFrom(sid, sessionData) {
    const ttl = this.ttl > 0 ? this.ttl : 8 * 60 * 60 * 1000;
    return {
      sid,
      session: sessionData,
      expiresAt: Date.now() + ttl,
    };
  }

  get(sid, callback) {
    const entry = this.cache.get(sid);
    if (!entry) return callback(null, null);

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.cache.delete(sid);
      this.persist(sid);
      return callback(null, null);
    }

    return callback(null, entry.session);
  }

  set(sid, sessionData, callback) {
    this.cache.set(sid, this.entryFrom(sid, sessionData));
    this.persist(sid);
    if (typeof callback === 'function') callback(null);
    return undefined;
  }

  touch(sid, sessionData, callback) {
    const entry = this.cache.get(sid);
    if (entry) {
      entry.expiresAt = this.entryFrom(sid, entry.session).expiresAt;
      this.persist(sid);
    }
    if (typeof callback === 'function') callback(null);
    return undefined;
  }

  destroy(sid, callback) {
    this.cache.delete(sid);
    this.persist(sid);
    if (typeof callback === 'function') callback(null);
    return undefined;
  }

  /** Hapus sesi yang sudah kedaluwarsa. */
  reap() {
    const now = Date.now();
    for (const [sid, entry] of this.cache) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.cache.delete(sid);
        this.persist(sid);
      }
    }
  }

  length(callback) {
    callback(null, this.cache.size);
  }

  all(callback) {
    callback(null, [...this.cache.values()].map((entry) => entry.session));
  }

  clear(callback) {
    for (const sid of [...this.cache.keys()]) {
      this.cache.delete(sid);
      this.persist(sid);
    }
    callback(null);
  }
}

module.exports = { FileSessionStore };
