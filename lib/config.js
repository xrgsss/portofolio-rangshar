/**
 * lib/config.js
 * ---------------------------------------------------------------------------
 * Memuat konfigurasi dari `.env`. Kalau `.env` belum ada, file tersebut
 * dibuat otomatis lengkap dengan password admin acak yang kuat, lalu password
 * itu dicetak satu kali ke console.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const BCRYPT_ROUNDS = 12;

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

/** Tulis/ubah satu nilai di dalam file .env tanpa menghapus komentar. */
const setEnvValue = (key, value) => {
  let source = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  if (pattern.test(source)) {
    source = source.replace(pattern, line);
  } else {
    source = `${source.replace(/\s*$/, '')}\n${line}\n`;
  }

  fs.writeFileSync(ENV_FILE, source, { mode: 0o600 });
};

const buildEnvTemplate = ({ secret, user, hash }) =>
  [
    '# ---------------------------------------------------------------------------',
    '# File ini dibuat otomatis. JANGAN dibagikan / di-commit ke Git.',
    '# Ganti password admin lewat dashboard admin (/admin) atau `npm run setup`.',
    '# ---------------------------------------------------------------------------',
    '',
    '# Port server',
    'PORT=3000',
    '',
    '# Kunci untuk menandatangani cookie session',
    `SESSION_SECRET=${secret}`,
    '',
    '# Kredensial admin',
    `ADMIN_USER=${user}`,
    `ADMIN_PASSWORD_HASH=${hash}`,
    `ADMIN_DISPLAY_NAME=Administrator`,
    '',
    '# Set true bila sudah memakai HTTPS',
    'SECURE_COOKIE=false',
    '',
  ].join('\n');

/**
 * @returns {{ port:number, sessionSecret:string, adminUser:string, adminHash:string,
 *             adminDisplayName:string, secureCookie:boolean, generated?: {user:string,password:string} }}
 */
const loadConfig = () => {
  const notices = [];
  let generated = null;
  let envSource = '';

  if (fs.existsSync(ENV_FILE)) {
    envSource = fs.readFileSync(ENV_FILE, 'utf8');
  } else {
    const password = randomPassword();
    const user = 'admin';
    fs.writeFileSync(
      ENV_FILE,
      buildEnvTemplate({ secret: randomSecret(), user, hash: bcrypt.hashSync(password, BCRYPT_ROUNDS) }),
      { mode: 0o600 }
    );
    notices.push(`File .env belum ada, jadi saya buatkan otomatis di:\n     ${ENV_FILE}`);
    generated = { user, password };
    envSource = fs.readFileSync(ENV_FILE, 'utf8');
  }

  // Variabel environment asli (mis. dari hosting) menang atas isi .env,
  // sehingga PORT yang diatur hosting tidak tertimpa.
  dotenv.config({ path: ENV_FILE, override: false });

  // --- SESSION_SECRET -----------------------------------------------------
  let sessionSecret = (process.env.SESSION_SECRET || '').trim();
  if (!sessionSecret || sessionSecret.length < 32 || /ganti-dengan/i.test(sessionSecret)) {
    sessionSecret = randomSecret();
    setEnvValue('SESSION_SECRET', sessionSecret);
    notices.push('SESSION_SECRET belum diisi, sudah dibuatkan nilai acak baru.');
  }

  // --- ADMIN_USER ---------------------------------------------------------
  let adminUser = (process.env.ADMIN_USER || '').trim();
  if (!adminUser) {
    adminUser = 'admin';
    setEnvValue('ADMIN_USER', adminUser);
  }

  // --- ADMIN_PASSWORD_HASH ------------------------------------------------
  let adminHash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (!isValidHash(adminHash)) {
    const password = randomPassword();
    adminHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    setEnvValue('ADMIN_PASSWORD_HASH', adminHash);
    notices.push('Password admin belum diatur (atau hash-nya tidak valid), jadi password baru dibuat.');
    generated = { user: adminUser, password };
  }

  return {
    root: ROOT,
    envFile: ENV_FILE,
    port: Number(process.env.PORT) || 3000,
    sessionSecret,
    adminUser,
    adminHash,
    adminDisplayName: (process.env.ADMIN_DISPLAY_NAME || 'Administrator').trim(),
    secureCookie: String(process.env.SECURE_COOKIE || '').toLowerCase() === 'true',
    notices,
    generated,
  };
};

module.exports = { loadConfig, setEnvValue, randomPassword, isValidHash, BCRYPT_ROUNDS, ENV_FILE, ROOT };
