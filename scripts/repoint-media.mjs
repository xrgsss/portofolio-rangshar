/**
 * scripts/repoint-media.mjs
 * ---------------------------------------------------------------------------
 * Mengarahkan alamat media di data/content.json & data/galleries.json supaya
 * menunjuk ke host baru (GitHub Pages, Cloudflare Pages, host sendiri, dsb.).
 *
 * Dipakai setelah hasil pengecilan disiapkan dengan:
 *   npm run optimize:media -- --out media-siap-unggah
 * Skrip itu menulis catatan pemetaan (alamat lama -> berkas baru) ke
 * data/media-manifest.json, dan itulah yang dibaca di sini.
 *
 *   npm run repoint:media -- --host https://contoh.example/media --dry
 *   npm run repoint:media -- --host https://contoh.example/media
 *
 * Opsi:
 *   --host <alamat>      wajib; alamat dasar, tanpa garis miring di akhir
 *   --manifest <berkas>  catatan pemetaan (bawaan data/media-manifest.json)
 *   --out <folder>       periksa juga berkasnya benar-benar ada di folder itu
 *                        (bawaan: folder yang tercatat di manifest)
 *   --dry                hanya melaporkan, tidak mengubah berkas
 *
 * Aman diulang: kalau data sudah memakai alamat baru, tidak ada yang berubah.
 * Sebelum mengubah, isi lama disalin ke data/repoint-<waktu>-before.json.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const DATA_FILES = [path.join(ROOT, 'data', 'content.json'), path.join(ROOT, 'data', 'galleries.json')];

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const DRY = args.includes('--dry');
const HOST = valueOf('host', '').replace(/\/+$/, '');
const MANIFEST_FILE = path.resolve(ROOT, valueOf('manifest', path.join('data', 'media-manifest.json')));
const OUT_DIR = valueOf('out', '');

if (!HOST) {
  console.error('✖  Alamat host belum diisi.');
  console.error('   Contoh: npm run repoint:media -- --host https://xrgsss.github.io/portfolio-media --dry');
  process.exit(1);
}

if (!/^https?:\/\//i.test(HOST)) {
  console.error(`✖  Alamat host harus dimulai dengan http:// atau https:// — sekarang: ${HOST}`);
  process.exit(1);
}

/**
 * Bentuk alamat paling aman: setiap segmen di-encode penuh, termasuk karakter
 * yang biasanya dibiarkan oleh encodeURI/encodeURIComponent ( ! ' ( ) * ).
 */
const fullyEncodedPath = (relative) =>
  relative
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/');

/** Ambil pathname dari alamat media mana pun (Blob store lama, host lain, dsb.). */
const pathnameOf = (value) => {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return '';
  }
};

