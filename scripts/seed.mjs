/**
 * scripts/seed.mjs
 * ---------------------------------------------------------------------------
 * Membaca HTML statis yang sudah ada (index.html + portfolio-*.html) lalu
 * mengubahnya menjadi data terstruktur:
 *
 *   data/content.json    -> konten halaman utama (hero, about, dst.)
 *   data/galleries.json  -> konten halaman portfolio (galeri per kategori)
 *
 * Jalankan: npm run seed
 *
 * Script ini AMAN dijalankan berulang. Secara default ia TIDAK menimpa data
 * yang sudah ada supaya perubahan dari dashboard admin tidak hilang. Gunakan
 * `npm run seed -- --force` untuk menimpa paksa.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LEGACY_DIR = path.join(ROOT, 'legacy');

const force = process.argv.includes('--force');

/* ------------------------------------------------------------------ utils */

/**
 * Sumber HTML asli. File berada di root proyek; bila sudah dipindahkan
 * (mis. ke folder legacy/) maka dicari di sana.
 */
const resolveSource = (file) => {
  const rootFile = path.join(ROOT, file);
  if (fsSync.existsSync(rootFile)) return rootFile;
  const legacyFile = path.join(LEGACY_DIR, path.basename(file));
  if (fsSync.existsSync(legacyFile)) return legacyFile;
  return rootFile;
};

const readText = async (file) => fs.readFile(resolveSource(file), 'utf8');

const decodeEntities = (value = '') =>
  value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");

const clean = (value = '') => decodeEntities(value).replace(/\s+/g, ' ').trim();

/** Ambil nilai sebuah atribut dari sebuah tag HTML. */
const getAttr = (tag = '', name) => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match ? match[1] ?? match[2] ?? '' : '';
};

/** Semua kemunculan sebuah pola (global). */
const matchAll = (source, pattern) => {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  return [...source.matchAll(re)];
};

/**
 * Ambil blok elemen berdasarkan indeks awal `<tag ...>` dan cari penutupnya.
 * Aman untuk markup galeri karena item tidak memiliki elemen bersarang
 * dengan nama tag yang sama.
 */
const readBlock = (source, startIndex, tagName) => {
  const closeTag = `</${tagName}>`;
  const end = source.indexOf(closeTag, startIndex);
  if (end === -1) return { block: source.slice(startIndex), next: source.length };
  return { block: source.slice(startIndex, end + closeTag.length), next: end + closeTag.length };
};

/* --------------------------------------------------- index.html extraction */

