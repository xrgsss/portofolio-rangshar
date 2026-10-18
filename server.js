/**
 * server.js — Website Portofolio Rangga Febrianto
 * ---------------------------------------------------------------------------
 * Satu proses Express yang:
 *   1. Menyajikan website publik (halaman utama + halaman galeri portfolio)
 *      yang isinya dibaca dari data/content.json & data/galleries.json.
 *   2. Menyediakan dashboard admin di /admin untuk CRUD semua isi website,
 *      dilindungi login (bcrypt + session cookie HttpOnly + CSRF + rate limit).
 *
 * Jalankan: npm start
 * ---------------------------------------------------------------------------
 */

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const auth = require('./lib/auth');
const { config } = auth;
const { FileSessionStore } = require('./lib/session-store');
const { store } = require('./lib/store');
const schema = require('./lib/schema');
const uploads = require('./lib/uploads');

const ROOT = __dirname;
const app = express();

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
if (config.secureCookie) app.set('trust proxy', 1);

/* ------------------------------------------------------------- middleware */

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.use(
  session({
    name: 'portfolio.sid',
    secret: config.sessionSecret,
    store: new FileSessionStore({
      dir: path.join(ROOT, '.sessions'),
      ttl: 8 * 60 * 60 * 1000, // 8 jam
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookie,
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    },
  })
);

// Header keamanan dasar untuk semua respons.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Robots-Tag', req.path.startsWith('/admin') ? 'noindex, nofollow' : 'index, follow');
  next();
});

/* ------------------------------------------------------- aset statis aman */

// Folder images/ dan styles.css dilayani langsung. Hanya itu yang dibuka,
// sehingga server.js, .env, dan data/*.json tidak pernah bisa diunduh.
app.use(
  '/images',
  express.static(path.join(ROOT, 'images'), { dotfiles: 'ignore', maxAge: '7d', index: false })
);
app.use(
  '/assets',
  express.static(path.join(ROOT, 'public'), { dotfiles: 'ignore', maxAge: '1h', index: false })
);
app.get('/styles.css', (req, res) => res.sendFile(path.join(ROOT, 'styles.css')));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\n');
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

/* -------------------------------------------------------------- helpers */

/** Ambil daftar gambar dari sebuah galeri (untuk slider kartu di halaman utama). */
const galleryImages = (gallery, limit = 6) => {
  if (!gallery) return [];
  const list = [];
  for (const section of gallery.sections || []) {
    for (const item of section.items || []) {
      if (item.type === 'image' && item.src) list.push(item.src);
    }
  }
  return [...new Set(list)].slice(0, limit);
};

const findGalleryByFile = (fileName) => {
  const galleries = store.getGalleries();
  return Object.values(galleries).find((gallery) => gallery.file === fileName) || null;
};

const renderLoginPage = (res, { error = '', notice = '', status = 200, next = '' } = {}) =>
  res.status(status).render('admin/login', { error, notice, next, siteTitle: 'Admin Dashboard' });

/* =================================================== HALAMAN PUBLIK ==== */

app.get('/', (req, res) => {
  const content = store.getContent();
  const galleries = store.getGalleries();

  const cards = content.portfolio.items.map((item) => {
    const gallery = item.galleryId ? galleries[item.galleryId] : null;
    const fromGallery = galleryImages(gallery);
    const cover = item.cover || fromGallery[0] || '';
    const images = [...new Set([cover, ...fromGallery].filter(Boolean))];
    return { ...item, cover, images };
  });

  res.render('index', {
    content,
    cards,
    pageTitle: content.meta.siteTitle || 'Portfolio',
  });
});

// URL lama tetap bekerja (dipakai oleh tautan antar halaman).
app.get('/index.html', (req, res) => res.redirect(302, '/'));

app.get(/^\/portfolio-([a-z0-9_-]+)\.html$/i, (req, res) => {
  const fileName = `portfolio-${req.params[0].toLowerCase()}.html`;
  const gallery = findGalleryByFile(fileName);
  if (!gallery) return res.status(404).render('not-found', { pageTitle: 'Halaman tidak ditemukan' });

  const content = store.getContent();
  const hasLightboxItems = gallery.sections.some((section) =>
    section.items.some((item) => !item.href)
  );

  res.render('gallery', {
    gallery,
    hasLightboxItems,
    contact: content.contact,
    pageTitle: `${gallery.title} | Portfolio`,
  });
});

/* ==================================================== LOGIN & SESSION === */

app.get('/admin/login', (req, res) => {
  if (auth.isAuthenticated(req)) return res.redirect('/admin');
  return renderLoginPage(res, {
    next: typeof req.query.next === 'string' ? req.query.next : '',
    notice: typeof req.query.notice === 'string' ? req.query.notice : '',
  });
});

