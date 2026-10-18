/**
 * lib/config.js
 * ---------------------------------------------------------------------------
 * Memuat konfigurasi dari environment variable (dan dari file `.env` saat
 * dijalankan di laptop).
 *
 * PENTING: modul ini TIDAK menulis apa pun saat berjalan di Vercel, karena
 * filesystem-nya read-only. Nilai yang tidak ada hanya dilaporkan lewat
 * `notices` supaya jelas apa yang harus diisi di dashboard Vercel.
 *
 * Saat dijalankan lokal, `npm run setup` (scripts/setup.mjs) yang membuat
 * file `.env` beserta password admin acak.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { ROOT, ENV_FILE, loadEnvFiles } = require('./env');

const BCRYPT_ROUNDS = 12;

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** true saat berjalan di Vercel (filesystem read-only). */
const isServerless = () => Boolean(process.env.VERCEL);

const randomPassword = (length = 16) => {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
};

const randomSecret = () => crypto.randomBytes(48).toString('hex');

const isValidHash = (value) => typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);

/** true kalau file .env bisa ditulis (tidak jalan di Vercel & disk bisa ditulis). */
const canWriteEnv = () => {
  if (isServerless()) return false;
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Tulis/ubah satu nilai di dalam file .env tanpa menghapus komentar.
 * Hanya dipakai saat pengembangan lokal; di Vercel selalu dilewati.
 *
 * @returns {boolean} true kalau berhasil ditulis.
 */
const setEnvValue = (key, value) => {
  if (!canWriteEnv()) return false;

  try {
    let source = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');

    if (pattern.test(source)) {
      source = source.replace(pattern, line);
    } else {
      source = `${source.replace(/\s*$/, '')}\n${line}\n`;
    }

    fs.writeFileSync(ENV_FILE, source, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error(`⚠  Gagal menulis ${path.basename(ENV_FILE)}: ${error.message}`);
    return false;
  }
};

/** Buat nilai acak baru untuk satu variable lalu simpan ke .env (lokal saja). */
const persistRandomValue = (key, generate) => setEnvValue(key, generate());

/**
 * @returns {{ port:number, sessionSecret:string, adminUser:string, adminHash:string,
 *             adminDisplayName:string, secureCookie:boolean, generated?: {user:string,password:string},
 *             notices:string[], serverless:boolean, envFile:string, root:string }}
 */
const loadConfig = () => {
  const notices = [];
  let generated = null;

  // Environment variable asli (mis. dari dashboard hosting) selalu menang.
  // Urutannya: .env.local (hasil `vercel env pull`) di atas .env.
  const envExists = fs.existsSync(ENV_FILE);
  const stripped = loadEnvFiles();

  if (stripped.length > 0) {
    notices.push(
      `${stripped.join(', ')} di .env.local cuma placeholder "[SENSITIVE]" dari ` +
        'Vercel, jadi diabaikan. Isi nilainya manual di .env kalau perlu dijalankan lokal.'
    );
  }

  // --- SESSION_SECRET -----------------------------------------------------
  let sessionSecret = (process.env.SESSION_SECRET || '').trim();
  if (!sessionSecret || sessionSecret.length < 32 || /ganti-dengan/i.test(sessionSecret)) {
    sessionSecret = randomSecret();
    if (canWriteEnv()) {
      persistRandomValue('SESSION_SECRET', () => sessionSecret);
      notices.push('SESSION_SECRET belum diisi, sudah dibuatkan nilai acak baru di .env.');
    } else {
      // Di Vercel nilai acak ini hanya berlaku per-instance: semua sesi login
      // akan gugur setiap kali function di-restart. Wajib diisi manual.
      notices.push(
        'SESSION_SECRET belum diisi. Isi environment variable SESSION_SECRET (minimal 32 karakter) di dashboard Vercel.'
      );
    }
  }

  // --- ADMIN_USER ---------------------------------------------------------
  let adminUser = (process.env.ADMIN_USER || '').trim();
  if (!adminUser) {
    adminUser = 'admin';
    if (canWriteEnv()) setEnvValue('ADMIN_USER', adminUser);
  }

  // --- ADMIN_PASSWORD_HASH ------------------------------------------------
  let adminHash = (process.env.ADMIN_PASSWORD_HASH || '').trim();

  if (!isValidHash(adminHash)) {
    if (canWriteEnv()) {
      // Pengembangan lokal: buat password acak + simpan hash-nya ke .env,
      // lalu cetak password-nya sekali di terminal (perilaku lama).
      const password = randomPassword();
      adminHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
      setEnvValue('ADMIN_PASSWORD_HASH', adminHash);
      notices.push('Password admin belum diatur (atau hash-nya tidak valid), jadi password baru dibuat.');
      generated = { user: adminUser, password };
    } else {
      adminHash = '';
      notices.push(
        'ADMIN_PASSWORD_HASH belum diisi. Login admin tidak akan berhasil sampai variable itu diisi di dashboard Vercel.\n' +
          '     Buat hash-nya dengan: npm run hash'
      );
    }
  }

  return {
    root: ROOT,
    envFile: ENV_FILE,
    port: Number(process.env.PORT) || 3000,
    sessionSecret,
    adminUser,
    adminHash,
    adminDisplayName: (process.env.ADMIN_DISPLAY_NAME || 'Administrator').trim(),
    secureCookie:
      String(process.env.SECURE_COOKIE || '').toLowerCase() === 'true' || isServerless(),
    notices,
    generated,
    serverless: isServerless(),
    envFileExists: envExists,
  };
};

module.exports = {
  loadConfig,
  setEnvValue,
  canWriteEnv,
  isServerless,
  randomPassword,
  randomSecret,
  isValidHash,
  BCRYPT_ROUNDS,
  ENV_FILE,
  ROOT,
};
