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
 *   npm run optimize:media                     proses semua berkas, lalu unggah ke Blob
 *   npm run optimize:media -- --out <folder>   simpan hasil ke folder lokal
 *                                              (tanpa unggah & tanpa ubah data)
 *   npm run optimize:media -- --limit 1        uji coba 1 berkas dulu
 *   npm run optimize:media -- --only 3d        pilih berkas yang mengandung "3d"
 *   npm run optimize:media -- --video-only     hanya video
 *   npm run optimize:media -- --image-only     hanya gambar
 *   npm run optimize:media -- --crf 30         video lebih kecil (default 28)
 *   npm run optimize:media -- --preset fast    video lebih cepat diproses (default slow)
 *
 * Dua tujuan:
 *   1. Vercel Blob (bawaan)
 *      - Berkas hasil diunggah ke  images/optimized/<path lama>  (berkas lama TIDAK dihapus)
 *      - data/content.json & data/galleries.json diperbarui ke alamat baru
 *      - Cadangan: data/optimize-<waktu>-before.json & -after.json
 *   2. Folder lokal (--out)
 *      - Hasil ditulis ke folder itu, strukturnya mengikuti pathname di store,
 *        dan berkas yang tidak perlu dikompres ikut disalin apa adanya supaya
 *        satu folder itu lengkap untuk menggantikan seluruh media website.
 *      - data/*.json TIDAK diubah. Catatan pemetaannya ditulis ke
 *        data/media-manifest.json, yang nanti dipakai perintah:
 *          npm run repoint:media -- --host https://host-baru.example
 *
 * Prasyarat: ffmpeg. Bisa dipakai dari berkas portabel, tanpa dipasang ke sistem:
 *   $env:FFMPEG_PATH = "C:\path\ke\ffmpeg.exe"
 * Kalau belum ada:
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
const PRESET = valueOf('preset', 'slow');
const IMAGE_QUALITY = valueOf('image-quality', '80');
const MAX_VIDEO_WIDTH = valueOf('max-video-width', '1280');
const MAX_IMAGE_WIDTH = valueOf('max-image-width', '1920');
const VIDEO_ONLY = hasFlag('video-only');
const IMAGE_ONLY = hasFlag('image-only');

/** Tujuan hasil: folder lokal (--out) atau Vercel Blob (bawaan). */
const OUT_DIR = valueOf('out', '');
const OUT_ROOT = OUT_DIR ? path.resolve(ROOT, OUT_DIR) : '';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/* ------------------------------------------------------------------ ffmpeg */

const ffmpegPath = (() => {
  // ffmpeg portabel: pakai jalur lengkapnya lewat FFMPEG_PATH bila ada.
  const custom = (process.env.FFMPEG_PATH || '').trim();
  if (custom && fs.existsSync(custom)) {
    const probe = spawnSync(custom, ['-version'], { encoding: 'utf8' });
    if (probe.status === 0) return custom;
  }

  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'ffmpeg' : '';
})();

if (!ffmpegPath && !DRY) {
  console.error('✖  ffmpeg tidak ditemukan.');
  console.error('   Pasang dulu, atau tunjuk berkas ffmpeg portabelnya:');
  console.error('     $env:FFMPEG_PATH = "C:\\path\\ke\\ffmpeg.exe"');
  console.error('   Cara memasang:');
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
 *   https://<store>.public.blob.vercel-storage.com/uploads/c.png  -> images/uploads/c.png
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

  const candidates = [];
  if (relative.startsWith('images/')) candidates.push(path.join(ROOT, relative));
  if (relative.startsWith('uploads/')) candidates.push(path.join(ROOT, 'images', relative));

  for (const full of candidates) {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }

  return '';
};