app.post('/admin/login', async (req, res) => {
  const nextParam = typeof req.body.next === 'string' ? req.body.next : '';
  const safeNext = nextParam.startsWith('/admin') ? nextParam : '/admin';

  const rateKey = `login:${req.ip}`;
  const limit = auth.checkRateLimit(rateKey);

  if (limit.blocked) {
    return renderLoginPage(res, {
      status: 429,
      next: safeNext,
      error: `Terlalu banyak percobaan gagal. Coba lagi dalam ${Math.ceil(limit.retryAfterSeconds / 60)} menit.`,
    });
  }

  const username = req.body.username;
  const password = req.body.password;

  if (!username || !password) {
    return renderLoginPage(res, { status: 400, next: safeNext, error: 'Username dan password wajib diisi.' });
  }

  let ok = false;
  try {
    ok = await auth.verifyCredentials(username, password);
  } catch {
    ok = false;
  }

  if (!ok) {
    const after = auth.recordFailure(rateKey);
    const remaining = after.remaining;
    return renderLoginPage(res, {
      status: 401,
      next: safeNext,
      error:
        remaining > 0
          ? `Username atau password salah. Sisa percobaan: ${remaining}.`
          : 'Terlalu banyak percobaan gagal. Akun dikunci sementara selama 15 menit.',
    });
  }

  auth.clearFailures(rateKey);
  await auth.login(req, String(username).trim());
  return res.redirect(safeNext);
});

app.post('/admin/logout', auth.requireAuthPage, async (req, res) => {
  const token = req.body._csrf || req.get('x-csrf-token') || '';
  if (token && token === auth.getCsrfToken(req)) {
    await auth.logout(req);
    return res.redirect('/admin/login?notice=' + encodeURIComponent('Anda sudah keluar.'));
  }
  return res.redirect('/admin');
});

app.get('/admin', auth.requireAuthPage, (req, res) => {
  res.render('admin/dashboard', {
    csrfToken: auth.getCsrfToken(req),
    account: auth.getCredentials(),
    pageTitle: 'Admin Dashboard',
  });
});

app.get('/admin/*', auth.requireAuthPage, (req, res) => res.redirect('/admin'));

/* ======================================================== API ADMIN ===== */

const api = express.Router();
api.use(auth.requireAuthApi);

api.get('/session', (req, res) => {
  const galleries = store.getGalleries();
  const content = store.getContent();
  const galleryItems = Object.values(galleries).reduce(
    (total, gallery) => total + (gallery.sections || []).reduce((sum, s) => sum + (s.items || []).length, 0),
    0
  );

  res.json({
    ok: true,
    account: auth.getCredentials(),
    csrfToken: auth.getCsrfToken(req),
    stats: {
      portfolio: content.portfolio.items.length,
      specialties: content.specialties.items.length,
      experience: content.experience.items.length,
      tools: content.tools.items.length,
      galleries: Object.keys(galleries).length,
      galleryItems,
    },
  });
});

api.get('/content', (req, res) => res.json({ ok: true, content: store.getContent() }));

api.put('/content/:section', auth.requireCsrf, async (req, res) => {
  const section = String(req.params.section || '');
  const sanitizer = schema.CONTENT_SECTIONS[section];

  if (!sanitizer) {
    return res.status(400).json({ ok: false, error: `Bagian "${section}" tidak dikenal.` });
  }

  const content = store.getContent();
  content[section] = sanitizer(req.body);

  try {
    await store.saveContent(content);
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Gagal menyimpan: ${error.message}` });
  }

  return res.json({ ok: true, section, value: content[section] });
});

api.get('/galleries', (req, res) => res.json({ ok: true, galleries: store.getGalleries() }));

api.put('/galleries/:id', auth.requireCsrf, async (req, res) => {
  const galleries = store.getGalleries();
  const existing = galleries[req.params.id];

  if (!existing) return res.status(404).json({ ok: false, error: 'Halaman galeri tidak ditemukan.' });

  galleries[req.params.id] = schema.sanitizeGallery(req.body, existing);

  try {
    await store.saveGalleries(galleries);
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Gagal menyimpan: ${error.message}` });
  }

  return res.json({ ok: true, gallery: galleries[req.params.id] });
});

/* -------------------------------------------------------------- uploads */

api.post('/uploads', auth.requireCsrf, (req, res) => {
  uploads.upload.single('file')(req, res, (error) => {
    if (error) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `Ukuran file terlalu besar (maksimal ${Math.round(uploads.MAX_FILE_SIZE / 1024 / 1024)} MB).`
          : error.message;
      return res.status(400).json({ ok: false, error: message });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'Tidak ada file yang dikirim.' });

    return res.json({
      ok: true,
      url: uploads.toPublicUrl(req.file.path),
      name: req.file.filename,
      size: req.file.size,
    });
  });
});

api.get('/media', (req, res) => {
  res.json({ ok: true, uploads: uploads.listUploads(), library: uploads.listMediaLibrary() });
});

