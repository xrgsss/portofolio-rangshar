/**
 * lib/env.js
 * ---------------------------------------------------------------------------
 * Satu-satunya tempat yang membaca file `.env.local` dan `.env`.
 *
 * Urutan prioritas: environment variable asli (shell / dashboard hosting) >
 * .env.local (hasil `vercel env pull`) > .env.
 *
 * Dua jebakan dari `vercel env pull` ditangani di sini:
 *
 *   1. Variabel bertipe Secret tidak bisa dibaca ulang, jadi CLI menulis
 *      "[SENSITIVE]" sebagai gantinya. Nilai itu BUKAN kredensial dan harus
 *      diabaikan, supaya tidak menutupi nilai asli yang ada di .env.
 *
 *   2. CLI juga ikut menulis variabel milik platform (VERCEL, VERCEL_ENV,
 *      VERCEL_GIT_*, TURBO_*, NX_*). Itu mendeskripsikan DEPLOYMENT, bukan
 *      konfigurasi aplikasi. Kalau dibaca di laptop, aplikasi akan mengira
 *      dirinya berjalan di Vercel — akibatnya cookie login ditandai `Secure`
 *      dan login lewat http://localhost selalu gagal. Karena itu variabel
 *      tersebut tidak dimuat, kecuali VERCEL_OIDC_TOKEN yang memang
 *      kredensial untuk mengakses Blob dari lokal.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_ENV_FILE = path.join(ROOT, '.env.local');
const ENV_FILE = path.join(ROOT, '.env');

/** Nilai pengganti yang ditulis `vercel env pull` untuk variabel Secret. */
const PLACEHOLDER_VALUE = /^\[(SENSITIVE|ENCRYPTED)\]$/i;

/**
 * Apakah variabel ini milik platform (bukan konfigurasi aplikasi)?
 * VERCEL_OIDC_TOKEN dikecualikan karena dipakai untuk autentikasi Blob lokal.
 */
const isPlatformVariable = (key) =>
  /^(TURBO_|NX_)/.test(key) || (key.startsWith('VERCEL') && key !== 'VERCEL_OIDC_TOKEN');

/**
 * Muat satu berkas env. Nilai yang sudah ada di environment tidak ditimpa,
 * dan placeholder tidak pernah dipakai.
 *
 * @param {string} file
 * @param {Set<string>} placeholders penampung nama variabel yang cuma placeholder
 */
const applyEnvFile = (file, placeholders) => {
  if (!fs.existsSync(file)) return;

  let parsed;
  try {
    parsed = dotenv.parse(fs.readFileSync(file));
  } catch (error) {
    console.error(`⚠  Gagal membaca ${path.basename(file)}: ${error.message}`);
    return;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (isPlatformVariable(key)) continue;

    if (PLACEHOLDER_VALUE.test(String(value).trim())) {
      placeholders.add(key);
      continue;
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
};

/**
 * Muat `.env.local` lalu `.env`.
 * @returns {string[]} nama variabel yang dilewati karena cuma placeholder.
 */
const loadEnvFiles = () => {
  const placeholders = new Set();

  applyEnvFile(LOCAL_ENV_FILE, placeholders);
  applyEnvFile(ENV_FILE, placeholders);

  // Hanya laporkan yang benar-benar kosong setelah semua sumber dibaca.
  return [...placeholders].filter((key) => process.env[key] === undefined);
};

/** Apakah `.env` bisa ditulis (tidak jalan di Vercel & disk bisa ditulis). */
const canWriteEnvFile = () => {
  if (process.env.VERCEL) return false;
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  ROOT,
  LOCAL_ENV_FILE,
  ENV_FILE,
  PLACEHOLDER_VALUE,
  loadEnvFiles,
  canWriteEnvFile,
};
