/**
 * lib/store.js
 * ---------------------------------------------------------------------------
 * Penyimpanan data website (isi halaman utama + semua halaman galeri).
 *
 * Ada dua mode, dipilih otomatis:
 *
 *   1. REDIS (dipakai di Vercel)
 *      Data disimpan sebagai dua key JSON. Perlu ini karena filesystem Vercel
 *      read-only; file di data/*.json hanya jadi nilai awal (seed).
 *
 *   2. FILE LOKAL (dipakai saat `npm start` tanpa Redis)
 *      Data ditulis ke data/content.json & data/galleries.json dengan pola
 *      "tulis ke file sementara lalu rename" + antrean, supaya file tidak
 *      pernah setengah tertulis.
 *
 * Semua fungsi baca/tulis bersifat async pada kedua mode, jadi kode pemanggil
 * tidak perlu tahu sedang memakai mode yang mana.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const redis = require('./redis');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const GALLERIES_FILE = path.join(DATA_DIR, 'galleries.json');

const CONTENT_KEY = 'portfolio:content';
const GALLERIES_KEY = 'portfolio:galleries';

const EMPTY_CONTENT = {
  meta: { siteTitle: 'Portfolio' },
  hero: {
    eyebrow: 'Hello,',
    title: '',
    role: '',
    lede: [],
    image: '',
    imageAlt: '',
    ctaLabel: "Let's talk",
    ctaHref: '#contact',
    socialRail: { label: '', href: '', caption: '' },
    navLinks: [],
  },
  about: { kicker: '', heading: '', body: [], image: '', imageAlt: '', buttons: [] },
  specialties: { kicker: '', heading: '', items: [] },
  portfolio: { kicker: '', heading: '', items: [] },
  experience: { kicker: '', heading: '', items: [] },
  tools: { kicker: '', heading: '', items: [] },
  contact: { socialKicker: '', socials: [], kicker: '', heading: '', button: { label: '', href: '' } },
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------- seed */

/**
 * Isi data/*.json ikut dibundel ke dalam function (lewat require) sehingga
 * bisa dipakai sebagai nilai awal saat Redis masih kosong. Setelah admin
 * menyimpan perubahan, yang dipakai selalu data dari Redis.
 */
const loadSeed = (file, fallback) => {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const parsed = require(file);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const SEED_CONTENT = loadSeed('../data/content.json', EMPTY_CONTENT);
const SEED_GALLERIES = loadSeed('../data/galleries.json', {});

/* ------------------------------------------------------- mode file lokal -- */

const readJsonSync = (file, fallback) => {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed === null || typeof parsed !== 'object' ? deepClone(fallback) : parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`⚠  Gagal membaca ${path.basename(file)}: ${error.message}`);
    }
    return deepClone(fallback);
  }
};

/**
 * Tulis ke file sementara lalu rename, supaya file asli tidak pernah terbaca
 * dalam keadaan setengah jadi. Kalau filesystem read-only (Vercel tanpa Redis),
 * kegagalan dilaporkan dengan pesan yang jelas.
 */
const writeJsonSync = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
};

/** Antrean penulisan sederhana agar operasi tulis tidak bertumpuk. */
const createWriteQueue = () => {
  let chain = Promise.resolve();
  return (task) => {
    chain = chain.then(task, task);
    return chain;
  };
};

const enqueueContent = createWriteQueue();
const enqueueGalleries = createWriteQueue();

/* ------------------------------------------------------------- pemakaian - */

const asObject = (value, fallback) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : deepClone(fallback);

const store = {
  DATA_DIR,
  CONTENT_FILE,
  GALLERIES_FILE,
  CONTENT_KEY,
  GALLERIES_KEY,
  EMPTY_CONTENT,

  /** true kalau data disimpan di Redis, false kalau di file lokal. */
  isRemote: () => redis.isConfigured(),

  /**
   * Konten halaman utama (salinan, aman untuk diubah pemanggil).
   *
   * Kalau Redis bermasalah, website TETAP tampil memakai isi awal dari
   * data/content.json, supaya satu gangguan di penyimpanan tidak membuat
   * seluruh website mati. Kegagalannya dicatat di log.
   */
  async getContent() {
    if (redis.isConfigured()) {
      try {
        const stored = await redis.getJson(CONTENT_KEY);
        if (stored) return asObject(stored, EMPTY_CONTENT);
      } catch (error) {
        console.error(`⚠  Gagal membaca konten dari Redis (${error.message}). Memakai data awal.`);
      }
      return deepClone(SEED_CONTENT);
    }
    return asObject(readJsonSync(CONTENT_FILE, SEED_CONTENT), EMPTY_CONTENT);
  },

  /** @param {object} content */
  async saveContent(content) {
    if (!content || typeof content !== 'object') throw new Error('Konten tidak valid');

    if (redis.isConfigured()) {
      await redis.setJson(CONTENT_KEY, content);
      return content;
    }

    await enqueueContent(() => writeJsonSync(CONTENT_FILE, content));
    return content;
  },

  /** Semua halaman galeri portfolio (juga tahan gangguan Redis, lihat getContent). */
  async getGalleries() {
    if (redis.isConfigured()) {
      try {
        const stored = await redis.getJson(GALLERIES_KEY);
        if (stored) return asObject(stored, {});
      } catch (error) {
        console.error(`⚠  Gagal membaca galeri dari Redis (${error.message}). Memakai data awal.`);
      }
      return deepClone(SEED_GALLERIES);
    }
    return asObject(readJsonSync(GALLERIES_FILE, SEED_GALLERIES), {});
  },

  /** @param {string} id */
  async getGallery(id) {
    const galleries = await this.getGalleries();
    return galleries[id] || null;
  },

  /** @param {object} galleries */
  async saveGalleries(galleries) {
    if (!galleries || typeof galleries !== 'object') throw new Error('Data galeri tidak valid');

    if (redis.isConfigured()) {
      await redis.setJson(GALLERIES_KEY, galleries);
      return galleries;
    }

    await enqueueGalleries(() => writeJsonSync(GALLERIES_FILE, galleries));
    return galleries;
  },
};

module.exports = {
  store,
  EMPTY_CONTENT,
  DATA_DIR,
  CONTENT_FILE,
  GALLERIES_FILE,
  CONTENT_KEY,
  GALLERIES_KEY,
  deepClone,
};
