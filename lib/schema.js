/**
 * lib/schema.js
 * ---------------------------------------------------------------------------
 * Validasi + pembersihan data yang dikirim dari dashboard admin.
 *
 * Semua data dari browser dianggap TIDAK dipercaya:
 *  - tipe data dipaksa sesuai bentuk yang diharapkan
 *  - panjang teks dibatasi
 *  - URL berbahaya (javascript:, data:, vbscript:) ditolak
 *  - jumlah item per daftar dibatasi
 * ---------------------------------------------------------------------------
 */

const MAX_TEXT = 4000;
const MAX_URL = 800;
const MAX_ITEMS = 800;

const sanitizeText = (value, max = MAX_TEXT) => {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').trim().slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

/** Teks satu baris (tanpa baris baru). */
const sanitizeLine = (value, max = 400) => sanitizeText(value, max).replace(/\s*\n+\s*/g, ' ');

const FORBIDDEN_URL_SCHEME = /^\s*(javascript|vbscript|data|blob|file)\s*:/i;

/**
 * URL yang diizinkan: relatif (images/..., portfolio-x.html, #anchor),
 * http/https, mailto, tel. Sisanya dikosongkan.
 */
const sanitizeUrl = (value, max = MAX_URL) => {
  const raw = sanitizeText(value, max);
  if (!raw) return '';
  if (FORBIDDEN_URL_SCHEME.test(raw)) return '';
  if (/^\/\//.test(raw)) return ''; // protocol-relative -> hindari open redirect

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return /^(https?|mailto|tel):/i.test(raw) ? raw : '';
  }

  return raw;
};

const sanitizeId = (value, fallback = '') => {
  const raw = sanitizeLine(value, 60).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return raw || fallback;
};

const sanitizeList = (value, mapper, max = MAX_ITEMS) => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(mapper);
};

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/* ------------------------------------------------------------------ bagian */

const sanitizeMeta = (input) => {
  const data = asObject(input);
  return { siteTitle: sanitizeLine(data.siteTitle, 160) };
};

const sanitizeLink = (input) => {
  const data = asObject(input);
  return { label: sanitizeLine(data.label, 120), href: sanitizeUrl(data.href) };
};

const sanitizeHero = (input) => {
  const data = asObject(input);
  const rail = asObject(data.socialRail);

  return {
    eyebrow: sanitizeLine(data.eyebrow, 120),
    title: sanitizeLine(data.title, 160),
    role: sanitizeLine(data.role, 240),
    lede: sanitizeList(data.lede, (item) => sanitizeText(item, 1200), 12),
    image: sanitizeUrl(data.image),
    imageAlt: sanitizeLine(data.imageAlt, 200),
    ctaLabel: sanitizeLine(data.ctaLabel, 80),
    ctaHref: sanitizeUrl(data.ctaHref),
    socialRail: {
      label: sanitizeLine(rail.label, 80),
      href: sanitizeUrl(rail.href),
      caption: sanitizeLine(rail.caption, 80),
    },
    navLinks: sanitizeList(data.navLinks, sanitizeLink, 20),
  };
};

const sanitizeAbout = (input) => {
  const data = asObject(input);
  return {
    kicker: sanitizeLine(data.kicker, 120),
    heading: sanitizeLine(data.heading, 200),
    body: sanitizeList(data.body, (item) => sanitizeText(item, 1200), 12),
    image: sanitizeUrl(data.image),
    imageAlt: sanitizeLine(data.imageAlt, 200),
    buttons: sanitizeList(
      data.buttons,
      (item) => {
        const button = asObject(item);
        return {
          variant: button.variant === 'ghost' ? 'ghost' : 'primary',
          label: sanitizeLine(button.label, 80),
          href: sanitizeUrl(button.href),
        };
      },
      8
    ),
  };
};

const sanitizeSpecialties = (input) => {
  const data = asObject(input);
  return {
    kicker: sanitizeLine(data.kicker, 120),
    heading: sanitizeLine(data.heading, 200),
    items: sanitizeList(data.items, (item) => {
      const entry = asObject(item);
      return {
        pill: sanitizeLine(entry.pill, 60),
        title: sanitizeLine(entry.title, 160),
        body: sanitizeText(entry.body, 1500),
      };
    }),
  };
};

