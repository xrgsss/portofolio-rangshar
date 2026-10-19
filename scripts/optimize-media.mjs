/**
 * scripts/optimize-media.mjs
 * ---------------------------------------------------------------------------
 * Mengecilkan video & gambar yang dipakai website, lalu mengunggah hasilnya
 * ke Vercel Blob dan memperbarui data/*.json dengan alamat baru.
 *
 * Kenapa perlu? Kuota Vercel Blob (Hobby) dihitung dari Data Transfer, dan
 * halaman galeri bisa sangat berat: satu halaman 3D Design menarik ~302 MB
 * sekali dibuka (227 MB di antaranya video). Mengompres berkasnya adalah
 * cara paling ampuh mengurangi pemakaian kuota.
 *
 * Pemakaian:
 *   npm run optimize:media -- --dry            laporan saja (tanpa ffmpeg)
 *   npm run optimize:media                     proses semua berkas
 *   npm run optimize:media -- --limit 1        uji coba 1 berkas dulu
 *   npm run optimize:media -- --only 3d        pilih berkas yang mengandung "3d"
 *   npm run optimize:media -- --video-only     hanya video
 *   npm run optimize:media -- --image-only     hanya gambar
 *   npm run optimize:media -- --crf 30         video lebih kecil (default 28)
 *   npm run optimize:media -- --keep-original  jangan sentuh berkas di bawah ambang
 *
 * Hasilnya:
 *   - Berkas baru diunggah ke  images/optimized/<path lama>  (berkas lama TIDAK dihapus)
 *   - data/content.json & data/galleries.json diperbarui ke alamat baru
 *   - Dua berkas cadangan ditulis ke data/:
 *       optimize-<waktu>-before.json  (isi sebelum diubah — untuk jaga-jaga)
 *       optimize-<waktu>-after.json   (isi sesudah — impor ini di dashboard live)
 *
 * Prasyarat: ffmpeg ada di PATH. Kalau belum:
 *   winget install Gyan.FFmpeg          (Windows)
 *   brew install ffmpeg                 (macOS)
 *   sudo apt install ffmpeg             (Linux)
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const { loadEnvFiles } = await import('../lib/env.js');
loadEnvFiles();

const { put, list } = await import('@vercel/blob');

const CONTENT_FILE = path.join(ROOT, 'data', 'content.json');
const GALLERIES_FILE = path.join(ROOT, 'data', 'galleries.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const OPTIMIZED_PREFIX = 'images/optimized/';

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const SKIP_EXT = new Set(['.gif', '.svg', '.avif', '.webp']);

/** Ambang ukuran: berkas di bawah ini tidak diproses (tidak sepadan usahanya). */
const MIN_VIDEO_BYTES = 1.5 * 1024 * 1024;
const MIN_IMAGE_BYTES = 250 * 1024;

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const DRY = hasFlag('dry');
const LIMIT = Number(valueOf('limit', '0')) || 0;
const ONLY = valueOf('only', '');
const CRF = valueOf('crf', '28');
const IMAGE_QUALITY = valueOf('image-quality', '80');
const MAX_VIDEO_WIDTH = valueOf('max-video-width', '1280');
const MAX_IMAGE_WIDTH = valueOf('max-image-width', '1920');
const VIDEO_ONLY = hasFlag('video-only');
const IMAGE_ONLY = hasFlag('image-only');

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/* ------------------------------------------------------------------ ffmpeg */

const ffmpegPath = (() => {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'ffmpeg' : '';
})();

if (!ffmpegPath && !DRY) {
  console.error('✖  ffmpeg tidak ditemukan di PATH.');
  console.error('   Pasang dulu, lalu jalankan ulang:');
  console.error('     Windows : winget install Gyan.FFmpeg');
  console.error('     macOS   : brew install ffmpeg');
  console.error('     Linux   : sudo apt install ffmpeg');
  console.error('   Untuk melihat rencana tanpa memproses: npm run optimize:media -- --dry');
  process.exit(1);
}

/* --------------------------------------------------------- data & bantuan */

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`⚠  Gagal membaca ${path.basename(file)}: ${error.message}`);
    return fallback;
  }
};

const content = readJson(CONTENT_FILE, {});
const galleries = readJson(GALLERIES_FILE, {});

