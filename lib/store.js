/**
 * lib/store.js
 * ---------------------------------------------------------------------------
 * Penyimpanan data website di file JSON (data/content.json & data/galleries.json).
 *
 * - Data dibaca sekali lalu disimpan di memori (cache) agar cepat.
 * - Setiap penulisan memakai pola "tulis ke file sementara lalu rename"
 *   supaya file tidak pernah setengah tertulis / rusak.
 * - Penulisan diserialisasi lewat antrean supaya tidak saling menimpa.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const GALLERIES_FILE = path.join(DATA_DIR, 'galleries.json');

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

const store = {
  DATA_DIR,
  CONTENT_FILE,
  GALLERIES_FILE,

  /** Konten halaman utama (salinan, aman untuk diubah pemanggil). */
  getContent() {
    return readJsonSync(CONTENT_FILE, EMPTY_CONTENT);
  },

  /** @param {object} content */
  setContent(content) {
    if (!content || typeof content !== 'object') throw new Error('Konten tidak valid');
    writeJsonSync(CONTENT_FILE, content);
    return this.getContent();
  },

  /** Menulis konten secara asinkron (dipakai dari route Express). */
  saveContent(content) {
    return enqueueContent(() => this.setContent(content));
  },

  /** Semua halaman galeri portfolio. */
  getGalleries() {
    return readJsonSync(GALLERIES_FILE, {});
  },

  /** @param {string} id */
  getGallery(id) {
    const galleries = this.getGalleries();
    return galleries[id] || null;
  },

  /** @param {object} galleries */
  setGalleries(galleries) {
    if (!galleries || typeof galleries !== 'object') throw new Error('Data galeri tidak valid');
    writeJsonSync(GALLERIES_FILE, galleries);
    return this.getGalleries();
  },

  saveGalleries(galleries) {
    return enqueueGalleries(() => this.setGalleries(galleries));
  },
};

module.exports = { store, EMPTY_CONTENT, DATA_DIR, CONTENT_FILE, GALLERIES_FILE, deepClone };