/** Pathname di dalam store/host: images/uploads/x.png -> uploads/x.png */
const storePathnameFor = (relative) => relative.replace(/^images\/uploads\//, 'uploads/');

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
    '-preset', PRESET,
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

/** Semua media yang punya salinan lokal — termasuk yang tidak perlu dikompres. */
const semua = [];

for (const reference of collectMedia([content, galleries])) {
  const local = localPathFor(reference);
  if (!local) continue;

  const ext = path.extname(local).toLowerCase();
  const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : 'lain';
  const relative = path.relative(ROOT, local).split(path.sep).join('/');

  semua.push({ reference, local, relative, size: fs.statSync(local).size, kind, ext });
}

/** Yang dipilih untuk diproses (--only / --video-only / --image-only). */
const dipilih = semua.filter((item) => {
  if (VIDEO_ONLY && item.kind !== 'video') return false;
  if (IMAGE_ONLY && item.kind !== 'image') return false;
  if (ONLY && !item.relative.toLowerCase().includes(ONLY.toLowerCase())) return false;
  return true;
});

/** Yang benar-benar dikompres: video/gambar yang cukup besar. */
const plan = dipilih.filter((item) => {
  if (item.kind === 'lain' || SKIP_EXT.has(item.ext)) return false;
  const threshold = item.kind === 'video' ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
  return item.size >= threshold;
});

plan.sort((a, b) => b.size - a.size);

/** Mode folder lokal: berkas yang tidak dikompres ikut disalin supaya lengkap. */
const salin = OUT_ROOT && !LIMIT ? dipilih.filter((item) => !plan.includes(item)) : [];

if (plan.length === 0 && salin.length === 0) {
  console.log('ℹ  Tidak ada berkas media yang perlu dikecilkan (atau berkas lokalnya tidak ditemukan).');
  process.exit(0);
}

if (OUT_ROOT) {
  console.log(`\nℹ  Tujuan: folder ${path.relative(ROOT, OUT_ROOT).split(path.sep).join('/')} (data/*.json tidak diubah)`);
  if (salin.length > 0) console.log(`   ${salin.length} berkas kecil/tidak sepadan dikompres akan disalin apa adanya.`);
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

// Mode folder lokal tidak menyentuh data/*.json, jadi tidak perlu cadangan.
if (!OUT_ROOT) {
  fs.writeFileSync(beforeFile, snapshot('sebelum optimasi'), 'utf8');
  console.log(`\n✔  Cadangan sebelum diubah: data/${path.basename(beforeFile)}`);
}

/* ------------------------------------------------------------ proses satu */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-media-'));

/** Catatan pemetaan "alamat lama → berkas di folder hasil" (dipakai repoint:media). */
const entries = [];
let copied = 0;

/** Tulis satu berkas ke folder hasil, mengikuti pathname di store. */
const writeToOut = (source, pathname) => {
  const target = path.join(OUT_ROOT, pathname);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
};

/** Salin berkas apa adanya (berkas kecil / tidak sepadan dikompres). */
const copyVerbatim = (item) => {
  const pathname = storePathnameFor(item.relative);
  writeToOut(item.local, pathname);
  entries.push({ from: item.reference, pathname, action: 'copy', before: item.size, after: item.size });
  copied += 1;
  console.log(`  ${mb(item.size).padStart(10)}  ${pathname}  (disalin apa adanya)`);
};

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
    // Di mode folder lokal, berkasnya tetap harus ada di host baru.
    if (OUT_ROOT) copyVerbatim(item);
    continue;
  }

  const newSize = fs.statSync(output).size;
  if (newSize >= item.size * 0.9) {
    console.log(`  ↷  Dilewati: hasilnya tidak lebih kecil (${mb(newSize)} vs ${mb(item.size)}).`);
    fs.unlinkSync(output);
    // Di mode folder lokal berkasnya tetap harus ada di host baru.
    if (OUT_ROOT) copyVerbatim(item);
    continue;
  }

  const pathname = optimizedPathname(item.relative, newExt);

  // Mode folder lokal: cukup tulis ke folder — tanpa unggah, tanpa ubah data.
  if (OUT_ROOT) {
    writeToOut(output, pathname);
    fs.unlinkSync(output);
    entries.push({ from: item.reference, pathname, action: 'compress', before: item.size, after: newSize });
    results.push({ relative: item.relative, before: item.size, after: newSize, pathname });
    processed += 1;

    console.log(`  ✔  ${mb(item.size)} → ${mb(newSize)}  (hemat ${(100 - (newSize / item.size) * 100).toFixed(0)}%)`);
    console.log(`     ${pathname}`);
    continue;
  }

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

/* ---------------------------------------------------------- salin sisanya */

if (salin.length > 0) {
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  Disalin apa adanya (${salin.length} berkas kecil / tidak sepadan dikompres):`);
  for (const item of salin) copyVerbatim(item);
}

/* ---------------------------------------------------------------- manifest */

if (OUT_ROOT) {
  const manifestFile = path.join(ROOT, 'data', 'media-manifest.json');

  // Gabungkan dengan catatan sebelumnya, supaya menjalankan skrip untuk
  // beberapa berkas saja (mis. --only uploads) tidak menghapus yang lain.
  const sebelumnya = [];
  if (fs.existsSync(manifestFile)) {
    try {
      const lama = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (Array.isArray(lama.entries)) sebelumnya.push(...lama.entries);
    } catch {
      console.log('\n⚠  Catatan pemetaan lama tidak bisa dibaca, akan ditulis ulang.');
    }
  }

  const gabungan = new Map();
  for (const item of sebelumnya) if (item && item.pathname) gabungan.set(item.pathname, item);
  for (const item of entries) gabungan.set(item.pathname, item);

  const semuaEntri = [...gabungan.values()];
  const manifest = {
    generatedAt: new Date().toISOString(),
    outDir: path.relative(ROOT, OUT_ROOT).split(path.sep).join('/'),
    total: semuaEntri.length,
    entries: semuaEntri,
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const baru = semuaEntri.length - sebelumnya.length;
  console.log(
    `\n✔  Catatan pemetaan: data/${path.basename(manifestFile)} (${semuaEntri.length} berkas` +
      (baru > 0 ? `, ${baru} baru` : '') +
      ')'
  );
}

/* --------------------------------------------------------------- simpan -- */

if (results.length > 0 && !OUT_ROOT) {
  fs.writeFileSync(CONTENT_FILE, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  fs.writeFileSync(GALLERIES_FILE, `${JSON.stringify(galleries, null, 2)}\n`, 'utf8');
  fs.writeFileSync(afterFile, snapshot('sesudah optimasi'), 'utf8');
}

const beforeTotal = results.reduce((sum, r) => sum + r.before, 0);
const afterTotal = results.reduce((sum, r) => sum + r.after, 0);

console.log(`\n${'─'.repeat(78)}`);

if (OUT_ROOT) {
  const totalAsli = entries.reduce((sum, item) => sum + item.before, 0);
  const totalBaru = entries.reduce((sum, item) => sum + item.after, 0);
  const folder = path.relative(ROOT, OUT_ROOT).split(path.sep).join('/');

  console.log(`  SELESAI — ${entries.length} berkas siap di folder ${folder}`);
  console.log(`  ${results.length} dikompres, ${copied} disalin apa adanya, ${failed} gagal dikompres`);
  console.log(`  Ukuran total : ${mb(totalAsli)} → ${mb(totalBaru)} (${(100 - (totalBaru / totalAsli) * 100).toFixed(0)}% lebih kecil)`);
  console.log('  data/*.json  : belum diubah — alamat media masih menunjuk host lama.');
  console.log('\n  Berikutnya:');
  console.log(`   1. Unggah isi folder ${folder} ke host pilihan Anda, misalnya:`);
  console.log('        GitHub Pages     : dorong isinya ke repo publik, lalu aktifkan Pages');
  console.log(`        Cloudflare Pages : npx wrangler pages deploy ${folder}`);
  console.log('   2. Setelah host-nya hidup, arahkan data ke sana:');
  console.log('        npm run repoint:media -- --host https://host-anda.example --dry');
  console.log('        npm run repoint:media -- --host https://host-anda.example');
  console.log('   3. commit + push supaya situs live memakai alamat baru.');
  console.log(`${'─'.repeat(78)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

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