/** Ganti semua string di dalam JSON yang isinya alamat media lama. */
const rewriteUrls = (value, map) => {
  let replaced = 0;

  const walkValue = (node) => {
    if (typeof node === 'string') {
      const direct = map.get(node);
      if (direct) {
        replaced += 1;
        return direct;
      }

      // Dicocokkan lewat pathname-nya, jadi host store lama yang berbeda pun
      // tetap terarah ke alamat baru.
      const pathname = pathnameOf(node);
      if (pathname && map.has(pathname)) {
        replaced += 1;
        return map.get(pathname);
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

/** Kumpulkan semua alamat media dari data (untuk laporan sisa alamat lama). */
const collectMedia = (nodes) => {
  const found = [];
  const walkValue = (node) => {
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node) || /^\/?images\//i.test(node) || /^\/?uploads\//i.test(node)) {
        if (/\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov|m4v|ogg)(\?|#|$)/i.test(node)) found.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walkValue(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node)) walkValue(item);
    }
  };
  for (const node of nodes) walkValue(node);
  return found;
};

const sizeText = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/* ------------------------------------------------------------------- mulai */

if (!fs.existsSync(MANIFEST_FILE)) {
  console.error(`✖  Catatan pemetaan tidak ditemukan: ${path.relative(ROOT, MANIFEST_FILE)}`);
  console.error('   Jalankan dulu:  npm run optimize:media -- --out media-siap-unggah');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
const entries = Array.isArray(manifest.entries) ? manifest.entries : [];

if (entries.length === 0) {
  console.error('✖  Catatan pemetaan itu kosong.');
  process.exit(1);
}

// Folder hasil: dari --out, kalau tidak ada pakai yang tercatat di manifest.
const outDir = OUT_DIR
  ? path.resolve(ROOT, OUT_DIR)
  : manifest.outDir
    ? path.resolve(ROOT, manifest.outDir)
    : '';

console.log(`\n${'─'.repeat(78)}`);
console.log(`  ARAHKAN MEDIA KE HOST BARU${DRY ? ' (SIMULASI — tidak ada yang diubah)' : ''}`);
console.log(`${'─'.repeat(78)}`);
console.log(`  Host baru   : ${HOST}`);
console.log(`  Pemetaan    : ${path.relative(ROOT, MANIFEST_FILE).split(path.sep).join('/')} (${entries.length} berkas)`);
if (outDir) console.log(`  Folder hasil: ${path.relative(ROOT, outDir).split(path.sep).join('/')}`);

/* --------------------------------------------------- periksa kelengkapan -- */

const map = new Map();

for (const entry of entries) {
  if (!entry || !entry.from || !entry.pathname) continue;

  const encoded = fullyEncodedPath(entry.pathname);
  const url = `${HOST}/${encoded}`;

  map.set(entry.from, url);
  map.set(entry.pathname, url);
  map.set(encoded, url);
  map.set(encodeURI(entry.pathname), url);

  const pathname = pathnameOf(entry.from);
  if (pathname) {
    map.set(pathname, url);
    map.set(fullyEncodedPath(pathname), url);
  }
}

if (outDir && fs.existsSync(outDir)) {
  const missing = entries.filter((entry) => !fs.existsSync(path.join(outDir, entry.pathname)));

  if (missing.length > 0) {
    console.log(`\n  ⚠  ${missing.length} berkas di catatan pemetaan TIDAK ada di folder hasil:`);
    for (const entry of missing.slice(0, 10)) console.log(`       ${entry.pathname}`);
    if (missing.length > 10) console.log(`       ... dan ${missing.length - 10} berkas lain`);
    console.log('     (alamatnya tetap diarahkan — pastikan berkasnya benar-benar terunggah)');
    process.exitCode = 1;
  } else {
    const total = entries.reduce((sum, entry) => sum + (entry.after || 0), 0);
    console.log(`  Isi folder  : lengkap (${entries.length} berkas, ${sizeText(total)})`);
  }
} else if (outDir) {
  console.log(`\n  ⚠  Folder hasil belum ada: ${path.relative(ROOT, outDir).split(path.sep).join('/')}`);
  console.log('     Pemeriksaan kelengkapan dilewati.');
  process.exitCode = 1;
}

console.log('─'.repeat(78));

/* --------------------------------------------------------------- tulis -- */

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let totalReplaced = 0;

for (const file of DATA_FILES) {
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const originalText = fs.readFileSync(file, 'utf8');
  const { result, replaced } = rewriteUrls(original, map);
  const name = path.relative(ROOT, file).split(path.sep).join('/');

  if (replaced === 0) {
    console.log(`  ${name.padEnd(26)} tidak ada yang perlu diubah`);
    continue;
  }

  if (!DRY) {
    const backup = path.join(ROOT, 'data', `repoint-${stamp}-before.json`);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, originalText, 'utf8');
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  totalReplaced += replaced;
  console.log(`  ${name.padEnd(26)} ${replaced} alamat ${DRY ? 'akan diubah' : 'diperbarui'}`);
}

console.log('─'.repeat(78));

/* ------------------------------------------------- sisa alamat host lama -- */

const after = DATA_FILES.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
const remaining = new Set();

for (const value of collectMedia(after)) {
  if (/^https?:\/\//i.test(value) && !value.startsWith(HOST)) remaining.add(pathnameOf(value) || value);
}

if (remaining.size > 0) {
  console.log(`\n  ⚠  ${remaining.size} alamat masih menunjuk host lama (berkas lokalnya tidak ada):`);
  for (const item of [...remaining].slice(0, 10)) console.log(`       ${item}`);
  if (remaining.size > 10) console.log(`       ... dan ${remaining.size - 10} alamat lain`);
  console.log('     Untuk berkas yang tersimpan di Blob store lama: alamat itu hidup lagi');
  console.log('     setelah blokirnya berakhir, atau unggah ulang berkas aslinya ke host baru.');
}

console.log(`\n${'─'.repeat(78)}`);
if (DRY) {
  console.log(`  SIMULASI — ${totalReplaced} alamat akan diubah. Jalankan tanpa --dry untuk menerapkan.`);
} else {
  console.log(`  SELESAI — ${totalReplaced} alamat diarahkan ke ${HOST}`);
  if (totalReplaced > 0) console.log(`  Cadangan : data/repoint-${stamp}-before.json`);
  console.log('\n  Berikutnya: periksa tampilannya, lalu commit + push supaya situs live ikut berubah.');
}
console.log(`${'─'.repeat(78)}\n`);