const sanitizePortfolio = (input) => {
  const data = asObject(input);
  return {
    kicker: sanitizeLine(data.kicker, 120),
    heading: sanitizeLine(data.heading, 200),
    items: sanitizeList(data.items, (item) => {
      const entry = asObject(item);
      return {
        label: sanitizeLine(entry.label, 120),
        href: sanitizeUrl(entry.href),
        galleryId: sanitizeId(entry.galleryId),
        gallerySource: sanitizeUrl(entry.gallerySource),
        cover: sanitizeUrl(entry.cover),
        coverAlt: sanitizeLine(entry.coverAlt, 200),
      };
    }),
  };
};

const sanitizeExperience = (input) => {
  const data = asObject(input);
  return {
    kicker: sanitizeLine(data.kicker, 120),
    heading: sanitizeLine(data.heading, 200),
    items: sanitizeList(data.items, (item) => {
      const entry = asObject(item);
      return {
        title: sanitizeLine(entry.title, 200),
        company: sanitizeLine(entry.company, 200),
        period: sanitizeLine(entry.period, 80),
      };
    }),
  };
};

const sanitizeTools = (input) => {
  const data = asObject(input);
  return {
    kicker: sanitizeLine(data.kicker, 120),
    heading: sanitizeLine(data.heading, 200),
    items: sanitizeList(data.items, (item) => {
      const entry = asObject(item);
      return {
        name: sanitizeLine(entry.name, 120),
        logo: sanitizeUrl(entry.logo),
        logoAlt: sanitizeLine(entry.logoAlt, 200),
      };
    }),
  };
};

const sanitizeContact = (input) => {
  const data = asObject(input);
  const button = asObject(data.button);
  return {
    socialKicker: sanitizeLine(data.socialKicker, 120),
    socials: sanitizeList(data.socials, sanitizeLink, 20),
    kicker: sanitizeLine(data.kicker, 120),
    heading: sanitizeLine(data.heading, 200),
    button: { label: sanitizeLine(button.label, 80), href: sanitizeUrl(button.href) },
  };
};

/** Peta nama bagian -> fungsi pembersih. Hanya kunci ini yang boleh diubah. */
const CONTENT_SECTIONS = {
  meta: sanitizeMeta,
  hero: sanitizeHero,
  about: sanitizeAbout,
  specialties: sanitizeSpecialties,
  portfolio: sanitizePortfolio,
  experience: sanitizeExperience,
  tools: sanitizeTools,
  contact: sanitizeContact,
};

const GALLERY_VARIANTS = new Set(['default', 'web', 'flutter']);

const sanitizeGalleryItem = (input) => {
  const entry = asObject(input);
  const type = entry.type === 'video' ? 'video' : 'image';
  return {
    type,
    src: sanitizeUrl(entry.src),
    alt: sanitizeLine(entry.alt, 240),
    caption: sanitizeLine(entry.caption, 240),
    href: sanitizeUrl(entry.href),
  };
};

/**
 * Membersihkan satu halaman galeri. `existing` dipakai supaya id/file/href
 * tidak bisa dibajak dari dashboard (hanya judul & isi yang boleh berubah).
 */
const sanitizeGallery = (input, existing = {}) => {
  const data = asObject(input);
  const variant = GALLERY_VARIANTS.has(data.variant) ? data.variant : existing.variant || 'default';

  return {
    id: sanitizeId(existing.id || data.id),
    file: existing.file || sanitizeLine(data.file, 120),
    href: existing.href || sanitizeLine(data.href, 120),
    variant,
    kicker: sanitizeLine(data.kicker, 120),
    title: sanitizeLine(data.title, 200),
    description: sanitizeText(data.description, 1000),
    sections: sanitizeList(
      data.sections,
      (section) => {
        const group = asObject(section);
        return {
          title: sanitizeLine(group.title, 160),
          items: sanitizeList(group.items, sanitizeGalleryItem),
        };
      },
      60
    ),
  };
};

module.exports = {
  sanitizeText,
  sanitizeLine,
  sanitizeUrl,
  sanitizeId,
  sanitizeList,
  CONTENT_SECTIONS,
  sanitizeGallery,
  sanitizeMeta,
  sanitizeHero,
  sanitizeAbout,
  sanitizeSpecialties,
  sanitizePortfolio,
  sanitizeExperience,
  sanitizeTools,
  sanitizeContact,
};
