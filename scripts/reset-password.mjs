/**
 * scripts/reset-password.mjs
 * ---------------------------------------------------------------------------
 * Mengurus password admin di Redis PRODUKSI dari laptop.
 *
 * Kenapa perlu? lib/auth.js mendahulukan hash di Redis (`portfolio:admin:hash`)
 * daripada environment variable ADMIN_PASSWORD_HASH di Vercel. Jadi kalau
 * password pernah diganti dari dashboard LIVE, nilai di Redis itulah yang
 * berlaku — dan environment variable di Vercel tidak berpengaruh apa-apa.
 *
 * Laptop biasanya tidak punya kredensial Redis (di .env hanya ada kredensial
 * Blob), jadi alamat Redis diberikan lewat argumen.
 *
 * Pemakaian:
 *   npm run reset:password -- --url "rediss://..." --dry
 *       Periksa saja: apakah hash admin ada di Redis, dan data website utuh?
 *       (TIDAK mengubah apa pun. Jalankan ini dulu.)
 *
 *   npm run reset:password -- --url "rediss://..." --clear
 *       Hapus hash di Redis, sehingga ADMIN_PASSWORD_HASH dari environment
 *       Vercel kembali yang berlaku. Lalu login dengan password itu.
 *
 *   npm run reset:password -- --url "rediss://..." --set "PasswordBaru123"
 *       Tulis hash baru ke Redis. Password itu langsung berlaku (tanpa
 *       redeploy), dan menang atas environment variable.
 *
 * Kredensial lain juga bisa:
 *   --rest-url "https://xxx.upstash.io" --rest-token "AXxx..."
 *
 * Kalau Redis sudah diatur di .env / .env.local, argumen alamat boleh
 * dilewatkan sama sekali.
 *
 * Aman dipakai: skrip ini HANYA menyentuh key `portfolio:admin:hash`.
 * Data website (portfolio:content, portfolio:galleries) tidak diubah.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const { loadEnvFiles } = await import('../lib/env.js');
loadEnvFiles();

/* ----------------------------------------------------------------- argumen */

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : '';
};

const url = valueOf('url');
const restUrl = valueOf('rest-url');
const restToken = valueOf('rest-token');
const newPassword = valueOf('set');
const clearMode = hasFlag('clear');
const dryMode = hasFlag('dry') || (!clearMode && !newPassword);

if (hasFlag('help') || args.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exit(0);
}

// Alamat dari argumen dipasang sebelum lib/redis membaca konfigurasi.
if (url) process.env.REDIS_URL = url;
if (restUrl) process.env.KV_REST_API_URL = restUrl;
if (restToken) process.env.KV_REST_API_TOKEN = restToken;

const { isConfigured, transportName, getJson, setJson, deleteKey } = await import('../lib/redis.js');
const { isValidHash, BCRYPT_ROUNDS } = await import('../lib/config.js');
const bcryptModule = await import('bcryptjs');
const bcrypt = bcryptModule.default || bcryptModule;

const HASH_KEY = 'portfolio:admin:hash';

/** Key lain yang wajib ada, hanya untuk memastikan datanya tidak tersentuh. */
const DATA_KEYS = ['portfolio:content', 'portfolio:galleries', 'portfolio:analytics:views'];