const MEDIA_STRING = /\.(png|jpe?g|gif|svg|avif|webp|mp4|webm|mov|m4v|ogg)(\?|#|$)/i;

/** Kumpulkan semua string yang menunjuk berkas media dari sebuah objek JSON. */
const collectMedia = (value, found = new Set()) => {
  if (typeof value === 'string') {
    if (MEDIA_STRING.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectMedia(item, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectMedia(item, found));
  }
  return found;
};

/**
 * Ubah alamat media menjadi berkas lokal, kalau ada.
 *   https://<store>.public.blob.vercel-storage.com/images/a/b.mp4 -> images/a/b.mp4
 *   images/uploads/c.png                                          -> images/uploads/c.png
 */
const localPathFor = (reference) => {
  let relative = '';

  try {
    const url = new URL(reference);
    if (!/\.blob\.vercel-storage\.com$/i.test(url.hostname)) return '';
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    relative = decodeURI(reference).replace(/^\/+/, '');
  }

  if (!relative.startsWith('images/')) return '';
  const full = path.join(ROOT, relative);
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : '';
};

/** images/portofolio/3d/0213.mp4 -> images/optimized/portofolio/3d/0213.mp4 */
const optimizedPathname = (relativePath, newExt) => {
  const rest = relativePath.replace(/^images\//, '').replace(/\.[^.]+$/, '');
  return `${OPTIMIZED_PREFIX}${rest}${newExt}`;
};

/* ---------------------------------------------------------------- ffmpeg */

const runFfmpeg = (input, output, kind) => {
  const video = [
    '-y', '-i', input,
    '-vf', `scale='min(${MAX_VIDEO_WIDTH},iw)':-2`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '96k',
    output,
  ];

  const image = [
    '-y', '-i', input,
    '-vf', `scale='min(${MAX_IMAGE_WIDTH},iw)':-2`,
    '-c:v', 'libwebp',
    '-quality', IMAGE_QUALITY,
    '-compression_level', '6',
    output,
  ];

  const result = spawnSync(ffmpegPath, kind === 'video' ? video : image, { encoding: 'utf8' });

  if (result.status !== 0) {
    const tail = String(result.stderr || '').trim().split('\n').slice(-3).join('\n     ');
    throw new Error(`ffmpeg gagal.\n     ${tail}`);
  }
};

/* ------------------------------------------------------------------- jalan */

const plan = [];

for (const reference of collectMedia([content, galleries])) {
  const local = localPathFor(reference);
  if (!local) continue;

  const ext = path.extname(local).toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  const isImage = IMAGE_EXT.has(ext);
  if (!isVideo && !isImage) continue;
  if (SKIP_EXT.has(ext)) continue;
  if (VIDEO_ONLY && !isVideo) continue;
  if (IMAGE_ONLY && !isImage) continue;

  const size = fs.statSync(local).size;
  const threshold = isVideo ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
  if (size < threshold) continue;

  const relative = path.relative(ROOT, local).split(path.sep).join('/');
  if (ONLY && !relative.toLowerCase().includes(ONLY.toLowerCase())) continue;

  plan.push({ reference, local, relative, size, kind: isVideo ? 'video' : 'image', ext });
}

plan.sort((a, b) => b.size - a.size);

if (plan.length === 0) {
  console.log('ℹ  Tidak ada berkas media yang perlu dikecilkan (atau berkas lokalnya tidak ditemukan).');
  process.exit(0);
}

console.log(`\n${'─'.repeat(78)}`);
console.log(`  RENCANA OPTIMASI — ${plan.length} berkas, total ${mb(plan.reduce((s, p) => s + p.size, 0))}`);
console.log(`${'─'.repeat(78)}`);

for (const item of plan) {
  const action = item.kind === 'video' ? `video → mp4 (crf ${CRF}, maks ${MAX_VIDEO_WIDTH}px)` : `gambar → webp (kualitas ${IMAGE_QUALITY})`;
  console.log(`  ${mb(item.size).padStart(10)}  ${item.relative}`);
  console.log(`              ${action}`);
}

if (DRY) {
  if (!ffmpegPath) {
    console.log(`\nℹ  Mode --dry. ffmpeg belum dipasang, jadi hasil akhir belum bisa dihitung.`);
    console.log('   Pasang ffmpeg lalu jalankan tanpa --dry untuk memproses.');
  } else {
    console.log(`\nℹ  Mode --dry: tidak ada berkas yang diubah.`);
  }
  console.log(`   Perkiraan: video biasanya turun 70–90%, gambar PNG turun 80–95%.`);
  console.log(`   Total ${mb(plan.reduce((s, p) => s + p.size, 0))} berpotensi menjadi ~${mb(plan.reduce((s, p) => s + p.size, 0) * 0.15)}.\n`);
  process.exit(0);
}

/* --------------------------------------------------------- cadangan dulu */

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const beforeFile = path.join(ROOT, 'data', `optimize-${stamp}-before.json`);
const afterFile = path.join(ROOT, 'data', `optimize-${stamp}-after.json`);

const snapshot = (label) =>
  JSON.stringify({ exportedAt: new Date().toISOString(), version: 1, label, content, galleries }, null, 2);

fs.writeFileSync(beforeFile, snapshot('sebelum optimasi'), 'utf8');
console.log(`\n✔  Cadangan sebelum diubah: data/${path.basename(beforeFile)}`);

/* ------------------------------------------------------------ proses satu */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-media-'));

/** Ganti semua kemunculan alamat lama dengan alamat baru di seluruh JSON. */
const replaceEverywhere = (oldValue, newValue) => {
  const walk = (value) => {
    if (typeof value === 'string') return value === oldValue ? newValue : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = walk(value[key]);
    }
    return value;
  };
  walk(content);
  walk(galleries);
};

const results = [];
let processed = 0;
let failed = 0;

for (const item of plan) {
  if (LIMIT && processed >= LIMIT) {
    console.log(`\nℹ  Berhenti di batas --limit ${LIMIT}.`);
    break;
  }

  const newExt = item.kind === 'video' ? '.mp4' : '.webp';
  const output = path.join(tmpDir, `${path.basename(item.local).replace(/\.[^.]+$/, '')}${newExt}`);

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  ${item.relative}  (${mb(item.size)})`);

  try {
    runFfmpeg(item.local, output, item.kind);
  } catch (error) {
    failed += 1;
    console.log(`  ✖  Gagal dikompres: ${error.message}`);
    continue;
  }

  const newSize = fs.statSync(output).size;
  if (newSize >= item.size * 0.9) {
    console.log(`  ↷  Dilewati: hasilnya tidak lebih kecil (${mb(newSize)} vs ${mb(item.size)}).`);
    fs.unlinkSync(output);
    continue;
  }

  const pathname = optimizedPathname(item.relative, newExt);
  const contentType = item.kind === 'video' ? 'video/mp4' : 'image/webp';

  try {
    const uploaded = await put(pathname, fs.readFileSync(output), {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN || undefined,
    });

    replaceEverywhere(item.reference, uploaded.url);
    results.push({ relative: item.relative, before: item.size, after: newSize, url: uploaded.url });
    processed += 1;

    console.log(`  ✔  ${mb(item.size)} → ${mb(newSize)}  (hemat ${(100 - (newSize / item.size) * 100).toFixed(0)}%)`);
    console.log(`     ${uploaded.url}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✖  Gagal mengunggah: ${error.message}`);
    console.log('     Kalau pesannya soal store diblokir, tunggu kuota Vercel Blob pulih lalu jalankan lagi.');
  } finally {
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
}

/* --------------------------------------------------------------- simpan -- */

if (results.length > 0) {
  fs.writeFileSync(CONTENT_FILE, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  fs.writeFileSync(GALLERIES_FILE, `${JSON.stringify(galleries, null, 2)}\n`, 'utf8');
  fs.writeFileSync(afterFile, snapshot('sesudah optimasi'), 'utf8');
}

const beforeTotal = results.reduce((sum, r) => sum + r.before, 0);
const afterTotal = results.reduce((sum, r) => sum + r.after, 0);

console.log(`\n${'─'.repeat(78)}`);
console.log(`  SELESAI — ${results.length} berhasil, ${failed} gagal/skip`);
if (results.length > 0) {
  console.log(`  Ukuran berkas media : ${mb(beforeTotal)} → ${mb(afterTotal)}`);
  console.log(`  Penghematan         : ${mb(beforeTotal - afterTotal)} (${(100 - (afterTotal / beforeTotal) * 100).toFixed(0)}%)`);
  console.log(`  Setiap kali halaman dibuka, sekian itu yang TIDAK lagi terpakai dari kuota.`);
  console.log(`\n  Berikutnya:`);
  console.log(`   1. Lokal  : data/*.json sudah diperbarui — jalankan \`npm start\` lalu muat ulang.`);
  console.log(`   2. Vercel : buka dashboard live -> Akun & Keamanan -> Pulihkan dari backup,`);
  console.log(`               lalu pilih  data/${path.basename(afterFile)}`);
  console.log(`      (atau jalankan \`npm run migrate:kv\` bila REDIS_URL sudah diisi).`);
}
console.log(`  Cadangan  : data/${path.basename(beforeFile)}`);
console.log(`${'─'.repeat(78)}\n`);
