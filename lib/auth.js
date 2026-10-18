/**
 * lib/auth.js
 * ---------------------------------------------------------------------------
 * Autentikasi admin:
 *  - password disimpan sebagai hash bcrypt (tidak pernah sebagai teks biasa)
 *  - sesi login disimpan di cookie HttpOnly + SameSite
 *  - percobaan login dibatasi (rate limit) untuk mencegah brute force
 *  - setiap permintaan yang mengubah data wajib menyertakan CSRF token
 * ---------------------------------------------------------------------------
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { loadConfig } = require('./config');

const config = loadConfig();

/** Kredensial aktif (bisa berubah saat password diganti dari dashboard). */
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

const setPassword = (plainPassword) => {
  credentials.hash = bcrypt.hashSync(plainPassword, 12);
  credentials.passwordChangedAt = new Date().toISOString();
  return credentials.hash;
};

const setHash = (hash) => {
  credentials.hash = hash;
};

/* ---------------------------------------------------------- rate limiting */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

const attempts = new Map();

const prune = () => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (entry.blockedUntil && entry.blockedUntil < now) attempts.delete(key);
    else if (!entry.blockedUntil && now - entry.firstAt > WINDOW_MS) attempts.delete(key);
  }
};

/**
 * @returns {{ blocked:boolean, retryAfterSeconds:number, remaining:number }}
 */
const checkRateLimit = (key) => {
  prune();
  const entry = attempts.get(key);
  if (!entry) return { blocked: false, retryAfterSeconds: 0, remaining: MAX_ATTEMPTS };

  if (entry.blockedUntil && entry.blockedUntil > Date.now()) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((entry.blockedUntil - Date.now()) / 1000),
      remaining: 0,
    };
  }

  return { blocked: false, retryAfterSeconds: 0, remaining: Math.max(0, MAX_ATTEMPTS - entry.count) };
};

const recordFailure = (key) => {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    return checkRateLimit(key);
  }

  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
  }

  return checkRateLimit(key);
};

const clearFailures = (key) => attempts.delete(key);

/* --------------------------------------------------------------- verifikasi */

const safeEqual = (a, b) => {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

/** Selalu jalankan bcrypt.compare walau user salah, agar waktu respons serupa. */
const verifyCredentials = async (user, password) => {
  const userMatches = safeEqual(String(user || '').trim().toLowerCase(), credentials.user.toLowerCase());
  const hashToCheck = userMatches ? credentials.hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';

  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(String(password || ''), hashToCheck);
  } catch {
    passwordMatches = false;
  }

  return userMatches && passwordMatches;
};

/* ------------------------------------------------------------ middleware */

const SESSION_KEY = 'admin';

const login = (req, user) => {
  return new Promise((resolve, reject) => {
    if (req.session.regenerate) {
      req.session.regenerate((error) => (error ? reject(error) : resolve()));
    } else {
      resolve();
    }
  }).then(() => {
    req.session[SESSION_KEY] = {
      user,
      loginAt: new Date().toISOString(),
      csrf: crypto.randomBytes(32).toString('hex'),
    };
  });
};

const logout = (req) =>
  new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });

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

module.exports = {
  config,
  credentials,
  getCredentials,
  setPassword,
  setHash,
  verifyCredentials,
  checkRateLimit,
  recordFailure,
  clearFailures,
  login,
  logout,
  isAuthenticated,
  getSession,
  getCsrfToken,
  requireAuthPage,
  requireAuthApi,
  requireCsrf,
  hashPassword: (plain) => bcrypt.hashSync(plain, 12),
};
