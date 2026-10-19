/**
 * server.js — Website Portofolio Rangga Febrianto
 * ---------------------------------------------------------------------------
 * Satu proses Express yang:
 *   1. Menyajikan website publik (halaman utama + halaman galeri portfolio)
 *      yang isinya dibaca dari Redis (atau data/*.json saat lokal).
 *   2. Menyediakan dashboard admin di /admin untuk CRUD semua isi website,
 *      dilindungi login (bcrypt + cookie session HttpOnly + CSRF + rate limit).
 *
 * Cara jalan:
 *   - Lokal     : `npm start` (memakai file data/*.json + folder images/)
 *   - Vercel    : file ini diekspor sebagai satu Vercel Function; data
 *                 disimpan di Redis dan media di Vercel Blob.
 *
 * Catatan penting untuk Vercel:
 *   - `express.static()` DIABAIKAN oleh Vercel. Aset statis harus ada di
 *     folder `public/` (styles.css, assets/admin/*).
 *   - `app.listen()` hanya dipanggil saat dijalankan langsung dari terminal.
 * ---------------------------------------------------------------------------
 */

const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');

const auth = require('./lib/auth');
const { config } = auth;
const store = require('./lib/store').store;
const schema = require('./lib/schema');
const media = require('./lib/media');
const redis = require('./lib/redis');
const analytics = require('./lib/analytics');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const IMAGES_DIR = path.join(ROOT, 'images');

const app = express();

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));

/* ------------------------------------------------------------- middleware */

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

/**
 * Sesi disimpan di cookie yang ditandatangani (tanpa penyimpanan di server),
 * karena Vercel tidak punya disk permanen. Isi cookie: user, waktu login, dan
 * token CSRF — ketiganya tidak sensitif untuk dibaca server sendiri.
 */
app.use(
  cookieSession({
    name: 'portfolio.sid',
    keys: [config.sessionSecret],
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookie,
    path: '/',
    maxAge: 8 * 60 * 60 * 1000, // 8 jam
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

/* ------------------------------------------------ pencatatan pengunjung == */

/** Hanya halaman publik yang punya isi: halaman utama & halaman galeri. */
const isTrackedPage = (pathname) => pathname === '/' || /^\/portfolio-[a-z0-9_-]+\.html$/i.test(pathname);

/** Bot/crawler & perkakas pemantau tidak dihitung supaya angkanya wajar. */
const BOT_USER_AGENT =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|whatsapp|telegram|skypeuripreview|preview|lighthouse|headlesschrome|pingdom|uptimerobot|semrush|ahrefs|screaming|python-requests|python-urllib|curl\/|wget|axios\/|node-fetch|go-http-client|java\/|okhttp|postmanruntime/i;

/**
 * Catat satu kunjungan untuk grafik "Pengunjung Website" di dashboard.
 * Tidak menunggu (fire-and-forget) agar kecepatan halaman tidak terpengaruh,
 * dan admin yang sedang login tidak ikut terhitung (kunjungan diri sendiri).
 */
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    isTrackedPage(req.path) &&
    !auth.isAuthenticated(req) &&
    !BOT_USER_AGENT.test(req.get('user-agent') || '')
  ) {
    analytics.recordView().catch(() => {});
  }
  next();
});

/* ------------------------------------------------------- aset statis aman */

/**
 * Di Vercel, folder `public/` otomatis dilayani langsung dari CDN dan
 * middleware di bawah ini diabaikan — jadi tidak ada perbedaan hasil.
 * Di lokal, middleware inilah yang melayani /styles.css dan /assets/admin/*.
 */
app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore', maxAge: '1h', index: false }));

/**
 * Folder images/ hanya untuk pengembangan lokal (media lama). Di Vercel
 * media sudah dipindahkan ke Blob, sehingga folder ini tidak ikut ter-deploy.
 */
app.use('/images', express.static(IMAGES_DIR, { dotfiles: 'ignore', maxAge: '7d', index: false }));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\n');
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

/* -------------------------------------------------------------- helpers */

/** Bungkus handler async supaya error-nya sampai ke middleware error Express. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

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

const findGalleryByFile = async (fileName) => {
  const galleries = await store.getGalleries();
  return Object.values(galleries).find((gallery) => gallery.file === fileName) || null;
};

const renderLoginPage = (res, { error = '', notice = '', status = 200, next = '' } = {}) =>
  res.status(status).render('admin/login', { error, notice, next, siteTitle: 'Admin Dashboard' });

/* =================================================== HALAMAN PUBLIK ==== */