const extractIndex = (html) => {
  const slice = (from, to) => {
    const start = html.indexOf(from);
    if (start === -1) return '';
    const end = to ? html.indexOf(to, start + from.length) : -1;
    return end === -1 ? html.slice(start) : html.slice(start, end);
  };

  const heroBlock = slice('<section class="hero', '<section class="about');
  const aboutBlock = slice('<section class="about', '<section class="specialties');
  const specialtiesBlock = slice('<section class="specialties', '<section class="portfolio');
  const portfolioBlock = slice('<section class="portfolio', '<section class="experience-section');
  const experienceBlock = slice('<section class="experience-section', '<section class="tools-section');
  const toolsBlock = slice('<section class="tools-section', '<section class="cta reveal"');
  const contactBlock = slice('<section class="cta reveal"');

  /* ---------------------------------------------------------------- hero */
  const heroHeading = heroBlock.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const heroImg = heroBlock.match(/class="hero-blob"[\s\S]*?<img\s+([^>]+)>/i);
  const heroCta = heroBlock.match(/<a class="btn primary"([^>]*)>([\s\S]*?)<\/a>/i);
  const socialRail = heroBlock.match(/<a class="social-link"([^>]*)>([\s\S]*?)<\/a>/i);
  const railLabel = heroBlock.match(/<span class="rail-label">([\s\S]*?)<\/span>/i);

  const hero = {
    eyebrow: clean(heroBlock.match(/<p class="eyebrow">([\s\S]*?)<\/p>/i)?.[1] ?? 'Hello,'),
    title: clean(heroHeading?.[1] ?? ''),
    role: clean(heroBlock.match(/<p class="role">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    lede: matchAll(heroBlock, /<p class="lede">([\s\S]*?)<\/p>/i).map((m) => clean(m[1])),
    image: getAttr(heroImg?.[1] ?? '', 'src'),
    imageAlt: getAttr(heroImg?.[1] ?? '', 'alt'),
    ctaLabel: clean(heroCta?.[2] ?? "Let's talk"),
    ctaHref: getAttr(heroCta?.[1] ?? '', 'href') || '#contact',
    socialRail: {
      label: clean(socialRail?.[2] ?? ''),
      href: getAttr(socialRail?.[1] ?? '', 'href'),
      caption: clean(railLabel?.[1] ?? ''),
    },
    navLinks: matchAll(heroBlock, /<div class="hero-links">([\s\S]*?)<\/div>/i)
      .flatMap((m) => matchAll(m[1], /<a([^>]*)>([\s\S]*?)<\/a>/i))
      .map((m) => ({ label: clean(m[2]), href: getAttr(m[1], 'href') })),
  };

  /* --------------------------------------------------------------- about */
  const aboutHeading = aboutBlock.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const aboutImg = aboutBlock.match(/<div class="photo-frame">\s*<img\s+([^>]+)>/i);
  const aboutButtons = matchAll(aboutBlock, /<a class="btn (primary|ghost)"([^>]*)>([\s\S]*?)<\/a>/i);

  const about = {
    kicker: clean(aboutBlock.match(/<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    heading: clean(aboutHeading?.[1] ?? ''),
    body: matchAll(aboutBlock, /<div class="about-copy">[\s\S]*?<p>([\s\S]*?)<\/p>/i).map((m) => clean(m[1])),
    image: getAttr(aboutImg?.[1] ?? '', 'src'),
    imageAlt: getAttr(aboutImg?.[1] ?? '', 'alt'),
    buttons: aboutButtons.map((m) => ({
      variant: m[1] === 'primary' ? 'primary' : 'ghost',
      label: clean(m[3]),
      href: getAttr(m[2], 'href'),
    })),
  };

  /* --------------------------------------------------------- specialties */
  const cardTagRe = /<article class="card reveal"[^>]*>/gi;
  const specialties = {
    kicker: clean(specialtiesBlock.match(/<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    heading: clean(specialtiesBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
    items: [],
  };

  for (const match of specialtiesBlock.matchAll(cardTagRe)) {
    const { block } = readBlock(specialtiesBlock, match.index, 'article');
    specialties.items.push({
      pill: clean(block.match(/<div class="pill">([\s\S]*?)<\/div>/i)?.[1] ?? ''),
      title: clean(block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? ''),
      body: clean(block.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    });
  }

  /* ----------------------------------------------------------- portfolio */
  const folioTagRe = /<a class="folio-card reveal"[^>]*>/gi;
  const portfolio = {
    kicker: clean(portfolioBlock.match(/<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    heading: clean(portfolioBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
    items: [],
  };

  for (const match of portfolioBlock.matchAll(folioTagRe)) {
    const { block } = readBlock(portfolioBlock, match.index, 'a');
    const imgTag = block.match(/<img\s+([^>]+)>/i)?.[1] ?? '';
    portfolio.items.push({
      label: clean(block.match(/<span>([\s\S]*?)<\/span>/i)?.[1] ?? ''),
      href: getAttr(match[0], 'href'),
      galleryId: '', // diisi di bawah setelah galleries.json terbentuk
      gallerySource: getAttr(match[0], 'data-gallery-source'),
      cover: getAttr(imgTag, 'src'),
      coverAlt: getAttr(imgTag, 'alt'),
    });
  }

  /* ---------------------------------------------------------- experience */
  const expTagRe = /<article class="experience-card reveal"[^>]*>/gi;
  const experience = {
    kicker: clean(experienceBlock.match(/<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    heading: clean(experienceBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
    items: [],
  };

  for (const match of experienceBlock.matchAll(expTagRe)) {
    const { block } = readBlock(experienceBlock, match.index, 'article');
    experience.items.push({
      title: clean(block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? ''),
      company: clean(block.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? ''),
      period: clean(block.match(/<span>([\s\S]*?)<\/span>/i)?.[1] ?? ''),
    });
  }

  /* --------------------------------------------------------------- tools */
  const tools = {
    kicker: clean(toolsBlock.match(/<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    heading: clean(toolsBlock.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
    items: matchAll(toolsBlock, /<div class="tool-chip reveal"[^>]*aria-label="([^"]*)"[^>]*>\s*<img\s+([^>]+)>/i).map(
      (m) => ({
        name: clean(m[1]),
        logo: getAttr(m[2], 'src'),
        logoAlt: getAttr(m[2], 'alt'),
      })
    ),
  };

  /* ------------------------------------------------------------- contact */
  const contact = {
    socialKicker: clean(contactBlock.match(/<div class="cta-social">[\s\S]*?<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    socials: matchAll(contactBlock, /<div class="social-inline">([\s\S]*?)<\/div>/i)
      .flatMap((m) => matchAll(m[1], /<a([^>]*)>([\s\S]*?)<\/a>/i))
      .map((m) => ({ label: clean(m[2]), href: getAttr(m[1], 'href') })),
    kicker: clean(contactBlock.match(/<div class="cta-main">[\s\S]*?<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    heading: clean(contactBlock.match(/<div class="cta-main">[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
    button: {
      label: clean(contactBlock.match(/<a class="btn ghost"([^>]*)>([\s\S]*?)<\/a>/i)?.[2] ?? ''),
      href: getAttr(contactBlock.match(/<a class="btn ghost"([^>]*)>/i)?.[1] ?? '', 'href'),
    },
  };

  return {
    meta: {
      siteTitle: clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''),
    },
    hero,
    about,
    specialties,
    portfolio,
    experience,
    tools,
    contact,
  };
};

/* ------------------------------------------- portfolio-*.html extraction */

const extractGallery = (html, { id, file }) => {
  const variant = /class="[^"]*flutter-gallery/.test(html)
    ? 'flutter'
    : /class="[^"]*web-gallery/.test(html)
      ? 'web'
      : 'default';

  const heroBlock = html.match(/<section class="gallery-hero reveal">([\s\S]*?)<\/section>/i)?.[1] ?? '';

  const gallery = {
    id,
    file,
    href: file,
    variant,
    kicker: clean(heroBlock.match(/<p class="section-kicker">([\s\S]*?)<\/p>/i)?.[1] ?? 'Portfolio'),
    title: clean(heroBlock.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? id),
    description: clean(heroBlock.match(/<h1[\s\S]*?<p>([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    sections: [],
  };

  // Setiap <section> setelah hero berisi satu kelompok galeri.
  for (const sectionMatch of html.matchAll(/<section class="([^"]*)">([\s\S]*?)<\/section>/gi)) {
    const classes = sectionMatch[1];
    if (classes.includes('gallery-hero')) continue;

    const body = sectionMatch[2];
    if (body.indexOf('class="gallery-grid"') === -1) continue;

    // Item galeri bersarang di dalam grid, jadi pemindaian dilakukan pada
    // seluruh isi section (grid adalah satu-satunya daftar di dalamnya).
    const gridBlock = body;

    const items = [];
    const itemRe = /<(a|div) class="gallery-item[^"]*"[^>]*>/gi;

    for (const itemMatch of gridBlock.matchAll(itemRe)) {
      const tagName = itemMatch[1];
      const { block } = readBlock(gridBlock, itemMatch.index, tagName);

      const imgTag = block.match(/<img\s+([^>]*?)\/?>/i)?.[1];
      const videoTag = block.match(/<video\s+([^>]*?)>/i)?.[1];
      if (!imgTag && !videoTag) continue;

      const sourceTag = imgTag || videoTag;

      items.push({
        type: imgTag ? 'image' : 'video',
        src: getAttr(sourceTag, 'src'),
        alt: getAttr(sourceTag, 'alt'),
        caption: clean(block.match(/<span>([\s\S]*?)<\/span>/i)?.[1] ?? ''),
        href: tagName.toLowerCase() === 'a' ? getAttr(itemMatch[0], 'href') : '',
      });
    }

    if (!items.length) continue;

    gallery.sections.push({
      title: clean(body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
      items,
    });
  }

  return gallery;
};

/* ------------------------------------------------------------------- main */

const GALLERY_FILES = [
  { id: 'graphic', file: 'portfolio-graphic.html' },
  { id: 'photo', file: 'portfolio-photo.html' },
  { id: 'web', file: 'portfolio-web.html' },
  { id: 'flutter', file: 'portfolio-flutter.html' },
  { id: '3d', file: 'portfolio-3d.html' },
];

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

const fileExists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  const contentFile = path.join(DATA_DIR, 'content.json');
  const galleriesFile = path.join(DATA_DIR, 'galleries.json');

  if (!force && ((await fileExists(contentFile)) || (await fileExists(galleriesFile)))) {
    console.log('⚠  data/content.json atau data/galleries.json sudah ada.');
    console.log('   Jalankan `npm run seed -- --force` bila ingin menimpa dengan isi HTML asli.');
    return;
  }

  const indexHtml = await readText('index.html');
  const content = extractIndex(indexHtml);

  const galleries = {};
  for (const entry of GALLERY_FILES) {
    const html = await readText(entry.file);
    galleries[entry.id] = extractGallery(html, entry);
  }

  // Hubungkan kartu portfolio di halaman utama dengan data galeri.
  for (const item of content.portfolio.items) {
    const match = Object.values(galleries).find(
      (g) => g.file === item.gallerySource || g.href === item.href
    );
    if (match) {
      item.galleryId = match.id;
      item.gallerySource = match.href;
    }
  }

  await writeJson(contentFile, content);
  await writeJson(galleriesFile, galleries);

  const itemCount = Object.values(galleries).reduce(
    (total, g) => total + g.sections.reduce((sum, s) => sum + s.items.length, 0),
    0
  );

  console.log('✔  data/content.json    dibuat');
  console.log('✔  data/galleries.json  dibuat');
  console.log('');
  console.log(`   Portfolio cards : ${content.portfolio.items.length}`);
  console.log(`   Specialties     : ${content.specialties.items.length}`);
  console.log(`   Experience      : ${content.experience.items.length}`);
  console.log(`   Tools           : ${content.tools.items.length}`);
  console.log(`   Galeri halaman  : ${Object.keys(galleries).length} (${itemCount} item)`);
};

main().catch((error) => {
  console.error('✖  Seed gagal:', error);
  process.exit(1);
});
