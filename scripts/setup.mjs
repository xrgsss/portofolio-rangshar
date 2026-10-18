/**
 * scripts/setup.mjs
 * ---------------------------------------------------------------------------
 * Menyiapkan / mengatur ulang kredensial admin.
 *
 *   npm run setup                  -> buat .env bila belum ada, lalu tampilkan kredensial
 *   npm run setup -- --reset       -> buat password admin baru (acak) dan ganti di .env
 *   npm run setup -- --password "PasswordSaya123"
 *
 * Script ini hanya mengubah baris terkait di .env; komentar dan nilai lain
 * (seperti PORT) tidak diusik.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const ROUNDS = 12;

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = (length = 16) => {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
};

const setEnvValue = (key, value) => {
  let source = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  source = pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, source, { mode: 0o600 });
};

const readEnvValue = (key) => {
  if (!fs.existsSync(ENV_FILE)) return '';
  const match = fs.readFileSync(ENV_FILE, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
};

const main = () => {
  const args = process.argv.slice(2);
  const passwordFlagIndex = args.indexOf('--password');
  const providedPassword = passwordFlagIndex !== -1 ? args[passwordFlagIndex + 1] : '';
  const reset = args.includes('--reset');

  const isFirstRun = !fs.existsSync(ENV_FILE);
  let password = '';
  let shouldPrint = false;

  if (providedPassword) {
    if (providedPassword.length < 10 || !/[A-Za-z]/.test(providedPassword) || !/[0-9]/.test(providedPassword)) {
      console.error('✖  Password minimal 10 karakter dan harus berisi huruf serta angka.');
      process.exit(1);
    }
    password = providedPassword;
    shouldPrint = true;
  } else if (isFirstRun || reset) {
    password = randomPassword();
    shouldPrint = true;
  }

  if (isFirstRun) {
    fs.writeFileSync(ENV_FILE, '', { mode: 0o600 });
    console.log('ℹ  Membuat file .env baru.');
  }

  if (!readEnvValue('SESSION_SECRET') || readEnvValue('SESSION_SECRET').length < 32) {
    setEnvValue('SESSION_SECRET', crypto.randomBytes(48).toString('hex'));
    console.log('✔  SESSION_SECRET dibuat.');
  }

  setEnvValue('PORT', readEnvValue('PORT') || '3000');
  setEnvValue('ADMIN_USER', readEnvValue('ADMIN_USER') || 'admin');
  setEnvValue('ADMIN_DISPLAY_NAME', readEnvValue('ADMIN_DISPLAY_NAME') || 'Administrator');
  setEnvValue('SECURE_COOKIE', readEnvValue('SECURE_COOKIE') || 'false');

  if (shouldPrint) {
    setEnvValue('ADMIN_PASSWORD_HASH', bcrypt.hashSync(password, ROUNDS));
    console.log('\n' + '─'.repeat(56));
    console.log('  KREDENSIAL ADMIN');
    console.log('─'.repeat(56));
    console.log(`  Username : ${readEnvValue('ADMIN_USER')}`);
    console.log(`  Password : ${password}`);
    console.log('─'.repeat(56));
    console.log('  Simpan password ini. Password tidak bisa dilihat lagi,');
    console.log('  tetapi bisa diganti kapan saja dari dashboard admin.');
    console.log('─'.repeat(56) + '\n');
  } else if (readEnvValue('ADMIN_PASSWORD_HASH').startsWith('$2')) {
    console.log('✔  .env sudah berisi kredensial admin. Tidak ada yang diubah.');
    console.log('   Jalankan `npm run setup -- --reset` bila ingin password baru.');
  } else {
    setEnvValue('ADMIN_PASSWORD_HASH', bcrypt.hashSync(randomPassword(), ROUNDS));
    console.log('⚠  Hash password tidak valid, sudah dibuat ulang. Jalankan `npm run setup -- --reset` untuk melihat password baru.');
  }
};

main();