app.get(
  '/',
  wrap(async (req, res) => {
    const content = await store.getContent();
    const galleries = await store.getGalleries();

    const cards = (content.portfolio.items || []).map((item) => {
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
  })
);

// URL lama tetap bekerja (dipakai oleh tautan antar halaman).
app.get('/index.html', (req, res) => res.redirect(302, '/'));

app.get(
  /^\/portfolio-([a-z0-9_-]+)\.html$/i,
  wrap(async (req, res) => {
    const fileName = `portfolio-${req.params[0].toLowerCase()}.html`;
    const gallery = await findGalleryByFile(fileName);
    if (!gallery) return res.status(404).render('not-found', { pageTitle: 'Halaman tidak ditemukan' });

    const content = await store.getContent();
    const hasLightboxItems = (gallery.sections || []).some((section) =>
      (section.items || []).some((item) => !item.href)
    );

    return res.render('gallery', {
      gallery,
      hasLightboxItems,
      contact: content.contact,
      pageTitle: `${gallery.title} | Portfolio`,
    });
  })
);

/* ==================================================== LOGIN & SESSION === */

app.get('/admin/login', (req, res) => {
  if (auth.isAuthenticated(req)) return res.redirect('/admin');
  return renderLoginPage(res, {
    next: typeof req.query.next === 'string' ? req.query.next : '',
    notice: typeof req.query.notice === 'string' ? req.query.notice : '',
  });
});

app.post(
  '/admin/login',
  wrap(async (req, res) => {
    const nextParam = typeof req.body.next === 'string' ? req.body.next : '';
    const safeNext = nextParam.startsWith('/admin') ? nextParam : '/admin';

    const rateKey = `login:${req.ip}`;
    const limit = await auth.checkRateLimit(rateKey);

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
      const after = await auth.recordFailure(rateKey);
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

    await auth.clearFailures(rateKey);
    await auth.login(req, String(username).trim());
    return res.redirect(safeNext);
  })
);

app.post(
  '/admin/logout',
  auth.requireAuthPage,
  wrap(async (req, res) => {
    const token = req.body._csrf || req.get('x-csrf-token') || '';
    if (token && token === auth.getCsrfToken(req)) {
      auth.logout(req);
      return res.redirect('/admin/login?notice=' + encodeURIComponent('Anda sudah keluar.'));
    }
    return res.redirect('/admin');
  })
);

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

api.get(
  '/session',
  wrap(async (req, res) => {
    const galleries = await store.getGalleries();
    const content = await store.getContent();
    const galleryItems = Object.values(galleries).reduce(
      (total, gallery) => total + (gallery.sections || []).reduce((sum, s) => sum + (s.items || []).length, 0),
      0
    );

    res.json({
      ok: true,
      account: auth.getCredentials(),
      csrfToken: auth.getCsrfToken(req),
      stats: {
        portfolio: (content.portfolio.items || []).length,
        specialties: (content.specialties.items || []).length,
        experience: (content.experience.items || []).length,
        tools: (content.tools.items || []).length,
        galleries: Object.keys(galleries).length,
        galleryItems,
      },
      // Membantu memastikan penyimpanan sudah terhubung dengan benar.
      storage: {
        data: store.isRemote() ? `redis (${redis.transportName()})` : 'file-lokal',
        media: media.isConfigured() ? 'vercel-blob' : 'folder-lokal (images/)',
        rateLimit: redis.isConfigured() ? `redis (${redis.transportName()})` : 'memori',
      },
    });
  })
);

/**
 * Statistik pengunjung untuk grafik di dashboard.
 * `hours` (1–168) bisa dipakai kalau nanti mau menampilkan rentang lain.
 */
api.get(
  '/analytics',
  wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const report = await analytics.getReport({ hours: Number(req.query.hours) || 24 });
    res.json({ ok: true, ...report });
  })
);

api.get(
  '/content',
  wrap(async (req, res) => res.json({ ok: true, content: await store.getContent() }))
);

api.put(
  '/content/:section',
  auth.requireCsrf,
  wrap(async (req, res) => {
    const section = String(req.params.section || '');
    const sanitizer = schema.CONTENT_SECTIONS[section];

    if (!sanitizer) {
      return res.status(400).json({ ok: false, error: `Bagian "${section}" tidak dikenal.` });
    }

    const content = await store.getContent();
    content[section] = sanitizer(req.body);

    try {
      await store.saveContent(content);
    } catch (error) {
      return res.status(500).json({ ok: false, error: `Gagal menyimpan: ${error.message}` });
    }

    return res.json({ ok: true, section, value: content[section] });
  })
);

api.get(
  '/galleries',
  wrap(async (req, res) => res.json({ ok: true, galleries: await store.getGalleries() }))
);

api.put(
  '/galleries/:id',
  auth.requireCsrf,
  wrap(async (req, res) => {
    const galleries = await store.getGalleries();
    const existing = galleries[req.params.id];

    if (!existing) return res.status(404).json({ ok: false, error: 'Halaman galeri tidak ditemukan.' });

    galleries[req.params.id] = schema.sanitizeGallery(req.body, existing);

    try {
      await store.saveGalleries(galleries);
    } catch (error) {
      return res.status(500).json({ ok: false, error: `Gagal menyimpan: ${error.message}` });
    }

    return res.json({ ok: true, gallery: galleries[req.params.id] });
  })
);

/* -------------------------------------------------------------- uploads */

