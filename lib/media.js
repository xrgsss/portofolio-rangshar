/**
 * lib/media.js
 * ---------------------------------------------------------------------------
 * Penyimpanan media (gambar & video) memakai Vercel Blob.
 *
 * Kenapa Blob dan bukan folder images/?
 *   - Filesystem Vercel read-only, jadi file unggahan tidak bisa disimpan
 *     di folder project.
 *   - Body request Vercel Function dibatasi 4.5 MB, sedangkan di sini
 *     file boleh sampai 40 MB. Karena itu browser mengunggah LANGSUNG ke
 *     Blob memakai "presigned URL" yang dibuat server (lihat createUploadTicket).
 *
 * Struktur di dalam store:
 *   uploads/<nama>   -> semua berkas yang diunggah dari dashboard
 *   images/<nama>    -> media lama yang dipindahkan dari folder images/
 *
 * Kalau Blob belum dikonfigurasi (mis. `npm start` di laptop tanpa
 * `vercel env pull`), pustaka media tetap bisa dibaca dari folder images/
 * supaya pengembangan lokal tidak terganggu.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const { del, head, issueSignedToken, list, presignUrl } = require('@vercel/blob');
const { PLACEHOLDER_VALUE } = require('./env');

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'images');

const UPLOAD_PREFIX = 'uploads/';
const LEGACY_PREFIX = 'images/';

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg',
  '.mp4', '.webm', '.mov', '.m4v', '.ogg',
]);

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogg)$/i;
const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB
const UPLOAD_URL_TTL_MS = 10 * 60 * 1000; // 10 menit untuk menyelesaikan unggahan

/** Tipe MIME yang dipakai kalau browser tidak mengirimkannya. */
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

/** Blob (dan link hasil unggahan) ditandatangani; URL tidak boleh panjang. */
const FOLDER_URL_HINT = 'Unggahan langsung dari browser memakai URL bertanda tangan Blob.';

/** Nilai environment yang benar-benar terisi (bukan placeholder). */
const envValue = (name) => {
  const value = String(process.env[name] || '').trim();
  return value && !PLACEHOLDER_VALUE.test(value) ? value : '';
};

const isConfigured = () => Boolean(envValue('BLOB_STORE_ID') || envValue('BLOB_READ_WRITE_TOKEN'));

const requireConfigured = () => {
  if (!isConfigured()) {
    throw new Error(
      'Penyimpanan Blob belum dikonfigurasi. Hubungkan Blob store ke project lalu jalankan `vercel env pull`.'
    );
  }
};

const slugify = (value = '') =>
  value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/* --------------------------------------------------------- validasi input */

const extensionOf = (fileName) => path.extname(String(fileName || '')).toLowerCase();

const contentTypeFor = (fileName, providedType) => {
  const ext = extensionOf(fileName);
  const provided = String(providedType || '').toLowerCase().trim();
  if (provided && provided !== 'application/octet-stream') return provided;
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
};

const validateFile = ({ name, size, type }) => {
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Tipe file tidak diizinkan. Format yang didukung: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }

  const contentType = contentTypeFor(name, type);
  if (!/^(image|video)\//i.test(contentType)) {
    throw new Error('Hanya berkas gambar atau video yang boleh diunggah.');
  }

  if (Number.isFinite(size) && size > MAX_FILE_SIZE) {
    throw new Error(`Ukuran file terlalu besar (maksimal ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB).`);
  }

  return { ext, contentType };
};

