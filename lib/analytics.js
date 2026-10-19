/**
 * lib/analytics.js
 * ---------------------------------------------------------------------------
 * Pencatat kunjungan halaman publik (page view) untuk grafik "Pengunjung
 * Website" di dashboard admin.
 *
 * Prinsipnya:
 *   - Hanya MENGHITUNG angka. Tidak ada IP, tidak ada cookie, tidak ada data
 *     pribadi yang disimpan — jadi aman dari sisi privasi.
 *   - Satu kunjungan = satu permintaan ke halaman publik ( `/` atau
 *     `/portfolio-*.html` ). Aset statis, halaman admin, dan API tidak dihitung.
 *   - Angka disimpan sebagai penghitung per jam + per hari + total.
 *     Memakai INCR di Redis sehingga aman walau banyak instance berjalan
 *     sekaligus (Vercel). Tanpa Redis (laptop), angkanya disimpan di
 *     data/analytics.json.
 *   - Bucket waktu memakai zona WIB (UTC+7) yang tetap, supaya label grafik
 *     sama antara saat dijalankan di laptop dan saat di Vercel (UTC).
 *
 * Data lama dibuang otomatis: bucket per jam disimpan 8 hari, per hari 400 hari.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const redis = require('./redis');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');

const TOTAL_KEY = 'portfolio:pv:total';
const hourKeyOf = (hour) => `portfolio:pv:h:${hour}`;
const dayKeyOf = (day) => `portfolio:pv:d:${day}`;

const HOUR_TTL_SECONDS = 60 * 60 * 24 * 8; // 8 hari
const DAY_TTL_SECONDS = 60 * 60 * 24 * 400; // 400 hari

/** Offset zona waktu tetap (WIB = UTC+7) supaya bucket konsisten di mana pun. */
const TZ_OFFSET_MINUTES = 7 * 60;
const TZ_LABEL = 'UTC+7 (WIB)';

const pad = (value) => String(value).padStart(2, '0');

/** Geser waktu ke zona WIB, lalu pakai getUTC* supaya tidak bergantung TZ mesin. */
const shifted = (date) => new Date(date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);

const hourKey = (date) => {
  const d = shifted(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
};

const dayKey = (date) => {
  const d = shifted(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

const hourLabel = (date) => {
  const d = shifted(date);
  return `${pad(d.getUTCHours())}:00`;
};

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* ------------------------------------------------ penyimpanan file lokal --- */

/**
 * Bentuk data file lokal:
 *   { total: 123, hours: { "2026101917": 5, ... }, days: { "20261019": 30, ... } }
 *
 * Hanya dipakai saat Redis belum diatur (pengembangan lokal). Satu instance,
 * jadi cukup antrean tulis sederhana seperti di lib/store.js.
 */
const emptyFileData = () => ({ total: 0, hours: {}, days: {} });

const readFileData = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyFileData();
    return {
      total: toNumber(parsed.total),
      hours: parsed.hours && typeof parsed.hours === 'object' ? parsed.hours : {},
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`⚠  Gagal membaca ${path.basename(ANALYTICS_FILE)}: ${error.message}`);
    }
    return emptyFileData();
  }
};

const writeFileData = (data) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${ANALYTICS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, ANALYTICS_FILE);
  } catch (error) {
    console.error(`⚠  Gagal menulis ${path.basename(ANALYTICS_FILE)}: ${error.message}`);
  }
};

let writeChain = Promise.resolve();
const enqueue = (task) => {
  writeChain = writeChain.then(task, task);
  return writeChain;
};

/** Buang bucket yang sudah kedaluwarsa (perbandingan teks aman karena lebarnya tetap). */
const pruneFileData = (data, now) => {
  const minHour = hourKey(new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000));
  const minDay = dayKey(new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000));

  for (const key of Object.keys(data.hours)) {
    if (key < minHour) delete data.hours[key];
  }
  for (const key of Object.keys(data.days)) {
    if (key < minDay) delete data.days[key];
  }
};

/* --------------------------------------------------------------- pencatatan */

/** Catat satu kunjungan. Sengaja tidak pernah melempar error ke pemanggil. */
const recordView = async (now = new Date()) => {
  const hour = hourKey(now);
  const day = dayKey(now);

  const conn = redis.isConfigured() ? redis.getConnection() : null;

  if (conn) {
    try {
      const total = await conn.commands.incr(TOTAL_KEY);
      if (total === 1) await conn.commands.expire(TOTAL_KEY, DAY_TTL_SECONDS);

      const inHour = await conn.commands.incr(hourKeyOf(hour));
      if (inHour === 1) await conn.commands.expire(hourKeyOf(hour), HOUR_TTL_SECONDS);

      const inDay = await conn.commands.incr(dayKeyOf(day));
      if (inDay === 1) await conn.commands.expire(dayKeyOf(day), DAY_TTL_SECONDS);
      return;
    } catch (error) {
      console.error(`⚠  Gagal mencatat kunjungan di Redis (${error.message}). Memakai file lokal.`);
    }
  }

  await enqueue(() => {
    const data = readFileData();
    data.total += 1;
    data.hours[hour] = toNumber(data.hours[hour]) + 1;
    data.days[day] = toNumber(data.days[day]) + 1;
    pruneFileData(data, now);
    writeFileData(data);
  });
};

/* -------------------------------------------------------------- pelaporan */

/**
 * Laporan untuk grafik dashboard: deret per jam (default 24 jam terakhir,
 * termasuk jam yang sedang berjalan) beserta ringkasan Total / Hari ini / Jam ini.
 *
 * @param {{ hours?: number }} [options]
 */
const getReport = async ({ hours = 24 } = {}) => {
  const count = Math.max(1, Math.min(168, Number(hours) || 24));
  const now = new Date();

  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const at = new Date(now.getTime() - i * 60 * 60 * 1000);
    buckets.push({ hour: hourKey(at), label: hourLabel(at) });
  }

  const today = dayKey(now);
  let total = 0;
  let todayCount = 0;
  let hourCounts = [];
  let storage = 'file-lokal';

  const conn = redis.isConfigured() ? redis.getConnection() : null;

  if (conn) {
    storage = `redis (${redis.transportName()})`;
    try {
      const [totalRaw, todayRaw, ...hourRaw] = await conn.commands.mget(
        TOTAL_KEY,
        dayKeyOf(today),
        ...buckets.map((bucket) => hourKeyOf(bucket.hour))
      );
      total = toNumber(totalRaw);
      todayCount = toNumber(todayRaw);
      hourCounts = hourRaw.map(toNumber);
    } catch (error) {
      console.error(`⚠  Gagal membaca statistik dari Redis (${error.message}). Memakai file lokal.`);
      storage = 'file-lokal';
      const data = readFileData();
      total = data.total;
      todayCount = toNumber(data.days[today]);
      hourCounts = buckets.map((bucket) => toNumber(data.hours[bucket.hour]));
    }
  } else {
    const data = readFileData();
    total = data.total;
    todayCount = toNumber(data.days[today]);
    hourCounts = buckets.map((bucket) => toNumber(data.hours[bucket.hour]));
  }

  return {
    updatedAt: now.toISOString(),
    timezone: TZ_LABEL,
    storage,
    summary: {
      total,
      today: todayCount,
      thisHour: hourCounts[hourCounts.length - 1] || 0,
    },
    hours: buckets.map((bucket, index) => ({ label: bucket.label, count: hourCounts[index] || 0 })),
  };
};

module.exports = {
  recordView,
  getReport,
  ANALYTICS_FILE,
  TZ_OFFSET_MINUTES,
};
