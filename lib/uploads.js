/**
 * lib/uploads.js
 * ---------------------------------------------------------------------------
 * Menerima unggahan gambar/video dari dashboard admin.
 *
 * - File disimpan di `images/uploads/`
 * - Nama file selalu dibuat ulang (acak + waktu) sehingga nama asli dari
 *   pengguna tidak pernah dipakai langsung di filesystem
 * - Hanya tipe gambar/video yang diizinkan
 * - Ukuran dibatasi
 * - Penghapusan file DIKUNCI hanya untuk isi folder images/uploads
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');

const ROOT = path.resolve(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'images', 'uploads');
const UPLOAD_URL_PREFIX = 'images/uploads/';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg',
  '.mp4', '.webm', '.mov', '.m4v', '.ogg',
]);

const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB

const slugify = (value = '') =>
  value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '';
    const base = slugify(path.basename(file.originalname || 'file')) || 'file';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const random = Math.random().toString(36).slice(2, 8);
    cb(null, `${stamp}-${base}-${random}${safeExt}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mimeOk = /^(image|video)\//i.test(file.mimetype || '');
  if (ALLOWED_EXTENSIONS.has(ext) && mimeOk) return cb(null, true);
  return cb(new Error(`Tipe file tidak diizinkan. Format yang didukung: ${[...ALLOWED_EXTENSIONS].join(', ')}`));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE, files: 1 } });

/** Ubah path absolut menjadi URL relatif website. */
const toPublicUrl = (absolutePath) => UPLOAD_URL_PREFIX + path.basename(absolutePath);

/**
 * Hapus file unggahan. Hanya mengizinkan file di dalam images/uploads
 * sehingga data website lain tidak bisa dihapus dari sini.
 */
const removeUpload = (relativeUrl) => {
  const cleanUrl = String(relativeUrl || '');
  if (!cleanUrl.startsWith(UPLOAD_URL_PREFIX)) {
    throw new Error('Hanya file di folder images/uploads yang boleh dihapus.');
  }

  const target = path.resolve(ROOT, cleanUrl);
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (!target.startsWith(resolvedDir + path.sep)) {
    throw new Error('Path file tidak valid.');
  }
  if (!fs.existsSync(target)) return false;

  fs.unlinkSync(target);
  return true;
};

/** Daftar file unggahan (untuk pemilih gambar). */
const listUploads = () => {
  const files = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
  return files
    .filter((entry) => entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, entry.name));
      return {
        url: UPLOAD_URL_PREFIX + entry.name,
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        isVideo: /\.(mp4|webm|mov|m4v|ogg)$/i.test(entry.name),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
};

/** Semua gambar/video yang ada di folder images (termasuk yang lama). */
const listMediaLibrary = () => {
  const results = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const relative = path.relative(ROOT, full).split(path.sep).join('/');
        results.push({
          url: encodeURI(relative).replace(/#/g, '%23'),
          rawUrl: relative,
          isVideo: /\.(mp4|webm|mov|m4v|ogg)$/i.test(entry.name),
        });
      }
    }
  };

  try {
    walk(path.join(ROOT, 'images'));
  } catch {
    return [];
  }
  return results;
};

module.exports = {
  upload,
  UPLOAD_DIR,
  UPLOAD_URL_PREFIX,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  toPublicUrl,
  removeUpload,
  listUploads,
  listMediaLibrary,
};
