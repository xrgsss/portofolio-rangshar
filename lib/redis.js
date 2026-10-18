/**
 * lib/redis.js
 * ---------------------------------------------------------------------------
 * Sambungan Redis yang dipakai untuk dua hal:
 *   1. Menyimpan data website (content.json & galleries.json) — karena
 *      filesystem Vercel hanya bisa dibaca, bukan ditulis.
 *   2. Menyimpan penghitung percobaan login, supaya rate limit tetap berlaku
 *      walau function dijalankan di beberapa instance sekaligus.
 *
 * Kredensial bisa datang dalam dua bentuk, dan keduanya didukung:
 *
 *   a. REST API  -> KV_REST_API_URL + KV_REST_API_TOKEN
 *                   (atau UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 *      Dipakai lewat @upstash/redis. Paling cocok untuk serverless karena
 *      tanpa koneksi permanen.
 *
 *   b. TCP       -> REDIS_URL (redis:// atau rediss://)
 *      Dipakai lewat ioredis. Ini bentuk yang diberikan integrasi Redis di
 *      Vercel Marketplace, dan berlaku untuk penyedia Redis mana pun.
 *
 * Kalau keduanya tidak ada (mis. `npm start` di laptop), semua fungsi di sini
 * otomatis memakai penyimpanan lokal:
 *   - data website tetap memakai file di data/*.json
 *   - rate limit memakai memori proses (cukup untuk satu instance)
 * ---------------------------------------------------------------------------
 */

const { Redis } = require('@upstash/redis');
const IORedis = require('ioredis');
const { PLACEHOLDER_VALUE } = require('./env');

const REST_URL_KEYS = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_API_URL'];
const REST_TOKEN_KEYS = ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_API_TOKEN'];
const TCP_URL_KEYS = ['REDIS_URL', 'KV_URL'];

const pickEnv = (keys) => {
  for (const key of keys) {
    const value = process.env[key];
    if (!value) continue;

    const trimmed = String(value).trim();
    if (trimmed && !PLACEHOLDER_VALUE.test(trimmed)) return trimmed;
  }
  return '';
};

/** Bentuk kredensial yang tersedia, atau null kalau belum diatur. */
const credentials = () => {
  const restUrl = pickEnv(REST_URL_KEYS);
  const restToken = pickEnv(REST_TOKEN_KEYS);
  if (restUrl && restToken) return { transport: 'rest', url: restUrl, token: restToken };

  const tcpUrl = pickEnv(TCP_URL_KEYS);
  if (tcpUrl) return { transport: 'tcp', url: tcpUrl };

  return null;
};

/** Apakah Redis sudah dikonfigurasi? */
const isConfigured = () => Boolean(credentials());

/** 'rest' | 'tcp' | null — dipakai untuk memastikan konfigurasi di dashboard. */
const transportName = () => {
  const config = credentials();
  return config ? config.transport : null;
};

/* ------------------------------------------------------------- command ---- */

/**
 * Dua client di bawah punya nama method yang sama tapi tanda tangan berbeda
 * untuk SET + EXPIRE dan TTL. Perbedaan itu dirapikan di sini supaya sisa
 * aplikasi tidak perlu tahu sedang memakai client yang mana.
 */
const restCommands = (client) => ({
  get: (key) => client.get(key),
  set: (key, value) => client.set(key, value),
  setEx: (key, value, seconds) => client.set(key, value, { ex: seconds }),
  incr: (key) => client.incr(key),
  expire: (key, seconds) => client.expire(key, seconds),
  ttl: (key) => client.ttl(key),
  del: (...keys) => client.del(...keys),
});

const tcpCommands = (client) => ({
  get: (key) => client.get(key),
  set: (key, value) => client.set(key, value),
  setEx: (key, value, seconds) => client.set(key, value, 'EX', String(seconds)),
  incr: (key) => client.incr(key),
  expire: (key, seconds) => client.expire(key, String(seconds)),
  ttl: (key) => client.ttl(key),
  del: (...keys) => client.del(...keys),
});

let connection = null;

/**
 * Buat (sekali saja) koneksi Redis.
 * @returns {{ transport:'rest'|'tcp', commands:object } | null}
 */