/**
 * Unggahan dilakukan browser langsung ke Vercel Blob memakai URL bertanda
 * tangan, karena body request function dibatasi 4.5 MB sedangkan berkas di
 * sini boleh sampai 40 MB.
 *
 *   1. POST /api/media/upload-url     -> dapat URL unggahan bertanda tangan
 *   2. PUT  <uploadUrl> (dari browser) -> berkas dikirim langsung ke Blob
 *   3. POST /api/media/upload-confirm -> server mengambil URL publik resminya
 */
api.post(
  '/media/upload-url',
  auth.requireCsrf,
  wrap(async (req, res) => {
    try {
      const ticket = await media.createUploadTicket({
        name: req.body && req.body.name,
        type: req.body && req.body.type,
        size: Number(req.body && req.body.size),
      });
      return res.json({ ok: true, ...ticket });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  })
);

api.post(
  '/media/upload-confirm',
  auth.requireCsrf,
  wrap(async (req, res) => {
    try {
      const file = await media.confirmUpload(req.body && req.body.pathname);
      return res.json({ ok: true, ...file });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  })
);

api.get(
  '/media',
  wrap(async (req, res) => {
    const [uploads, library] = await Promise.all([media.listUploads(), media.listMediaLibrary()]);
    res.json({
      ok: true,
      uploads,
      library,
      maxFileSize: media.MAX_FILE_SIZE,
      blobConfigured: media.isConfigured(),
    });
  })
);

api.delete(
  '/media',
  auth.requireCsrf,
  wrap(async (req, res) => {
    try {
      const removed = await media.removeUpload(req.body && req.body.url);
      return res.json({ ok: true, removed });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  })
);

/* ------------------------------------------------------- ganti password */

api.post(
  '/password',
  auth.requireCsrf,
  wrap(async (req, res) => {
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

    await auth.setPassword(next);

    // Perbarui token CSRF setelah password berubah.
    const csrfToken = auth.rotateCsrfToken(req) || auth.getCsrfToken(req);

    return res.json({ ok: true, csrfToken, message: 'Password berhasil diganti.' });
  })
);

/* --------------------------------------------------------- backup data */

api.get(
  '/export',
  wrap(async (req, res) => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      content: await store.getContent(),
      galleries: await store.getGalleries(),
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="portfolio-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.send(JSON.stringify(payload, null, 2));
  })
);

api.post(
  '/import',
  auth.requireCsrf,
  wrap(async (req, res) => {
    const body = req.body || {};
    if (!body.content || typeof body.content !== 'object') {
      return res.status(400).json({ ok: false, error: 'File backup tidak valid (bagian "content" tidak ada).' });
    }

    // Semua bagian tetap dibersihkan lewat skema yang sama seperti input manual.
    const cleaned = {};
    for (const [section, sanitizer] of Object.entries(schema.CONTENT_SECTIONS)) {
      cleaned[section] = sanitizer(body.content[section] || {});
    }

    const currentGalleries = await store.getGalleries();
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
  })
);

app.use('/api', api);

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.' }));

/* ============================================================== 404 ===== */

app.use((req, res) => res.status(404).render('not-found', { pageTitle: 'Halaman tidak ditemukan' }));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  // Body yang tidak bisa dibaca (mis. JSON rusak atau Content-Type keliru)
  // adalah kesalahan pengirim, bukan kesalahan server — jangan dilaporkan
  // sebagai 500 supaya penyebabnya tidak menyesatkan.
  const status = Number(error.status || error.statusCode) >= 400 && Number(error.status || error.statusCode) < 500
    ? Number(error.status || error.statusCode)
    : 500;

  console.error(`✖  Error (${status}):`, error.message);

  if (status === 500) {
    return req.path.startsWith('/api/')
      ? res.status(500).json({ ok: false, error: 'Terjadi kesalahan di server.' })
      : res.status(500).type('text/plain').send('Terjadi kesalahan di server.');
  }

  return req.path.startsWith('/api/')
    ? res.status(status).json({ ok: false, error: 'Data yang dikirim tidak bisa dibaca.' })
    : res.status(status).type('text/plain').send('Data yang dikirim tidak bisa dibaca.');
});

/* ============================================================= start ==== */

for (const notice of config.notices) console.log(`  ℹ  ${notice}`);

/* Kredensial yang baru dibuat dicetak SEBELUM server menyala, supaya tidak
   pernah hilang walau server gagal start. Hanya terjadi saat lokal karena
   di Vercel password diambil dari environment variable. */
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

/**
 * Di Vercel, file ini dijalankan sebagai satu function: cukup mengekspor app
 * dan JANGAN memanggil listen (Vercel yang menyediakan soketnya).
 */
module.exports = app;

if (require.main === module) {
  const server = app.listen(config.port, () => {
    const line = '─'.repeat(64);
    console.log(`\n${line}`);
    console.log('  Website Portofolio — Rangga Febrianto');
    console.log(line);
    console.log(`\n  Website  : http://localhost:${config.port}/`);
    console.log(`  Admin    : http://localhost:${config.port}/admin`);
    console.log(`  Data     : ${store.isRemote() ? 'Redis' : 'file data/*.json'}`);
    console.log(`  Media    : ${media.isConfigured() ? 'Vercel Blob' : 'folder images/'}`);
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

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