const fingerprint = (value) =>
  typeof value === 'string' && value.length >= 13 ? `$2a$12$…salt=${value.slice(7, 13)}… (${value.length} karakter)` : '(bukan hash yang sah)';

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} tidak menjawab dalam ${ms / 1000} detik`)), ms)),
  ]);

/* ---------------------------------------------------------------- memulai */

if (!isConfigured()) {
  console.log('✖  Kredensial Redis tidak ditemukan.');
  console.log('');
  console.log('   Laptop ini memang tidak menyimpan kredensial Redis. Ambil alamatnya dari');
  console.log('   dashboard penyedia Redis-nya (Vercel -> Storage -> store Redis -> tab');
  console.log('   Connect / .env), lalu jalankan:');
  console.log('');
  console.log('     npm run reset:password -- --url "rediss://default:xxxx@host:6379" --dry');
  console.log('');
  console.log('   Kalau yang tersedia bentuk REST:');
  console.log('');
  console.log('     npm run reset:password -- --rest-url "https://xxx.upstash.io" --rest-token "AXxx..." --dry');
  process.exit(1);
}

console.log(`\nTransport Redis : ${transportName()}`);
console.log(`Mode            : ${dryMode ? 'PERIKSA SAJA (tidak mengubah apa pun)' : clearMode ? 'HAPUS hash admin' : 'TULIS hash baru'}`);
console.log('─'.repeat(74));

const report = async () => {
  // 1. Data website: hanya cek ada/tidak, isinya tidak dibaca.
  console.log('\nData website (tidak akan diubah):');
  for (const key of DATA_KEYS) {
    try {
      const value = await withTimeout(getJson(key), 15000, `Pembacaan ${key}`);
      const info = value === null ? '— belum ada' : `ada (${Array.isArray(value) ? `${value.length} entri` : typeof value})`;
      console.log(`  ${key.padEnd(32)} ${info}`);
    } catch (error) {
      console.log(`  ${key.padEnd(32)} ⚠ ${error.message}`);
    }
  }

  // 2. Hash admin.
  console.log('\nHash admin:');
  const stored = await withTimeout(getJson(HASH_KEY), 15000, `Pembacaan ${HASH_KEY}`);
  if (stored === null) {
    console.log(`  ${HASH_KEY}`);
    console.log('  └ tidak ada → produksi memakai ADMIN_PASSWORD_HASH dari environment Vercel.');
    console.log('    (Kalau login masih gagal, perbarui variable itu di Vercel lalu redeploy.)');
  } else if (isValidHash(stored)) {
    console.log(`  ${HASH_KEY}`);
    console.log(`  └ ADA dan sah: ${fingerprint(stored)}`);
    console.log('    Inilah password yang berlaku di produksi, menang atas environment Vercel.');
    console.log('    Kalau passwordnya tidak diingat: jalankan --clear, atau --set "PasswordBaru".');
  } else {
    console.log(`  ${HASH_KEY}`);
    console.log(`  └ ada tapi tidak berbentuk hash yang sah: ${fingerprint(stored)}`);
    console.log('    Aman untuk dihapus dengan --clear.');
  }
  return stored;
};

const main = async () => {
  await report();

  if (dryMode) {
    console.log('\nSelesai (mode --dry: tidak ada yang diubah).\n');
    return;
  }

  if (clearMode) {
    await withTimeout(deleteKey(HASH_KEY), 15000, `Penghapusan ${HASH_KEY}`);
    console.log(`\n✔  ${HASH_KEY} dihapus.`);
    console.log('   Produksi sekarang memakai ADMIN_PASSWORD_HASH dari environment Vercel.');
    console.log('   Pastikan variable itu sudah benar, lalu login (tanpa perlu redeploy).');
  }

  if (newPassword) {
    if (String(newPassword).length < 8) {
      console.log('\n✖  Password minimal 8 karakter.');
      process.exit(1);
    }
    const hash = bcrypt.hashSync(String(newPassword), BCRYPT_ROUNDS);
    await withTimeout(setJson(HASH_KEY, hash), 15000, `Penulisan ${HASH_KEY}`);
    console.log(`\n✔  Password produksi diganti (${fingerprint(hash)}).`);
    console.log('   Langsung berlaku di rangshar.my.id — tidak perlu redeploy.');
    console.log('   Kalau nanti diganti lagi dari dashboard, isi Redis ini yang diperbarui.');
  }

  console.log('');
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`\n✖  Gagal: ${error.message}`);
  console.error('   Periksa alamat Redis-nya (contoh: rediss://default:xxxx@host:6379).');
  process.exit(1);
}
