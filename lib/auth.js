/**
 * lib/auth.js
 * ---------------------------------------------------------------------------
 * Autentikasi admin:
 *  - password disimpan sebagai hash bcrypt (tidak pernah sebagai teks biasa)
 *  - sesi login disimpan di cookie HttpOnly + SameSite yang ditandatangani
 *    (stateless, jadi tetap jalan di Vercel yang tidak punya disk)
 *  - percobaan login dibatasi (rate limit) untuk mencegah brute force
 *  - setiap permintaan yang mengubah data wajib menyertakan CSRF token
 *
 * Password yang diganti dari dashboard disimpan di Redis (kalau tersedia)
 * supaya berlaku untuk semua instance; kalau tidak, disimpan ke .env lokal.
 * ---------------------------------------------------------------------------
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { loadConfig, setEnvValue, isValidHash, BCRYPT_ROUNDS } = require('./config');
const redis = require('./redis');

const config = loadConfig();

const HASH_KEY = 'portfolio:admin:hash';
const SESSION_KEY = 'admin';

/** Kredensial aktif (hash bisa ditimpa oleh nilai di Redis). */
const credentials = {
  user: config.adminUser,
  hash: config.adminHash,
  displayName: config.adminDisplayName,
  passwordChangedAt: null,
};

const getCredentials = () => ({
  user: credentials.user,
  displayName: credentials.displayName,
  passwordChangedAt: credentials.passwordChangedAt,
});

/* -------------------------------------------------- hash password aktif -- */

/**
 * Ambil hash yang berlaku: nilai di Redis (hasil ganti password dari
 * dashboard) menang atas nilai di environment variable.
 *
 * Dibaca ULANG setiap kali login (tanpa cache di memori) supaya:
 *   - ganti password dari dashboard LIVE langsung berlaku di semua instance,
 *   - `npm run reset:password` langsung berlaku tanpa deploy ulang,
 *   - password lama tidak lagi diterima setelah diganti.
 * Kalau Redis sedang bermasalah, nilai terakhir yang diketahui dipakai supaya
 * login tidak ikut mati.
 */
const resolveHash = async () => {
  if (redis.isConfigured()) {
    try {
      const stored = await redis.getJson(HASH_KEY);
      // Redis kosong / isinya tidak sah -> kembali ke environment variable.
      credentials.hash = isValidHash(stored) ? stored : config.adminHash;
    } catch (error) {
      console.error(`⚠  Gagal membaca password dari Redis: ${error.message}`);
    }
  }

  return credentials.hash;
};

/**
 * Simpan password baru. Di Vercel hash hanya disimpan di Redis (disk read-only);
 * saat pengembangan lokal hash juga ditulis ke .env supaya tetap ada setelah
 * server dimatikan.
 */
const setPassword = async (plainPassword) => {
  const hash = bcrypt.hashSync(plainPassword, BCRYPT_ROUNDS);
  credentials.hash = hash;
  credentials.passwordChangedAt = new Date().toISOString();

  if (redis.isConfigured()) {
    await redis.setJson(HASH_KEY, hash);
  } else {
    setEnvValue('ADMIN_PASSWORD_HASH', hash);
  }

  return hash;
};

/* ---------------------------------------------------------- rate limiting */

/**
 * Penguncian setelah beberapa kali gagal login. Keberadaannya dikendalikan
 * oleh `LOGIN_RATE_LIMIT` di lib/config.js dan DEFAULT-NYA MATI, supaya salah
 * ketik password tidak mengunci akun sendiri.
 */
const rateLimitEnabled = Boolean(config.loginRateLimit);

const LIMITER = redis.createRateLimiter({
  max: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  namespace: 'portfolio:login',
});

const UNLIMITED = Object.freeze({ blocked: false, retryAfterSeconds: 0, remaining: Infinity });

const checkRateLimit = (key) => (rateLimitEnabled ? LIMITER.status(key) : UNLIMITED);
const recordFailure = (key) => (rateLimitEnabled ? LIMITER.fail(key) : UNLIMITED);
const clearFailures = (key) => (rateLimitEnabled ? LIMITER.clear(key) : Promise.resolve());

/** Apakah penguncian login aktif? Dipakai server & tampilan untuk pesan yang jujur. */
const isRateLimitEnabled = () => rateLimitEnabled;

/* --------------------------------------------------------------- verifikasi */

const safeEqual = (a, b) => {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

/** Selalu jalankan bcrypt.compare walau user salah, agar waktu respons serupa. */
const verifyCredentials = async (user, password) => {
  const hash = await resolveHash();
  const userMatches = safeEqual(String(user || '').trim().toLowerCase(), credentials.user.toLowerCase());
  const hashToCheck = userMatches && hash
    ? hash
    : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';

  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(String(password || ''), hashToCheck);
  } catch {
    passwordMatches = false;
  }

  return userMatches && Boolean(hash) && passwordMatches;
};

/* ------------------------------------------------------------ middleware */

/**
 * Mulai sesi baru. Cookie sesi ditandatangani oleh cookie-session, jadi cukup
 * mengganti isi `req.session` (token CSRF baru selalu dibuat).
 */
const login = async (req, user) => {
  req.session = {
    [SESSION_KEY]: {
      user,
      loginAt: new Date().toISOString(),
      csrf: crypto.randomBytes(32).toString('hex'),
    },
  };
};

/** Akhiri sesi: isi cookie dikosongkan lalu kedaluwarsa. */
const logout = (req) => {
  req.session = null;
};

const isAuthenticated = (req) => Boolean(req.session && req.session[SESSION_KEY]);

const getSession = (req) => (req.session ? req.session[SESSION_KEY] : null);

const getCsrfToken = (req) => (isAuthenticated(req) ? req.session[SESSION_KEY].csrf : null);

/** Halaman admin: belum login -> arahkan ke form login. */
const requireAuthPage = (req, res, next) => {
  if (isAuthenticated(req)) return next();
  const target = req.originalUrl && req.originalUrl.startsWith('/admin') ? req.originalUrl : '/admin';
  return res.redirect(`/admin/login?next=${encodeURIComponent(target)}`);
};

/** API: belum login -> 401 JSON. */
const requireAuthApi = (req, res, next) => {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ ok: false, error: 'Sesi tidak valid. Silakan login ulang.' });
};

/** Semua permintaan yang mengubah data wajib punya CSRF token yang cocok. */
const requireCsrf = (req, res, next) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Sesi tidak valid.' });

  const provided = req.get('x-csrf-token') || (req.body && req.body._csrf) || '';
  if (!provided || !safeEqual(provided, session.csrf)) {
    return res.status(403).json({ ok: false, error: 'Token keamanan (CSRF) tidak cocok. Muat ulang halaman.' });
  }
  return next();
};

/** Buat token CSRF baru untuk sesi yang sedang aktif. */
const rotateCsrfToken = (req) => {
  const session = getSession(req);
  if (!session) return null;
  session.csrf = crypto.randomBytes(32).toString('hex');
  return session.csrf;
};

module.exports = {
  config,
  credentials,
  getCredentials,
  setPassword,
  verifyCredentials,
  checkRateLimit,
  recordFailure,
  clearFailures,
  isRateLimitEnabled,
  login,
  logout,
  isAuthenticated,
  getSession,
  getCsrfToken,
  rotateCsrfToken,
  requireAuthPage,
  requireAuthApi,
  requireCsrf,
  hashPassword: (plain) => bcrypt.hashSync(plain, BCRYPT_ROUNDS),
};
