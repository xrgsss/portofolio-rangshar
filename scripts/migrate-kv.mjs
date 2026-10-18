/**
 * scripts/migrate-kv.mjs
 * ---------------------------------------------------------------------------
 * Mengirim isi data/content.json & data/galleries.json ke Redis.
 *
 *   npm run migrate:kv
 *
 * Ini yang membuat website versi Vercel punya isi: function di Vercel hanya
 * bisa membaca, jadi data harus berada di Redis. Aman dijalankan berulang
 * kali — nilai yang ada akan ditimpa dengan isi file lokal.
 *
 * Kredensial Redis didukung dalam dua bentuk (lihat lib/redis.js):
 *   - KV_REST_API_URL + KV_REST_API_TOKEN   (atau UPSTASH_REDIS_REST_*)
 *   - REDIS_URL                              (bentuk dari integrasi Vercel)
 *
 * Sebelum menjalankan: hubungkan Redis store ke project di Vercel — termasuk
 * environment Development — lalu `npx vercel env pull` agar kredensialnya ada
 * di .env.local.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Muat .env.local + .env lebih dulu (sekaligus membuang placeholder
// "[SENSITIVE]" dari `vercel env pull`), baru impor modul yang membacanya.
const { loadEnvFiles } = (await import('../lib/env.js')).default;
loadEnvFiles();

// Diimpor SETELAH env dimuat, supaya kredensialnya sudah terbaca.
const redis = (await import('../lib/redis.js')).default;

const readJson = (file) => {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} tidak ditemukan`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

/**
 * Hitung alamat media yang masih menunjuk ke folder lokal.
 * Alamat Blob juga mengandung "/images/", jadi patokannya adalah path relatif
 * (tanpa skema http/https).
 */
const countLocalImagePaths = (value) => {
  let total = 0;
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(node) && /(^|\/)images\//.test(node)) total += 1;
      return;
    }
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  return total;
};

const main = async () => {
  if (!redis.isConfigured()) {
    console.error('✖  Kredensial Redis belum ada.');
    console.error('');
    console.error('   Butuh salah satu dari:');
    console.error('     • KV_REST_API_URL + KV_REST_API_TOKEN');
    console.error('     • UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN');
    console.error('     • REDIS_URL');
    console.error('');
    console.error('   Hubungkan Redis store ke project di Vercel (centang juga');
    console.error('   environment Development), lalu jalankan:  npx vercel env pull');
    process.exit(1);
  }

  const content = readJson(path.join(ROOT, 'data', 'content.json'));
  const galleries = readJson(path.join(ROOT, 'data', 'galleries.json'));

  const localPaths = countLocalImagePaths(content) + countLocalImagePaths(galleries);
  if (localPaths > 0) {
    console.warn(`⚠  Masih ada ${localPaths} alamat media berawalan "images/" di data.`);
    console.warn('   Jalankan `npm run migrate:media` lebih dulu supaya gambar tampil di Vercel.\n');
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Mengirim data ke Redis (${redis.transportName()})`);
  console.log('─'.repeat(64));

  await redis.setJson('portfolio:content', content);
  console.log(`  ✔  portfolio:content    (${content.portfolio?.items?.length ?? 0} item portfolio)`);

  await redis.setJson('portfolio:galleries', galleries);
  console.log(`  ✔  portfolio:galleries  (${Object.keys(galleries).length} halaman galeri)`);

  console.log('─'.repeat(64));
  console.log('\n  Selesai. Buka website di Vercel untuk memastikan isinya sudah muncul.\n');
};

main().catch((error) => {
  console.error(`\n✖  Gagal mengirim data: ${error.message}\n`);
  process.exit(1);
});
