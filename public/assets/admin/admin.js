/* ===========================================================================
   Admin Dashboard — logika utama
   ---------------------------------------------------------------------------
   Semua data diambil / disimpan lewat API di server:
     GET  /api/session              -> info sesi + statistik
     GET  /api/analytics            -> statistik pengunjung (grafik dashboard)
     GET  /api/content              -> seluruh konten halaman utama
     PUT  /api/content/:section     -> simpan satu bagian
     GET  /api/galleries            -> seluruh halaman galeri
     PUT  /api/galleries/:id        -> simpan satu halaman galeri
     GET  /api/media                -> daftar berkas terunggah + seluruh media
     POST /api/media/upload-url     -> URL unggahan bertanda tangan (langkah 1)
     POST /api/media/upload-confirm -> ambil URL publik hasil unggahan (langkah 3)
     DELETE /api/media              -> hapus berkas unggahan
     POST /api/password             -> ganti password admin
     GET  /api/export               -> unduh backup JSON
     POST /api/import               -> pulihkan dari backup JSON
   =========================================================================== */

(() => {
  'use strict';

  const boot = window.ADMIN_BOOTSTRAP || {};
  let csrfToken = boot.csrfToken || '';

  const editor = document.getElementById('editor');
  const tabTitle = document.getElementById('tab-title');
  const tabSubtitle = document.getElementById('tab-subtitle');
  const topbarActions = document.getElementById('topbar-actions');

  const state = {
    tab: 'overview',
    content: null,
    galleries: null,
    uploads: [],
    library: [],
    activeGallery: null,
    draft: null,
    dirty: false,
    stats: null,
    visits: null,
    account: null,
  };

  /* ====================================================== utilitas dasar === */

  const escapeHtml = (value) =>
    String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);

  const parsePath = (path) =>
    String(path)
      .split('.')
      .flatMap((part) => {
        const tokens = [];
        const re = /([^[\]]+)|\[(\d+)\]/g;
        let match;
        while ((match = re.exec(part)) !== null) {
          tokens.push(match[2] === undefined ? match[1] : Number(match[2]));
        }
        return tokens;
      });

  const getPath = (object, path) =>
    parsePath(path).reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), object);

  const setPath = (object, path, value) => {
    const tokens = parsePath(path);
    let cursor = object;
    tokens.forEach((token, index) => {
      const isLast = index === tokens.length - 1;
      if (isLast) {
        cursor[token] = value;
        return;
      }
      const next = tokens[index + 1];
      if (cursor[token] === undefined || cursor[token] === null) {
        cursor[token] = typeof next === 'number' ? [] : {};
      }
      cursor = cursor[token];
    });
  };

  const humanSize = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  /* ============================================================ API layer == */

  const request = async (method, url, { body, formData } = {}) => {
    const options = { method, headers: {}, credentials: 'same-origin' };

    if (method !== 'GET') options.headers['x-csrf-token'] = csrfToken;

    if (formData) {
      options.body = formData;
    } else if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (response.status === 401) {
      window.location.href = '/admin/login?next=' + encodeURIComponent('/admin');
      throw new Error('Sesi berakhir.');
    }

    let payload = null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      payload = await response.json().catch(() => null);
    }

    if (!response.ok) {
      throw new Error((payload && payload.error) || `Permintaan gagal (${response.status})`);
    }

    return payload;
  };

  const api = {
    get: (url) => request('GET', url),
    put: (url, body) => request('PUT', url, { body }),
    post: (url, body) => request('POST', url, { body }),
    del: (url, body) => request('DELETE', url, { body }),
  };

  /* ================================================================ toast == */

  const toast = (message, type = 'success', timeout = 4200) => {
    const stack = document.getElementById('toast-stack');
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    stack.appendChild(node);
    setTimeout(() => node.remove(), timeout);
  };

  const reportError = (error) => toast(error.message || 'Terjadi kesalahan.', 'error', 6000);

  /* ======================================================= form builders == */

  const TABS = {
    overview: { title: 'Dashboard', subtitle: 'Ringkasan isi website Anda' },
    meta: { title: 'Judul Situs', subtitle: 'Judul yang muncul di tab browser & hasil pencarian' },
    hero: { title: 'Bagian Hero', subtitle: 'Tampilan paling atas halaman utama' },
    about: { title: 'Tentang Saya', subtitle: 'Bagian "About me"' },
    specialties: { title: 'Keahlian', subtitle: 'Kartu-kartu keahlian (Graphic Design, Photography, dll.)' },
    portfolio: { title: 'Kartu Portfolio', subtitle: 'Kartu pilihan karya di halaman utama' },
    experience: { title: 'Pengalaman Kerja', subtitle: 'Riwayat pekerjaan & magang' },
    tools: { title: 'Tools & Software', subtitle: 'Deretan logo teknologi yang Anda pakai' },
    contact: { title: 'Kontak & Sosial Media', subtitle: 'Bagian ajakan menghubungi Anda' },
    galleries: { title: 'Galeri Portfolio', subtitle: 'Isi halaman detail setiap kategori portfolio' },
    media: { title: 'Pustaka Media', subtitle: 'Semua gambar & video website' },
    account: { title: 'Akun & Keamanan', subtitle: 'Password, backup, dan pemulihan data' },
  };

  const CONTENT_TABS = ['meta', 'hero', 'about', 'specialties', 'portfolio', 'experience', 'tools', 'contact'];

  const value = (path) => getPath(state.draft || {}, path);

  const fieldText = (path, label, { hint = '', placeholder = '', type = 'text' } = {}) => `
    <label class="field">
      <span>${escapeHtml(label)}${hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : ''}</span>
      <input type="${type}" data-path="${escapeHtml(path)}" value="${escapeHtml(value(path))}"
        placeholder="${escapeHtml(placeholder)}">
    </label>`;

  const fieldTextarea = (path, label, { hint = '', rows = 3, placeholder = '' } = {}) => `
    <label class="field">
      <span>${escapeHtml(label)}${hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : ''}</span>
      <textarea data-path="${escapeHtml(path)}" rows="${rows}"
        placeholder="${escapeHtml(placeholder)}">${escapeHtml(value(path))}</textarea>
    </label>`;

  const fieldSelect = (path, label, options) => `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <select data-path="${escapeHtml(path)}">
        ${options
          .map(
            (option) =>
              `<option value="${escapeHtml(option.value)}"${
                String(value(path)) === String(option.value) ? ' selected' : ''
              }>${escapeHtml(option.label)}</option>`
          )
          .join('')}
      </select>
    </label>`;

  /** URL lokal (images/...) dibuat absolut supaya tetap benar di /admin. */
  const resolveMediaUrl = (source) => {
    const raw = String(source || '');
    if (!raw) return '';
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('/') || raw.startsWith('data:')) return raw;
    return '/' + raw;
  };

  const previewInner = (source) => {
    if (!source) return 'kosong';
    const url = resolveMediaUrl(source);
    if (/\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i.test(source)) {
      return `<video src="${escapeHtml(url)}" muted playsinline preload="metadata"></video>`;
    }
    return `<img src="${escapeHtml(url)}" alt="">`;
  };

  /**
   * Kolom media: input teks + pratinjau + tombol unggah/pilih.
   * `accept` membatasi jenis berkas saat mengunggah.
   */
  const fieldMedia = (path, label, { hint = '', accept = 'image/*,video/*' } = {}) => `
    <div class="field">
      <span>${escapeHtml(label)}${hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : ''}</span>
      <div class="media-field">
        <div class="media-input">
          <input type="text" data-path="${escapeHtml(path)}" value="${escapeHtml(value(path))}"
            placeholder="images/uploads/namafile.png">
          <div class="upload-status" data-upload-status="${escapeHtml(path)}"></div>
        </div>
        <div class="media-preview" data-media-preview="${escapeHtml(path)}">${previewInner(value(path))}</div>
        <div class="media-buttons">
          <button type="button" class="btn-soft btn-sm" data-upload="${escapeHtml(path)}"
            data-accept="${escapeHtml(accept)}">Unggah</button>
          <button type="button" class="btn-ghost btn-sm" data-pick="${escapeHtml(path)}">Pilih</button>
        </div>
      </div>
    </div>`;

  /** Header untuk setiap item dalam daftar (dengan tombol naik/turun/hapus). */
  const repeaterHead = (label, listPath, index, total) => `
    <div class="repeater-item-head">
      <span class="repeater-item-title">${escapeHtml(label)} ${index + 1}</span>
      <div class="repeater-actions">
        <button type="button" data-move-up="${escapeHtml(listPath)}" data-index="${index}"
          ${index === 0 ? 'disabled' : ''} title="Naik">↑</button>
        <button type="button" data-move-down="${escapeHtml(listPath)}" data-index="${index}"
          ${index === total - 1 ? 'disabled' : ''} title="Turun">↓</button>
        <button type="button" class="remove" data-remove="${escapeHtml(listPath)}" data-index="${index}"
          title="Hapus">✕</button>
      </div>
    </div>`;

  const addButton = (listPath, label) =>
    `<button type="button" class="btn-soft btn-sm" data-add="${escapeHtml(listPath)}"
      data-label="${escapeHtml(label)}">+ ${escapeHtml(label)}</button>`;

  const panel = (title, description, body, extraHead = '') => `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          ${description ? `<p>${escapeHtml(description)}</p>` : ''}
        </div>
        ${extraHead}
      </div>
      ${body}
    </section>`;

  /* ============================================ daftar template per bagian */

  /**
   * Definisi setiap daftar.
   * Kunci = "<tab>.<path relatif terhadap objek bagian>".
   * Path di DOM selalu relatif terhadap `state.draft`.
   */
  const LIST_DEFS = {
    'hero.navLinks': {
      label: 'Tautan menu',
      create: () => ({ label: 'Menu Baru', href: '#contact' }),
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Tautan', listPath, index, total)}
          <div class="grid-2">
            ${fieldText(`${path}.label`, 'Nama menu')}
            ${fieldText(`${path}.href`, 'Tujuan', { placeholder: '#portfolio' })}
          </div>
        </div>`,
    },
    'hero.lede': {
      label: 'Paragraf',
      create: () => 'Tulis paragraf baru di sini.',
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Paragraf', listPath, index, total)}
          ${fieldTextarea(path, 'Teks', { rows: 2 })}
        </div>`,
    },
    'about.body': {
      label: 'Paragraf',
      create: () => 'Tulis paragraf baru di sini.',
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Paragraf', listPath, index, total)}
          ${fieldTextarea(path, 'Teks', { rows: 3 })}
        </div>`,
    },
    'about.buttons': {
      label: 'Tombol',
      create: () => ({ variant: 'ghost', label: 'Tombol Baru', href: '#contact' }),
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Tombol', listPath, index, total)}
          <div class="grid-3">
            ${fieldSelect(`${path}.variant`, 'Gaya', [
              { value: 'primary', label: 'Utama (ungu)' },
              { value: 'ghost', label: 'Garis tepi (putih)' },
            ])}
            ${fieldText(`${path}.label`, 'Tulisan tombol')}
            ${fieldText(`${path}.href`, 'Tujuan', { placeholder: '#contact' })}
          </div>
        </div>`,
    },
    'specialties.items': {
      label: 'Keahlian',
      create: () => ({ pill: 'Baru', title: 'Keahlian Baru', body: 'Deskripsi keahlian.' }),
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Keahlian', listPath, index, total)}
          <div class="grid-2">
            ${fieldText(`${path}.pill`, 'Label kecil', { placeholder: 'Design' })}
            ${fieldText(`${path}.title`, 'Judul')}
          </div>
          ${fieldTextarea(`${path}.body`, 'Deskripsi', { rows: 3 })}
        </div>`,
    },
    'portfolio.items': {
      label: 'Kartu portfolio',
      create: () => {
        const firstGallery = Object.values(state.galleries || {})[0];
        return {
          label: 'Kategori Baru',
          href: firstGallery ? firstGallery.file : 'portfolio-graphic.html',
          galleryId: firstGallery ? firstGallery.id : '',
          gallerySource: firstGallery ? firstGallery.file : 'portfolio-graphic.html',
          cover: '',
          coverAlt: '',
        };
      },
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Kartu', listPath, index, total)}
          <div class="grid-2">
            ${fieldText(`${path}.label`, 'Judul kartu')}
            ${fieldText(`${path}.href`, 'Tujuan klik', { placeholder: 'portfolio-graphic.html' })}
          </div>
          ${fieldSelect(
            `${path}.galleryId`,
            'Halaman galeri (sumber gambar bergulir)',
            [
              { value: '', label: '— tanpa galeri (hanya gambar utama) —' },
              ...Object.values(state.galleries || {}).map((gallery) => ({
                value: gallery.id,
                label: `${gallery.title} (${gallery.file})`,
              })),
            ]
          )}
          ${fieldMedia(`${path}.cover`, 'Gambar utama kartu', { accept: 'image/*' })}
          ${fieldText(`${path}.coverAlt`, 'Teks alternatif gambar', { hint: 'untuk pembaca layar' })}
        </div>`,
    },
    'experience.items': {
      label: 'Pengalaman',
      create: () => ({ title: 'Posisi Baru', company: 'Nama perusahaan', period: '2026 - Now' }),
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Pengalaman', listPath, index, total)}
          <div class="grid-2">
            ${fieldText(`${path}.title`, 'Posisi / jabatan')}
            ${fieldText(`${path}.company`, 'Perusahaan / instansi')}
          </div>
          ${fieldText(`${path}.period`, 'Periode', { placeholder: '2023 - 2025' })}
        </div>`,
    },
    'tools.items': {
      label: 'Tool',
      create: () => ({ name: 'Tool Baru', logo: '', logoAlt: '' }),
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Tool', listPath, index, total)}
          ${fieldText(`${path}.name`, 'Nama tool')}
          ${fieldMedia(`${path}.logo`, 'Logo', { accept: 'image/*' })}
          ${fieldText(`${path}.logoAlt`, 'Teks alternatif logo')}
        </div>`,
    },
    'contact.socials': {
      label: 'Sosial media',
      create: () => ({ label: 'Sosial Baru', href: 'https://' }),
      render: (item, path, index, total, listPath) => `
        <div class="repeater-item">
          ${repeaterHead('Sosial media', listPath, index, total)}
          <div class="grid-2">
            ${fieldText(`${path}.label`, 'Nama platform')}
            ${fieldText(`${path}.href`, 'Tautan')}
          </div>
        </div>`,
    },
  };

  /** Item galeri (gambar/video) — dipakai untuk daftar `sections[i].items`. */
  const GALLERY_ITEM_DEF = {
    label: 'Berkas',
    create: () => ({ type: 'image', src: '', alt: '', caption: '', href: '' }),
  };

  const resolveListDef = (listPath) => {
    if (listPath === 'sections') {
      return { label: 'Kelompok baru', create: () => ({ title: 'Kelompok Baru', items: [] }) };
    }
    if (listPath.endsWith('.items')) return GALLERY_ITEM_DEF;
    return LIST_DEFS[`${state.tab}.${listPath}`] || { label: 'Item', create: () => ({}) };
  };

  const renderList = (listPath) => {
    const definition = resolveListDef(listPath);
    const items = getPath(state.draft, listPath) || [];

    const body = items.length
      ? `<div class="repeater">${items
          .map((item, index) =>
            definition.render(item, `${listPath}[${index}]`, index, items.length, listPath)
          )
          .join('')}</div>`
      : '<div class="repeater-empty">Belum ada isi. Tambahkan minimal satu.</div>';

    return `${body}<div class="mt-16">${addButton(listPath, definition.label)}</div>`;
  };

  const listPanel = (listPath, title, description) => panel(title, description, renderList(listPath));

  /* ============================================== perender setiap bagian == */

  const renderMeta = () =>
    panel(
      'Judul Situs',
      'Muncul di tab browser dan judul hasil pencarian Google.',
      fieldText('siteTitle', 'Judul situs', { placeholder: 'Rangga Febrianto | Portfolio' })
    );

  const renderHero = () => {
    const rail = () => panel(
      'Label sosial di sisi kiri',
      'Tulisan vertikal kecil di sebelah kiri bagian hero.',
      `<div class="grid-2">
        ${fieldText('socialRail.label', 'Tulisan')}
        ${fieldText('socialRail.href', 'Tautan')}
      </div>
      ${fieldText('socialRail.caption', 'Keterangan bawah')}`
    );

    return [
      panel(
        'Kalimat utama',
        'Teks pembuka yang dilihat pengunjung paling pertama.',
        `${fieldText('eyebrow', 'Tulisan kecil di atas nama')}
         ${fieldText('title', 'Nama / judul besar', { hint: 'diketik ulang otomatis oleh animasi' })}
         ${fieldText('role', 'Kalimat peran')}
         ${fieldText('ctaLabel', 'Tulisan tombol')}
         ${fieldText('ctaHref', 'Tujuan tombol')}`
      ),
      panel(
        'Foto hero',
        'Gambar utama di sebelah kanan.',
        `${fieldMedia('image', 'Gambar')}${fieldText('imageAlt', 'Teks alternatif gambar')}`
      ),
      rail(),
      listPanel('navLinks', 'Tautan menu', 'Menu di bagian atas halaman utama.'),
      listPanel('lede', 'Paragraf pengantar', 'Satu paragraf per kotak.'),
    ].join('');
  };

  const renderAbout = () => [
    panel(
      'Teks bagian "About me"',
      '',
      `${fieldText('kicker', 'Tulisan kecil di atas judul')}
       ${fieldText('heading', 'Judul')}`
    ),
    panel('Isi paragraf', 'Setiap paragraf ditampilkan berurutan.', renderList('body')),
    panel(
      'Foto & tombol',
      '',
      `${fieldMedia('image', 'Gambar')}${fieldText('imageAlt', 'Teks alternatif gambar')}`
    ),
    listPanel('buttons', 'Tombol', 'Tombol aksi di bagian About.'),
  ].join('');

  const renderSpecialties = () => [
    panel(
      'Judul bagian',
      '',
      `${fieldText('kicker', 'Tulisan kecil di atas judul')}${fieldText('heading', 'Judul bagian')}`
    ),
    listPanel('items', 'Kartu keahlian', 'Contoh: Graphic Design, Photography, Web Development.'),
  ].join('');

  const renderPortfolio = () => [
    panel(
      'Judul bagian',
      '',
      `${fieldText('kicker', 'Tulisan kecil di atas judul')}${fieldText('heading', 'Judul bagian')}`
    ),
    listPanel(
      'items',
      'Kartu portfolio',
      'Gambar kartu akan berganti otomatis memakai isi halaman galeri yang dipilih.'
    ),
  ].join('');

  const renderExperience = () => [
    panel(
      'Judul bagian',
      '',
      `${fieldText('kicker', 'Tulisan kecil di atas judul')}${fieldText('heading', 'Judul bagian')}`
    ),
    listPanel('items', 'Riwayat pengalaman', 'Urutan tampil mengikuti urutan di bawah.'),
  ].join('');

  const renderTools = () => [
    panel(
      'Judul bagian',
      '',
      `${fieldText('kicker', 'Tulisan kecil di atas judul')}${fieldText('heading', 'Judul bagian')}`
    ),
    listPanel('items', 'Daftar tool', 'Logo tampil sebagai chip bulat.'),
  ].join('');

  const renderContact = () => [
    panel(
      'Judul bagian',
      '',
      `${fieldText('socialKicker', 'Tulisan kecil bagian sosial media')}`
    ),
    listPanel('socials', 'Sosial media', 'Tampil sebagai tautan di atas kotak kontak.'),
    panel(
      'Kotak kontak',
      '',
      `${fieldText('kicker', 'Tulisan kecil di kotak ungu')}
       ${fieldText('heading', 'Judul kotak')}
       <div class="grid-2">
         ${fieldText('button.label', 'Tulisan tombol')}
         ${fieldText('button.href', 'Tujuan tombol', { placeholder: 'https://wa.me/6285...' })}
       </div>`
    ),
  ].join('');

  /* --------------------------------------------------------------- galeri */

  const renderGalleryItems = (sectionPath, items) => {
    const listPath = `${sectionPath}.items`;

    if (!items.length) {
      return '<div class="repeater-empty">Belum ada gambar/video di kelompok ini.</div>';
    }

    return `<div class="repeater">${items
      .map(
        (item, index) => `
        <div class="repeater-item">
          ${repeaterHead(item.type === 'video' ? 'Video' : 'Gambar', listPath, index, items.length)}
          <div class="grid-3">
            ${fieldSelect(`${listPath}[${index}].type`, 'Jenis', [
              { value: 'image', label: 'Gambar' },
              { value: 'video', label: 'Video' },
            ])}
            ${fieldText(`${listPath}[${index}].caption`, 'Keterangan', { hint: 'boleh kosong' })}
            ${fieldText(`${listPath}[${index}].href`, 'Tautan luar', { hint: 'boleh kosong' })}
          </div>
          ${fieldMedia(`${listPath}[${index}].src`, 'Berkas', { accept: 'image/*,video/*' })}
          ${fieldText(`${listPath}[${index}].alt`, 'Teks alternatif')}
        </div>`
      )
      .join('')}</div>`;
  };

  const renderGalleries = () => {
    if (!state.galleries) return '<div class="loading-card">Memuat…</div>';

    const entries = Object.values(state.galleries);
    if (!entries.length) return '<div class="empty-card">Belum ada halaman galeri.</div>';

    if (!state.activeGallery || !state.galleries[state.activeGallery]) {
      state.activeGallery = entries[0].id;
    }

    const gallery = state.galleries[state.activeGallery];
    const sections = gallery.sections || [];

    const switcher = `
      <div class="tabs-row">
        ${entries
          .map(
            (entry) =>
              `<button type="button" data-gallery="${escapeHtml(entry.id)}" class="${
                entry.id === state.activeGallery ? 'active' : ''
              }">${escapeHtml(entry.title)}</button>`
          )
          .join('')}
      </div>`;

    const meta = panel(
      `Informasi halaman`,
      `Berkas: ${gallery.file} — halaman ini menyimpan gambar/video untuk kategori ini.`,
      `${fieldText('kicker', 'Tulisan kecil di atas judul')}
       ${fieldText('title', 'Judul halaman')}
       ${fieldTextarea('description', 'Deskripsi halaman', { rows: 2 })}
       ${fieldSelect('variant', 'Gaya tampilan', [
         { value: 'default', label: 'Standar (kisi kecil)' },
         { value: 'web', label: 'Web (pratinjau besar + tautan)' },
         { value: 'flutter', label: 'Flutter (satu kolom besar)' },
       ])}`,
      `<a class="btn-ghost btn-sm" href="/${escapeHtml(gallery.file)}" target="_blank" rel="noopener">Lihat halaman ↗</a>`
    );

    const sectionBlocks = sections.length
      ? sections
          .map((section, index) => {
            const sectionPath = `sections[${index}]`;
            return `
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h2>Kelompok ${index + 1}</h2>
                  <p>${section.items.length} berkas</p>
                </div>
                <div class="repeater-actions">
                  <button type="button" data-move-up="sections" data-index="${index}"
                    ${index === 0 ? 'disabled' : ''} title="Naik">↑</button>
                  <button type="button" data-move-down="sections" data-index="${index}"
                    ${index === sections.length - 1 ? 'disabled' : ''} title="Turun">↓</button>
                  <button type="button" class="remove" data-remove="sections" data-index="${index}"
                    title="Hapus kelompok">✕</button>
                </div>
              </div>
              ${fieldText(`${sectionPath}.title`, 'Nama kelompok', {
                hint: 'boleh kosong bila tidak butuh judul',
              })}
              ${renderGalleryItems(sectionPath, section.items)}
              <div class="mt-16">
                <button type="button" class="btn-soft btn-sm" data-add="${sectionPath}.items"
                  data-label="Berkas">+ Tambah berkas</button>
              </div>
            </section>`;
          })
          .join('')
      : '<div class="empty-card">Belum ada kelompok. Tambahkan satu kelompok lebih dulu.</div>';

    return `
      ${switcher}
      ${meta}
      ${sectionBlocks}
      <div class="mt-16">${addButton('sections', 'Kelompok baru')}</div>`;
  };

  /* ---------------------------------------------------------------- media */

  const renderMedia = () => {
    const uploadsList = state.uploads.length
      ? `<div class="media-grid">${state.uploads
          .map(
            (file) => `
        <div>
          <div class="media-thumb" style="cursor:default">
            ${
              file.isVideo
                ? `<video src="/${escapeHtml(file.url)}" muted playsinline preload="metadata"></video>`
                : `<img src="/${escapeHtml(file.url)}" alt="">`
            }
            <span class="media-name">${escapeHtml(file.name)}</span>
          </div>
          <div class="mt-16" style="display:flex;gap:8px;align-items:center;justify-content:space-between">
            <span class="small muted">${humanSize(file.size)}</span>
            <button type="button" class="btn-danger btn-sm" data-delete-media="${escapeHtml(file.url)}">Hapus</button>
          </div>
        </div>`
          )
          .join('')}</div>`
      : '<div class="repeater-empty">Belum ada berkas yang diunggah lewat dashboard.</div>';

    const libraryList = state.library.length
      ? `<div class="media-grid">${state.library
          .slice(0, 200)
          .map(
            (file) => `
        <div class="media-thumb" title="/${escapeHtml(file.rawUrl)}">
          ${
            file.isVideo
              ? `<video src="/${escapeHtml(file.url)}" muted playsinline preload="metadata"></video>`
              : `<img src="/${escapeHtml(file.url)}" alt="" loading="lazy">`
          }
          <span class="media-name">${escapeHtml(file.rawUrl.split('/').slice(-1)[0])}</span>
        </div>`
          )
          .join('')}</div>`
      : '<div class="repeater-empty">Tidak ada media ditemukan.</div>';

    return [
      panel(
        'Berkas hasil unggahan',
        'Berkas di folder images/uploads. Menghapus di sini akan menghilangkan gambar dari website.',
        `${uploadsList}
         <div class="row-actions">
           <button type="button" class="btn-primary btn-sm" id="media-upload-btn">+ Unggah berkas baru</button>
           <span class="small muted">Gambar & video, maksimal 40 MB per berkas.</span>
         </div>`
      ),
      panel(
        'Semua media di website',
        'Termasuk gambar lama yang sudah ada di folder images. Klik salah satu untuk menyalin alamatnya.',
        libraryList
      ),
    ].join('');
  };

  /* -------------------------------------------------------------- account */

  const renderAccount = () => {
    const changed = state.account && state.account.passwordChangedAt;
    return [
      panel(
        'Ganti password',
        'Password disimpan dalam bentuk hash bcrypt. Gunakan minimal 10 karakter berisi huruf dan angka.',
        `<div class="grid-2">
           <label class="field">
             <span>Password sekarang</span>
             <input type="password" id="pw-current" autocomplete="current-password">
           </label>
           <label class="field">
             <span>Username</span>
             <input type="text" value="${escapeHtml(state.account ? state.account.user : '')}" readonly>
           </label>
         </div>
         <div class="grid-2">
           <label class="field">
             <span>Password baru</span>
             <input type="password" id="pw-new" autocomplete="new-password">
           </label>
           <label class="field">
             <span>Ulangi password baru</span>
             <input type="password" id="pw-confirm" autocomplete="new-password">
           </label>
         </div>
         <div class="row-actions">
           <button type="button" class="btn-primary" id="change-password">Simpan password baru</button>
           ${changed ? `<span class="small muted">Terakhir diubah: ${escapeHtml(new Date(changed).toLocaleString('id-ID'))}</span>` : ''}
         </div>`
      ),
      panel(
        'Backup & pemulihan',
        'Simpan salinan seluruh isi website (teks + galeri) ke satu berkas JSON, atau pulihkan dari berkas tersebut.',
        `<div class="row-actions">
           <button type="button" class="btn-ghost" id="export-data">Unduh backup (JSON)</button>
           <button type="button" class="btn-ghost" id="import-data">Pulihkan dari backup</button>
           <input type="file" id="import-file" accept="application/json,.json" class="sr-only">
         </div>
         <p class="small muted">Catatan: berkas gambar/video tidak termasuk dalam backup JSON.</p>`
      ),
      panel(
        'Keluar dari dashboard',
        'Akhiri sesi login di perangkat ini.',
        `<form method="post" action="/admin/logout">
           <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
           <button type="submit" class="btn-danger">Keluar sekarang</button>
         </form>`
      ),
    ].join('');
  };

  /* ------------------------------------------------------------- overview */

  /* ---------------------------------------------------------- pengunjung --- */

  const formatNumber = (value) => new Intl.NumberFormat('id-ID').format(Number(value) || 0);

  /**
   * Grafik garis sederhana untuk 24 jam terakhir, digambar langsung sebagai
   * SVG supaya tidak perlu memuat library chart apa pun.
   * `points` = [{ label: '14:00', count: 3 }, ...]
   */
  const chartSvg = (points) => {
    const width = 720;
    const height = 190;
    const top = 14;
    const bottom = 150;
    const max = Math.max(1, ...points.map((point) => point.count));
    const stepX = points.length > 1 ? width / (points.length - 1) : width;
    const xAt = (index) => (points.length > 1 ? index * stepX : width / 2);
    const yAt = (count) => bottom - (count / max) * (bottom - top);

    const coords = points.map((point, index) => [xAt(index), yAt(point.count)]);
    const line = coords.map(([cx, cy]) => `${cx.toFixed(1)},${cy.toFixed(1)}`).join(' ');
    const area = `${xAt(0).toFixed(1)},${bottom} ${line} ${xAt(points.length - 1).toFixed(1)},${bottom}`;

    const grid = [0, 0.5, 1]
      .map((ratio) => {
        const gy = (bottom - ratio * (bottom - top)).toFixed(1);
        return `<line x1="0" y1="${gy}" x2="${width}" y2="${gy}" class="chart-grid" />`;
      })
      .join('');

    const ticks = points
      .map((point, index) => ({ point, index }))
      .filter(({ index }) => index === 0 || index === points.length - 1 || index % 6 === 0)
      .map(({ point, index }) => {
        const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
        return `<text x="${xAt(index).toFixed(1)}" y="176" text-anchor="${anchor}" class="chart-label">${escapeHtml(
          point.label
        )}</text>`;
      })
      .join('');

    return `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img"
        aria-label="Grafik kunjungan 24 jam terakhir">
        ${grid}
        <polygon class="chart-area" points="${area}" />
        <polyline class="chart-line" points="${line}" />
        <text x="2" y="${top - 2}" class="chart-label chart-label-max">${formatNumber(max)}</text>
        ${ticks}
      </svg>`;
  };

  const renderVisitorPanel = () => {
    const visits = state.visits;
    const summary = (visits && visits.summary) || {};
    const hours = (visits && visits.hours) || [];

    const cards = [
      { label: 'Total kunjungan', value: summary.total },
      { label: 'Hari ini', value: summary.today },
      { label: 'Jam ini', value: summary.thisHour },
    ];

    const foot = visits
      ? `Terakhir diperbarui ${escapeHtml(new Date(visits.updatedAt).toLocaleTimeString('id-ID'))} • ${
          hours.some((hour) => hour.count > 0)
            ? 'ada kunjungan tercatat'
            : 'belum ada kunjungan pada rentang ini'
        } • penyimpanan ${escapeHtml(visits.storage)} • otomatis tiap 15 detik`
      : 'Memuat statistik pengunjung…';

    return `
      <section class="panel mt-16" id="visitor-panel">
        <div class="panel-head">
          <div>
            <h2>Pengunjung Website</h2>
            <p>Tampilan halaman publik per jam, 24 jam terakhir (${escapeHtml(
              (visits && visits.timezone) || 'UTC+7 (WIB)'
            )}).</p>
          </div>
          <button type="button" class="btn-ghost btn-sm" id="visits-refresh">Segarkan</button>
        </div>
        <div class="visitor-cards">
          ${cards
            .map(
              (card) => `
            <div class="visitor-card">
              <div class="value">${card.value === undefined ? '—' : formatNumber(card.value)}</div>
              <div class="label">${escapeHtml(card.label)}</div>
            </div>`
            )
            .join('')}
        </div>
        <div class="chart-wrap">
          ${hours.length ? chartSvg(hours) : '<div class="empty-card">Belum ada data untuk digambar.</div>'}
        </div>
        <p class="small muted" style="margin:12px 0 0">${foot}</p>
      </section>`;
  };

  let visitsTimer = null;

  const stopVisitsTimer = () => {
    if (visitsTimer) {
      clearInterval(visitsTimer);
      visitsTimer = null;
    }
  };

  /** Ambil data terbaru lalu ganti HANYA panel pengunjung (tanpa render ulang total). */
  const refreshVisits = async () => {
    try {
      const data = await api.get('/api/analytics');
      state.visits = data;
      const panel = document.getElementById('visitor-panel');
      if (panel && state.tab === 'overview') panel.outerHTML = renderVisitorPanel();
    } catch {
      // Gangguan sesaat jangan sampai mengganggu seluruh dashboard.
    }
  };

  const startVisitsTimer = () => {
    stopVisitsTimer();
    visitsTimer = setInterval(refreshVisits, 15000);
  };

  const renderOverview = () => {
    const stats = state.stats || {};
    const cards = [
      { label: 'Kartu portfolio', value: stats.portfolio, tab: 'portfolio' },
      { label: 'Keahlian', value: stats.specialties, tab: 'specialties' },
      { label: 'Pengalaman kerja', value: stats.experience, tab: 'experience' },
      { label: 'Tools & software', value: stats.tools, tab: 'tools' },
      { label: 'Halaman galeri', value: stats.galleries, tab: 'galleries' },
      { label: 'Gambar & video galeri', value: stats.galleryItems, tab: 'galleries' },
    ];

    return `
      <div class="stat-grid">
        ${cards
          .map(
            (card) => `
          <button type="button" class="stat-card" data-goto="${card.tab}">            <div class="value">${card.value === undefined ? '—' : card.value}</div>
            <div class="label">${escapeHtml(card.label)}</div>
          </button>`
          )
          .join('')}
      </div>
      ${renderVisitorPanel()}
      <section class="panel mt-16">
        <div class="panel-head">
          <div>
            <h2>Pintasan</h2>
            <p>Bagian yang paling sering diubah.</p>
          </div>
        </div>
        <div class="quick-links">
          <button type="button" class="btn-ghost btn-sm" data-goto="hero">Edit bagian Hero</button>
          <button type="button" class="btn-ghost btn-sm" data-goto="portfolio">Edit kartu Portfolio</button>
          <button type="button" class="btn-ghost btn-sm" data-goto="galleries">Kelola galeri</button>
          <button type="button" class="btn-ghost btn-sm" data-goto="tools">Edit tools</button>
          <button type="button" class="btn-ghost btn-sm" data-goto="account">Ganti password</button>
          <a class="btn-ghost btn-sm" href="/" target="_blank" rel="noopener">Buka website ↗</a>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Keamanan</h2>
            <p>Ringkasan status akun admin Anda.</p>
          </div>
        </div>
        <ul class="small muted" style="margin:0;padding-left:18px">
          <li>Login dilindungi bcrypt, cookie HttpOnly, dan token CSRF.</li>
          <li>Maksimal 5 percobaan login gagal per 15 menit, lalu dikunci sementara.</li>
          <li>Folder dashboard tidak diindeks mesin pencari (noindex) dan tidak terdaftar di robots.txt.</li>
          <li>
            Password terakhir diubah:
            ${
              state.account && state.account.passwordChangedAt
                ? escapeHtml(new Date(state.account.passwordChangedAt).toLocaleString('id-ID'))
                : 'belum pernah diubah dari dashboard'
            }.
          </li>
        </ul>
      </section>`;
  };

  /* ============================================================== render == */

  const RENDERERS = {
    overview: renderOverview,
    meta: renderMeta,
    hero: renderHero,
    about: renderAbout,
    specialties: renderSpecialties,
    portfolio: renderPortfolio,
    experience: renderExperience,
    tools: renderTools,
    contact: renderContact,
    galleries: renderGalleries,
    media: renderMedia,
    account: renderAccount,
  };

  const setActiveNav = () => {
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === state.tab);
    });
  };

  const renderTopbar = () => {
    const info = TABS[state.tab];
    tabTitle.textContent = info.title;
    tabSubtitle.textContent = info.subtitle;
    topbarActions.innerHTML = '';

    if (state.tab === 'overview' || state.tab === 'media' || state.tab === 'account') return;

    const hint = document.createElement('span');
    hint.className = 'dirty-hint';
    hint.id = 'dirty-hint';
    hint.textContent = state.dirty ? 'Ada perubahan belum disimpan' : '';
    topbarActions.appendChild(hint);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn-primary';
    save.id = 'save-btn';
    save.textContent = 'Simpan perubahan';
    save.addEventListener('click', saveCurrent);
    topbarActions.appendChild(save);
  };

  const renderTab = () => {
    setActiveNav();
    renderTopbar();

    // Objek yang sedang diedit harus ditentukan SEBELUM dirender,
    // karena semua kolom membaca nilainya dari `state.draft`.
    if (state.tab === 'galleries') {
      if (state.galleries) {
        if (!state.activeGallery || !state.galleries[state.activeGallery]) {
          state.activeGallery = Object.keys(state.galleries)[0] || null;
        }
        state.draft = state.galleries[state.activeGallery] || null;
      } else {
        state.draft = null;
      }
    } else if (CONTENT_TABS.includes(state.tab)) {
      state.draft = state.content ? state.content[state.tab] : null;
    } else {
      state.draft = null;
    }

    const renderer = RENDERERS[state.tab];
    editor.innerHTML = renderer ? renderer() : '<div class="empty-card">Bagian tidak dikenal.</div>';

    markClean();
    editor.scrollTop = 0;

    // Grafik pengunjung hanya hidup selama tab Dashboard terbuka.
    if (state.tab === 'overview') {
      if (!state.visits) refreshVisits();
      startVisitsTimer();
    } else {
      stopVisitsTimer();
    }
  };

  /* ============================================================ penyimpanan */

  const markDirty = () => {
    state.dirty = true;
    const hint = document.getElementById('dirty-hint');
    if (hint) hint.textContent = 'Ada perubahan belum disimpan';
  };

  const markClean = () => {
    state.dirty = false;
    const hint = document.getElementById('dirty-hint');
    if (hint) hint.textContent = '';
  };

  /** Salin semua nilai input pada halaman ke objek data. */
  const syncFromDom = () => {
    if (!state.draft) return;
    editor.querySelectorAll('[data-path]').forEach((input) => {
      setPath(state.draft, input.dataset.path, input.value);
    });
  };

  const saveCurrent = async () => {
    if (!state.draft) return;
    syncFromDom();

    const button = document.getElementById('save-btn');
    if (button) {
      button.disabled = true;
      button.textContent = 'Menyimpan…';
    }

    try {
      if (state.tab === 'galleries') {
        const response = await api.put(`/api/galleries/${state.activeGallery}`, state.draft);
        state.galleries[state.activeGallery] = response.gallery;
        state.draft = response.gallery;
      } else {
        const response = await api.put(`/api/content/${state.tab}`, state.draft);
        state.content[state.tab] = response.value;
        state.draft = response.value;
      }
      markClean();
      toast('Perubahan berhasil disimpan.');
      if (state.tab === 'portfolio') renderTab();
      if (state.tab === 'galleries') renderTab();
    } catch (error) {
      reportError(error);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Simpan perubahan';
      }
    }
  };

  /* ======================================================== aksi struktural */

  const mutate = (callback) => {
    syncFromDom();
    callback();
    renderTab();
    markDirty();
  };

  const addItem = (listPath, label) => {
    const definition = resolveListDef(listPath);

    mutate(() => {
      let list = getPath(state.draft, listPath);
      if (!Array.isArray(list)) {
        list = [];
        setPath(state.draft, listPath, list);
      }
      list.push(definition.create());
    });
  };

  const removeItem = (listPath, index) => {
    const list = getPath(state.draft, listPath) || [];
    const name = listPath === 'sections' ? 'kelompok ini beserta isinya' : 'item ini';
    if (!window.confirm(`Yakin ingin menghapus ${name}?`)) return;

    mutate(() => {
      const target = getPath(state.draft, listPath);
      if (Array.isArray(target)) target.splice(index, 1);
    });
  };

  const moveItem = (listPath, index, direction) => {
    mutate(() => {
      const list = getPath(state.draft, listPath);
      if (!Array.isArray(list)) return;
      const next = index + direction;
      if (next < 0 || next >= list.length) return;
      const [item] = list.splice(index, 1);
      list.splice(next, 0, item);
    });
  };

  /* ============================================================== media UI */

  const modal = document.getElementById('media-modal');
  let pickTargetPath = null;

  const updatePreview = (path, source) => {
    const preview = editor.querySelector(`[data-media-preview="${path}"]`)
      || document.querySelector(`[data-media-preview="${path}"]`);
    if (preview) preview.innerHTML = previewInner(source);
  };

  /**
   * Unggah berkas ke Vercel Blob dalam tiga langkah. Berkasnya dikirim
   * langsung dari browser ke Blob (bukan lewat server) supaya ukuran berkas
   * tidak dibatasi 4.5 MB seperti body request Vercel Function.
   */
  const uploadToBlob = async (file) => {
    const ticket = await api.post('/api/media/upload-url', {
      name: file.name,
      type: file.type,
      size: file.size,
    });

    const response = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': ticket.contentType || file.type || 'application/octet-stream' },
      body: file,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Gagal mengunggah berkas ke penyimpanan (${response.status}). ${detail.slice(0, 200)}`.trim()
      );
    }

    const confirmed = await api.post('/api/media/upload-confirm', { pathname: ticket.pathname });
    return confirmed.url;
  };

  const uploadFile = async (file, path) => {
    const status = document.querySelector(`[data-upload-status="${path}"]`);
    if (status) {
      status.className = 'upload-status';
      status.textContent = `Mengunggah ${file.name}…`;
    }

    try {
      const url = await uploadToBlob(file);
      const input = document.querySelector(`[data-path="${path}"]`);
      if (input) input.value = url;
      updatePreview(path, url);
      if (status) {
        status.textContent = `Selesai: ${url}`;
        status.className = 'upload-status';
      }
      markDirty();
      toast('Berkas berhasil diunggah.');
    } catch (error) {
      if (status) {
        status.textContent = error.message;
        status.className = 'upload-status error';
      }
      reportError(error);
    }
  };

  const openPicker = async (path) => {
    pickTargetPath = path;
    modal.classList.add('open');
    document.querySelector('#media-modal .modal-body').innerHTML = '<div class="loading-card">Memuat media…</div>';

    try {
      const response = await api.get('/api/media');
      state.uploads = response.uploads;
      state.library = response.library;
      renderPicker();
    } catch (error) {
      document.querySelector('#media-modal .modal-body').innerHTML =
        `<div class="empty-card">${escapeHtml(error.message)}</div>`;
    }
  };

  const renderPicker = () => {
    const body = document.querySelector('#media-modal .modal-body');
    const items = [
      ...state.uploads.map((file) => ({ ...file, group: 'uploads' })),
      ...state.library.map((file) => ({ ...file, group: 'library' })),
    ];

    body.innerHTML = `
      <input type="text" id="media-search" placeholder="Cari nama berkas…">
      <div class="media-grid" id="media-grid">
        ${items
          .map(
            (file, index) => `
          <button type="button" class="media-thumb" data-media-index="${index}" title="/${escapeHtml(file.rawUrl || file.url)}">
            ${
              file.isVideo
                ? `<video src="/${escapeHtml(file.url)}" muted playsinline preload="metadata"></video>`
                : `<img src="/${escapeHtml(file.url)}" alt="" loading="lazy">`
            }
            <span class="media-name">${escapeHtml(file.name || (file.rawUrl || '').split('/').slice(-1)[0])}</span>
          </button>`
          )
          .join('')}
      </div>
      <div class="mt-16">
        <button type="button" class="btn-primary btn-sm" id="picker-upload">+ Unggah berkas baru</button>
      </div>`;

    body.querySelectorAll('[data-media-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const file = items[Number(button.dataset.mediaIndex)];
        if (!pickTargetPath || !file) return;
        const input = document.querySelector(`[data-path="${pickTargetPath}"]`);
        if (input) input.value = file.url;
        updatePreview(pickTargetPath, file.url);
        markDirty();
        closePicker();
      });
    });

    const search = body.querySelector('#media-search');
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      body.querySelectorAll('#media-grid .media-thumb').forEach((node) => {
        const name = node.querySelector('.media-name').textContent.toLowerCase();
        node.style.display = name.includes(term) ? '' : 'none';
      });
    });

    body.querySelector('#picker-upload').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.addEventListener('change', async () => {
        if (!input.files[0] || !pickTargetPath) return;
        const path = pickTargetPath;
        await uploadFile(input.files[0], path);
        closePicker();
      });
      input.click();
    });
  };

  const closePicker = () => {
    modal.classList.remove('open');
    pickTargetPath = null;
  };

  /* =========================================================== delegasi UI */

  editor.addEventListener('input', (event) => {
    const target = event.target;
    if (!target.dataset) return;
    if (target.dataset.path) {
      updatePreview(target.dataset.path, target.value);
      markDirty();
    }
  });

  editor.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset && target.dataset.path) markDirty();
  });

  editor.addEventListener('click', async (event) => {
    const target = event.target.closest('button, .media-thumb');
    if (!target) return;

    if (target.id === 'visits-refresh') {
      target.disabled = true;
      await refreshVisits();
      target.disabled = false;
      return;
    }

    const { add, remove, moveUp, moveDown, upload, pick, deleteMedia, gallery, goto } = target.dataset;

    if (goto) return switchTab(goto);

    if (gallery) {
      if (gallery === state.activeGallery) return;
      if (state.dirty && !window.confirm('Ada perubahan yang belum disimpan. Ganti halaman galeri dan buang perubahan?')) {
        return;
      }
      state.activeGallery = gallery;
      state.dirty = false;
      return renderTab();
    }

    if (add && target.dataset.label) return addItem(add, target.dataset.label);
    if (remove) return removeItem(remove, Number(target.dataset.index));
    if (moveUp) return moveItem(moveUp, Number(target.dataset.index), -1);
    if (moveDown) return moveItem(moveDown, Number(target.dataset.index), 1);

    if (upload) {
      const accept = target.dataset.accept || 'image/*,video/*';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.addEventListener('change', () => {
        if (input.files[0]) uploadFile(input.files[0], upload);
      });
      return input.click();
    }

    if (pick) return openPicker(pick);

    if (deleteMedia) {
      if (!window.confirm('Hapus berkas ini secara permanen?')) return;
      try {
        await api.del('/api/media', { url: deleteMedia });
        state.uploads = state.uploads.filter((file) => file.url !== deleteMedia);
        toast('Berkas dihapus.');
        renderTab();
      } catch (error) {
        reportError(error);
      }
      return;
    }

    if (target.id === 'media-upload-btn') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        try {
          await uploadToBlob(input.files[0]);
          toast('Berkas berhasil diunggah.');
          await loadMedia();
          renderTab();
        } catch (error) {
          reportError(error);
        }
      });
      return input.click();
    }

    if (target.id === 'change-password') {
      const currentPassword = document.getElementById('pw-current').value;
      const newPassword = document.getElementById('pw-new').value;
      const confirmPassword = document.getElementById('pw-confirm').value;

      target.disabled = true;
      try {
        const response = await api.post('/api/password', { currentPassword, newPassword, confirmPassword });
        csrfToken = response.csrfToken || csrfToken;
        state.account = { ...state.account, passwordChangedAt: new Date().toISOString() };
        document.querySelectorAll('input[name="_csrf"]').forEach((input) => {
          input.value = csrfToken;
        });
        toast('Password berhasil diganti.');
        renderTab();
      } catch (error) {
        reportError(error);
      } finally {
        target.disabled = false;
      }
      return;
    }

    if (target.id === 'export-data') {
      window.location.href = '/api/export';
      return;
    }

    if (target.id === 'import-data') {
      return document.getElementById('import-file').click();
    }
  });

  // Pustaka media: klik untuk menyalin alamat gambar.
  editor.addEventListener('click', (event) => {
    const node = event.target.closest('.media-thumb');
    if (!node) return;
    const title = node.getAttribute('title');
    if (!title || state.tab !== 'media') return;
    const url = title.replace(/^\//, '');
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast(`Alamat disalin: ${url}`))
      .catch(() => {});
  });

  /* ============================================================== importer */

  document.addEventListener('change', async (event) => {
    const input = event.target;
    if (!input || input.id !== 'import-file') return;

    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    if (!window.confirm('Pulihkan data dari berkas ini? Isi website saat ini akan diganti.')) return;

    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await api.post('/api/import', payload);
      toast('Data berhasil dipulihkan.');
      await loadAll();
      renderTab();
    } catch (error) {
      reportError(error);
    }
  });

  /* ================================================================= tabs */

  const switchTab = (tab) => {
    if (!TABS[tab]) return;
    if (state.dirty && !window.confirm('Ada perubahan yang belum disimpan. Pindah bagian dan buang perubahan?')) {
      return;
    }
    state.dirty = false;
    state.tab = tab;

    if (tab === 'media' && !state.uploads.length) {
      loadMedia().then(() => renderTab());
    }

    renderTab();
    document.getElementById('sidebar').classList.remove('open');
  };

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Klik tombol cepat di luar editor (mis. dari overview).
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-goto]');
    if (target && !editor.contains(target)) switchTab(target.dataset.goto);
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* ================================================================ modal */

  document.querySelector('#media-modal .modal-backdrop').addEventListener('click', closePicker);
  document.querySelector('#media-modal .modal-close').addEventListener('click', closePicker);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.classList.contains('open')) closePicker();
  });

  /* ================================================================= load */

  const loadMedia = async () => {
    const response = await api.get('/api/media');
    state.uploads = response.uploads;
    state.library = response.library;
  };

  const loadAll = async () => {
    const [session, content, galleries] = await Promise.all([
      api.get('/api/session'),
      api.get('/api/content'),
      api.get('/api/galleries'),
    ]);

    csrfToken = session.csrfToken || csrfToken;
    state.account = session.account;
    state.stats = session.stats;
    state.content = content.content;
    state.galleries = galleries.galleries;
    state.activeGallery = Object.keys(state.galleries)[0] || null;

    document.getElementById('account-name').textContent = session.account.displayName;
  };

  const start = async () => {
    try {
      await loadAll();
      renderTab();
    } catch (error) {
      editor.innerHTML = `<div class="empty-card">Gagal memuat data: ${escapeHtml(error.message)}</div>`;
      reportError(error);
    }
  };

  start();
})();