/** Nama file selalu dibuat ulang, nama asli dari pengguna tidak pernah dipakai. */
const buildPathname = (originalName) => {
  const ext = extensionOf(originalName);
  const base = slugify(path.basename(String(originalName || 'file'))) || 'file';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${UPLOAD_PREFIX}${stamp}-${base}-${random}${ext}`;
};

/* --------------------------------------------------------------- membaca */

const MAX_PAGES = 20;

/**
 * Ambil semua blob di bawah satu prefix.
 * @returns {Promise<Array<{url:string, pathname:string, size:number, uploadedAt:string}>>}
 */
const listBlobs = async (prefix) => {
  const results = [];
  let cursor;
  let page = 0;

  do {
    const response = await list({ prefix, cursor, limit: 1000 });
    results.push(...(response.blobs || []));
    cursor = response.cursor;
    page += 1;
  } while (cursor && page < MAX_PAGES);

  return results;
};

const toMediaItem = (blob) => {
  const name = String(blob.pathname || '').split('/').pop() || '';
  return {
    url: blob.url,
    rawUrl: blob.url,
    name,
    size: Number(blob.size) || 0,
    modifiedAt: blob.uploadedAt ? new Date(blob.uploadedAt).toISOString() : new Date(0).toISOString(),
    isVideo: VIDEO_EXTENSIONS.test(name),
  };
};

/** Berkas yang bisa dihapus dari dashboard: hanya isi folder uploads/. */
const listUploads = async () => {
  if (!isConfigured()) return [];
  const blobs = await listBlobs(UPLOAD_PREFIX);
  return blobs.map(toMediaItem).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
};

/** Semua media: hasil unggahan + media lama dari folder images/. */
const listMediaLibrary = async () => {
  if (!isConfigured()) return listLocalMedia();

  const [uploads, legacy] = await Promise.all([
    listBlobs(UPLOAD_PREFIX),
    listBlobs(LEGACY_PREFIX),
  ]);

  const seen = new Set();
  return [...legacy, ...uploads]
    .map(toMediaItem)
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
};

/** Cadangan untuk pengembangan lokal tanpa Blob: baca folder images/. */
const listLocalMedia = () => {
  const results = [];

  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const relative = path.relative(ROOT, full).split(path.sep).join('/');
        const stat = fs.statSync(full);
        results.push({
          url: encodeURI(relative).replace(/#/g, '%23'),
          rawUrl: relative,
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isVideo: VIDEO_EXTENSIONS.test(entry.name),
        });
      }
    }
  };

  try {
    walk(IMAGES_DIR);
  } catch {
    return [];
  }

  return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
};

/* -------------------------------------------------------------- unggahan */

/**
 * Buat URL unggahan bertanda tangan. Browser memakai URL ini untuk mengirim
 * berkas langsung ke Blob, sehingga tidak melewati batas 4.5 MB milik function.
 *
 * @param {{ name:string, type?:string, size?:number }} input
 * @returns {Promise<{ pathname:string, uploadUrl:string, contentType:string, expiresAt:number }>}
 */
const createUploadTicket = async ({ name, type, size } = {}) => {
  requireConfigured();

  const { contentType } = validateFile({ name, type, size });
  const pathname = buildPathname(name);
  const validUntil = Date.now() + UPLOAD_URL_TTL_MS;

  const token = await issueSignedToken({
    pathname,
    operations: ['put'],
    allowedContentTypes: [contentType],
    maximumSizeInBytes: MAX_FILE_SIZE,
    validUntil,
  });

  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'public',
    allowedContentTypes: [contentType],
    maximumSizeInBytes: MAX_FILE_SIZE,
    addRandomSuffix: false,
    allowOverwrite: false,
    validUntil,
  });

  if (!presignedUrl) throw new Error(`Gagal membuat URL unggahan. ${FOLDER_URL_HINT}`);

  return { pathname, uploadUrl: presignedUrl, contentType, expiresAt: validUntil };
};

/**
 * Dipanggil setelah browser selesai mengunggah, untuk mengambil URL publik
 * resmi dari Blob (nama/alamat tidak ditebak sendiri oleh aplikasi).
 */
const confirmUpload = async (pathname) => {
  requireConfigured();

  const clean = String(pathname || '');
  if (!clean.startsWith(UPLOAD_PREFIX) || clean.includes('..')) {
    throw new Error('Nama berkas tidak valid.');
  }

  const metadata = await head(clean);
  return {
    url: metadata.url,
    pathname: metadata.pathname,
    size: metadata.size,
    contentType: metadata.contentType,
  };
};

/* ------------------------------------------------------------- penghapusan */

const isBlobStoreUrl = (value) => {
  try {
    const parsed = new URL(value);
    return /\.blob\.vercel-storage\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
};

/**
 * Hapus berkas unggahan. Hanya berkas di folder uploads/ yang boleh dihapus,
 * sehingga media lama (images/) tidak bisa terhapus dari dashboard.
 */
const removeUpload = async (reference) => {
  const raw = String(reference || '').trim();
  if (!raw) throw new Error('Alamat berkas tidak boleh kosong.');

  // Media lama / mode lokal: path relatif di dalam images/uploads.
  if (!isBlobStoreUrl(raw)) {
    const relative = decodeURI(raw).replace(/^\/+/, '');
    if (!relative.startsWith('images/uploads/')) {
      throw new Error('Hanya berkas di folder images/uploads yang boleh dihapus.');
    }
    const target = path.resolve(ROOT, relative);
    const resolvedDir = path.resolve(IMAGES_DIR, 'uploads');
    if (!target.startsWith(resolvedDir + path.sep)) throw new Error('Path file tidak valid.');
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  }

  const pathname = decodeURIComponent(new URL(raw).pathname.replace(/^\/+/, ''));
  if (!pathname.startsWith(UPLOAD_PREFIX)) {
    throw new Error('Hanya berkas hasil unggahan yang boleh dihapus dari sini.');
  }

  requireConfigured();
  await del(pathname);
  return true;
};

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  UPLOAD_PREFIX,
  LEGACY_PREFIX,
  isConfigured,
  createUploadTicket,
  confirmUpload,
  listUploads,
  listMediaLibrary,
  removeUpload,
};