const getConnection = () => {
  if (connection) return connection;

  const config = credentials();
  if (!config) return null;

  if (config.transport === 'rest') {
    const client = new Redis({ url: config.url, token: config.token });
    connection = { transport: 'rest', commands: restCommands(client) };
    return connection;
  }

  const client = new IORedis(config.url, {
    // Perintah antre dulu selama proses menyambung (jadi permintaan pertama
    // setelah cold start tidak gagal), tapi tidak boleh menggantung lebih dari
    // 5 detik kalau Redis benar-benar tidak bisa dihubungi.
    enableOfflineQueue: true,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 3,
    keepAlive: 10_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  // Tanpa listener ini, error koneksi akan mematikan proses Node.
  client.on('error', (error) => {
    console.error(`⚠  Redis (TCP): ${error.message}`);
  });

  connection = { transport: 'tcp', commands: tcpCommands(client) };
  return connection;
};

/* ------------------------------------------------------------ data JSON --- */

/**
 * Nilai disimpan sebagai teks JSON, dan saat dibaca diurai kembali. Kedua
 * client (REST & TCP) berperilaku sama dengan pola ini.
 *
 * @returns {Promise<any|null>} null kalau Redis belum diatur atau key kosong
 */
const getJson = async (key) => {
  const conn = getConnection();
  if (!conn) return null;

  const raw = await conn.commands.get(key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw; // client REST sudah mengurainya
  if (typeof raw !== 'string') return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const setJson = async (key, value) => {
  const conn = getConnection();
  if (!conn) return false;

  await conn.commands.set(key, JSON.stringify(value));
  return true;
};

const deleteKey = async (key) => {
  const conn = getConnection();
  if (!conn) return false;

  await conn.commands.del(key);
  return true;
};

/* ---------------------------------------------------------- rate limit ---- */

/**
 * Rate limit dua tingkat (penghitung + kunci sementara) yang bisa berjalan
 * di Redis maupun di memori. Dipakai untuk mencegah brute force login.
 */
const memoryState = new Map();

const pruneMemory = (now) => {
  for (const [key, entry] of memoryState) {
    const expired = entry.blockedUntil ? entry.blockedUntil <= now : now - entry.firstAt > entry.windowMs;
    if (expired) memoryState.delete(key);
  }
};

const createRateLimiter = ({ max, windowMs, blockMs, namespace }) => {
  const counterKey = (key) => `${namespace}:count:${key}`;
  const blockKey = (key) => `${namespace}:block:${key}`;

  const memoryStatus = (key) => {
    pruneMemory(Date.now());
    const entry = memoryState.get(key);
    if (!entry) return { blocked: false, retryAfterSeconds: 0, remaining: max };

    if (entry.blockedUntil && entry.blockedUntil > Date.now()) {
      return {
        blocked: true,
        retryAfterSeconds: Math.ceil((entry.blockedUntil - Date.now()) / 1000),
        remaining: 0,
      };
    }

    return { blocked: false, retryAfterSeconds: 0, remaining: Math.max(0, max - entry.count) };
  };

  /**
   * Catat satu percobaan gagal di memori (dipakai saat Redis belum diatur,
   * atau saat Redis sedang tidak bisa dihubungi).
   */
  const memoryFail = (key) => {
    const now = Date.now();
    const entry = memoryState.get(key);
    if (!entry || now - entry.firstAt > windowMs) {
      memoryState.set(key, { count: 1, firstAt: now, windowMs, blockedUntil: 0 });
    } else {
      entry.count += 1;
      if (entry.count >= max) entry.blockedUntil = now + blockMs;
    }
    return memoryStatus(key);
  };

  const redisDown = (error) =>
    console.error(`⚠  Rate limit: Redis tidak bisa dihubungi (${error.message}). Memakai memori.`);

  /**
   * @returns {Promise<{ blocked:boolean, retryAfterSeconds:number, remaining:number }>}
   */
  const status = async (key) => {
    const conn = getConnection();
    if (!conn) return memoryStatus(key);

    try {
      const blockTtl = Number(await conn.commands.ttl(blockKey(key)));
      if (blockTtl > 0) return { blocked: true, retryAfterSeconds: blockTtl, remaining: 0 };

      const count = Number((await conn.commands.get(counterKey(key))) || 0);
      return { blocked: false, retryAfterSeconds: 0, remaining: Math.max(0, max - count) };
    } catch (error) {
      // Login harus tetap bisa dipakai walau Redis mati.
      redisDown(error);
      return memoryStatus(key);
    }
  };

  /** Catat satu percobaan gagal, lalu kembalikan status terbaru. */
  const fail = async (key) => {
    const conn = getConnection();
    if (!conn) return memoryFail(key);

    try {
      const blockTtl = Number(await conn.commands.ttl(blockKey(key)));
      if (blockTtl > 0) return { blocked: true, retryAfterSeconds: blockTtl, remaining: 0 };

      const count = Number(await conn.commands.incr(counterKey(key)));
      if (count === 1) await conn.commands.expire(counterKey(key), Math.ceil(windowMs / 1000));

      if (count >= max) {
        await conn.commands.setEx(blockKey(key), '1', Math.ceil(blockMs / 1000));
        await conn.commands.del(counterKey(key));
        return { blocked: true, retryAfterSeconds: Math.ceil(blockMs / 1000), remaining: 0 };
      }

      return { blocked: false, retryAfterSeconds: 0, remaining: Math.max(0, max - count) };
    } catch (error) {
      redisDown(error);
      return memoryFail(key);
    }
  };

  /** Hapus catatan percobaan (dipakai setelah login berhasil). */
  const clear = async (key) => {
    memoryState.delete(key);

    const conn = getConnection();
    if (!conn) return;

    try {
      await conn.commands.del(counterKey(key), blockKey(key));
    } catch (error) {
      redisDown(error);
    }
  };

  return { status, fail, clear };
};

module.exports = {
  isConfigured,
  transportName,
  getConnection,
  getJson,
  setJson,
  deleteKey,
  createRateLimiter,
};
