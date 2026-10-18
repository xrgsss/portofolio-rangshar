/**
 * scripts/migrate-media.mjs
 * ---------------------------------------------------------------------------
 * Memindahkan semua isi folder `images/` ke Vercel Blob, lalu memperbarui
 * alamat media di data/content.json & data/galleries.json supaya menunjuk ke
 * alamat Blob yang baru.
 *
 *   npm run migrate:media            -> unggah yang belum ada + update data JSON
 *   npm run migrate:media -- --dry   -> hanya melihat apa yang akan dilakukan
 *
 * Script ini AMAN dijalankan berulang kali: berkas yang sudah ada di Blob
 * dilewati (tidak diunggah ulang).
 *
 * Sebelum menjalankan:
 *   1. Buat Blob store di Vercel dengan akses PUBLIC, hubungkan ke project.
 *   2. Jalankan `npx vercel env pull` (menulis .env.local).
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { head, put } from '@vercel/blob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = path.join(ROOT, 'images');
const DATA_FILES = [path.join(ROOT, 'data', 'content.json'), path.join(ROOT, 'data', 'galleries.json')];

// Muat .env.local + .env lebih dulu. Sekaligus membuang nilai "[SENSITIVE]"
// yang ditulis `vercel env pull` untuk variabel bertipe Secret.
const { loadEnvFiles, PLACEHOLDER_VALUE } = (await import('../lib/env.js')).default;
loadEnvFiles();

/** Nilai environment yang benar-benar terisi (bukan placeholder). */
const envValue = (name) => {
  const value = String(process.env[name] || '').trim();
  return value && !PLACEHOLDER_VALUE.test(value) ? value : '';
};

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogg': 'video/ogg',
};

const ALLOWED = new Set(Object.keys(MIME_BY_EXTENSION));

const dryRun = process.argv.includes('--dry');

const formatSize = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const walk = (dir) => {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (ALLOWED.has(path.extname(entry.name).toLowerCase())) results.push(full);
  }
  return results;
};

/** images/uploads/x.png -> uploads/x.png (sisanya tetap images/...) */
const pathnameFor = (relative) =>
  relative.startsWith('images/uploads/') ? relative.replace(/^images\//, '') : relative;

/** Ganti semua string di dalam JSON yang isinya alamat media lokal. */
const rewriteUrls = (value, map) => {
  let replaced = 0;

  const walkValue = (node) => {
    if (typeof node === 'string') {
      const candidates = [node, encodeURI(node), node.replace(/^\/+/, '')];
      for (const candidate of candidates) {
        const url = map.get(candidate);
        if (url) {
          replaced += 1;
          return url;
        }
      }
      return node;
    }

    if (Array.isArray(node)) return node.map(walkValue);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(node)) out[key] = walkValue(item);
      return out;
    }

    return node;
  };

  const result = walkValue(value);
  return { result, replaced };
};

const main = async () => {
  if (!envValue('BLOB_READ_WRITE_TOKEN') && !envValue('BLOB_STORE_ID')) {
    console.error('✖  Kredensial Blob belum ada.');
    console.error('   Buat Blob store (akses PUBLIC) di dashboard Vercel, hubungkan ke project,');
    console.error('   lalu jalankan:  npx vercel env pull');
    process.exit(1);
  }

  if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`✖  Folder ${IMAGES_DIR} tidak ditemukan.`);
    process.exit(1);
  }

  const files = walk(IMAGES_DIR);
  const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  Migrasi media ke Vercel Blob${dryRun ? ' (DRY RUN — tidak ada yang diunggah)' : ''}`);
  console.log('─'.repeat(64));
  console.log(`  Berkas   : ${files.length}`);
  console.log(`  Ukuran   : ${formatSize(totalBytes)}`);
  console.log('─'.repeat(64));

  const map = new Map();
  let uploaded = 0;
  let skipped = 0;
  let index = 0;

  for (const file of files) {
    index += 1;
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const pathname = pathnameFor(relative);
    const size = fs.statSync(file).size;

    let url = null;

    try {
      const existing = await head(pathname);
      url = existing.url;
      skipped += 1;
      console.log(`  [${index}/${files.length}] lewat  (sudah ada)  ${relative}`);
    } catch {
      if (dryRun) {
        url = `https://<blob-store>/${encodeURI(pathname)}`;
        uploaded += 1;
        console.log(`  [${index}/${files.length}] unggah ${formatSize(size).padStart(9)}  ${relative}`);
      } else {
        try {
          const blob = await put(pathname, fs.readFileSync(file), {
            access: 'public',
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: MIME_BY_EXTENSION[path.extname(file).toLowerCase()],
          });
          url = blob.url;
          uploaded += 1;
          console.log(`  [${index}/${files.length}] unggah ${formatSize(size).padStart(9)}  ${relative}`);
        } catch (error) {
          console.error(`  [${index}/${files.length}] GAGAL   ${relative}`);
          console.error(`         ${error.message}`);
          process.exitCode = 1;
          continue;
        }
      }
    }

    map.set(relative, url);
    map.set(encodeURI(relative).replace(/#/g, '%23'), url);
  }

  console.log('─'.repeat(64));
  console.log(`  Diunggah : ${uploaded}`);
  console.log(`  Dilewati : ${skipped}`);
  console.log('─'.repeat(64));

  if (dryRun) {
    console.log('\n  Ini hanya simulasi. Jalankan tanpa --dry untuk mengunggah.\n');
    return;
  }

  let totalReplaced = 0;
  for (const file of DATA_FILES) {
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { result, replaced } = rewriteUrls(original, map);

    if (replaced > 0) {
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }

    totalReplaced += replaced;
    console.log(`  ${path.relative(ROOT, file).padEnd(28)} ${replaced} alamat diperbarui`);
  }

  console.log('─'.repeat(64));
  console.log(`  Total alamat media yang diganti: ${totalReplaced}`);
  console.log('─'.repeat(64));

  console.log('\n  Langkah berikutnya:');
  console.log('    1. npm run migrate:kv     (kirim data baru ke Redis)');
  console.log('    2. periksa data/content.json & data/galleries.json');
  console.log('    3. git rm -r --cached images   (berhenti melacak folder images/)');
  console.log('    4. commit + push\n');
};

main().catch((error) => {
  console.error(`\n✖  Migrasi gagal: ${error.message}\n`);
  process.exit(1);
});