api.delete('/media', auth.requireCsrf, (req, res) => {
  try {
    const removed = uploads.removeUpload(req.body && req.body.url);
    return res.json({ ok: true, removed });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

/* ------------------------------------------------------- ganti password */

api.post('/password', auth.requireCsrf, async (req, res) => {
  const current = String((req.body && req.body.currentPassword) || '');
  const next = String((req.body && req.body.newPassword) || '');
  const confirm = String((req.body && req.body.confirmPassword) || '');

  if (!current || !next) {
    return res.status(400).json({ ok: false, error: 'Password lama dan password baru wajib diisi.' });
  }
  if (next !== confirm) {
    return res.status(400).json({ ok: false, error: 'Konfirmasi password baru tidak sama.' });
  }
  if (next.length < 10 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
    return res
      .status(400)
      .json({ ok: false, error: 'Password baru minimal 10 karakter dan harus berisi huruf serta angka.' });
  }
  if (current === next) {
    return res.status(400).json({ ok: false, error: 'Password baru harus berbeda dari password lama.' });
  }

  const currentOk = await auth.verifyCredentials(auth.getCredentials().user, current);
  if (!currentOk) return res.status(401).json({ ok: false, error: 'Password lama salah.' });

  const hash = auth.setPassword(next);
  const { setEnvValue } = require('./lib/config');
  setEnvValue('ADMIN_PASSWORD_HASH', hash);

  // Perbarui token CSRF setelah password berubah.
  if (req.session && req.session.admin) {
    req.session.admin.csrf = require('node:crypto').randomBytes(32).toString('hex');
  }

  return res.json({ ok: true, csrfToken: auth.getCsrfToken(req), message: 'Password berhasil diganti.' });
});

/* --------------------------------------------------------- backup data */

api.get('/export', (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    content: store.getContent(),
    galleries: store.getGalleries(),
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="portfolio-backup-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.send(JSON.stringify(payload, null, 2));
});

api.post('/import', auth.requireCsrf, async (req, res) => {
  const body = req.body || {};
  if (!body.content || typeof body.content !== 'object') {
    return res.status(400).json({ ok: false, error: 'File backup tidak valid (bagian "content" tidak ada).' });
  }

  // Semua bagian tetap dibersihkan lewat skema yang sama seperti input manual.
  const cleaned = {};
  for (const [section, sanitizer] of Object.entries(schema.CONTENT_SECTIONS)) {
    cleaned[section] = sanitizer(body.content[section] || {});
  }

  const currentGalleries = store.getGalleries();
  const nextGalleries = { ...currentGalleries };
  if (body.galleries && typeof body.galleries === 'object') {
    for (const [id, gallery] of Object.entries(body.galleries)) {
      const existing = currentGalleries[id];
      if (!existing) continue; // halaman galeri hanya yang sudah dikenal
      nextGalleries[id] = schema.sanitizeGallery(gallery, existing);
    }
  }

  await store.saveContent(cleaned);
  await store.saveGalleries(nextGalleries);

  return res.json({ ok: true, message: 'Data berhasil dipulihkan dari backup.' });
});

app.use('/api', api);

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.' }));

/* ============================================================== 404 ===== */

app.use((req, res) => res.status(404).render('not-found', { pageTitle: 'Halaman tidak ditemukan' }));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error('✖  Error:', error.message);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, error: 'Terjadi kesalahan di server.' });
  }
  return res.status(500).type('text/plain').send('Terjadi kesalahan di server.');
});

/* ============================================================= start ==== */

const server = app.listen(config.port, () => {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  Website Portofolio — Rangga Febrianto');
  console.log(line);
  console.log(`\n  Website  : http://localhost:${config.port}/`);
  console.log(`  Admin    : http://localhost:${config.port}/admin`);
  console.log(`${line}`);
  console.log('  Hentikan server dengan Ctrl+C.');
  console.log(`${line}\n`);
});

server.on('error', (error) => {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  if (error.code === 'EADDRINUSE') {
    console.error(`  ✖  Port ${config.port} sedang dipakai proses lain.`);
    console.error('     Tutup aplikasi lain yang memakai port itu, atau jalankan');
    console.error(`     dengan port berbeda, misalnya:  PORT=3001 npm start`);
  } else if (error.code === 'EACCES') {
    console.error(`  ✖  Tidak punya izin memakai port ${config.port}. Coba port lain (mis. 3001).`);
  } else {
    console.error(`  ✖  Server gagal dijalankan: ${error.message}`);
  }
  console.log(`${line}\n`);
  process.exit(1);
});

/* Kredensial yang baru dibuat dicetak SEBELUM server menyala, supaya tidak
   pernah hilang walau server gagal start. */
if (config.generated) {
  const line = '═'.repeat(64);
  console.log(`\n${line}`);
  console.log('  KREDENSIAL ADMIN BARU (dicetak sekali, simpan sekarang)');
  console.log(line);
  console.log(`  Username : ${config.generated.user}`);
  console.log(`  Password : ${config.generated.password}`);
  console.log(line);
  console.log('  Buka /admin untuk login, lalu ganti password ini di menu');
  console.log('  "Akun & Keamanan". Password tidak bisa dilihat lagi.');
  console.log(`${line}\n`);
}

for (const notice of config.notices) console.log(`  ℹ  ${notice}`);

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
