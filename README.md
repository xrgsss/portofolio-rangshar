# Website Portofolio — Rangga Febrianto

Website portfolio + **dashboard admin** untuk mengelola seluruh isi website (CRUD),
dilindungi login yang hanya bisa diakses oleh admin.

---

## 1. Cara menjalankan

```bash
npm install     # sekali saja
npm start
```

Lalu buka:

| Halaman | Alamat |
| --- | --- |
| Website | http://localhost:3000/ |
| Dashboard admin | http://localhost:3000/admin |

Saat pertama kali dijalankan, file `.env` dibuat otomatis dan **password admin
dicetak di console** (hanya sekali). Simpan password itu, lalu ganti dari
dashboard pada menu **Akun & Keamanan**.

Lupa password? Buat password baru:

```bash
npm run setup -- --reset
```

Perintah itu menampilkan kredensial baru di console.

---

## 2. Isi dashboard admin

| Menu | Yang bisa diubah |
| --- | --- |
| Dashboard | Statistik isi website + pintasan |
| Judul Situs | Judul di tab browser / hasil pencarian |
| Bagian Hero | Kalimat pembuka, foto, tombol, menu, label sosial |
| Tentang Saya | Kicker, judul, paragraf, foto, tombol |
| Keahlian | Kartu keahlian (tambah/ubah/hapus/urutkan) |
| Kartu Portfolio | Kartu karya di halaman utama + pilih sumber galeri |
| Pengalaman Kerja | Riwayat pekerjaan & magang |
| Tools & Software | Logo + nama aplikasi |
| Kontak & Sosial Media | Tautan sosial media & tombol WhatsApp |
| Galeri Portfolio | Isi halaman detail: kelompok + gambar/video (unggah, urutkan, hapus) |
| Pustaka Media | Semua gambar/video website + hapus berkas unggahan |
| Akun & Keamanan | Ganti password, backup & pulihkan data, logout |

Semua daftar punya tombol **naik / turun / hapus**, dan setiap bagian punya
tombol **Simpan perubahan** sendiri.

Unggah gambar/video: gunakan tombol **Unggah** (berkas baru ke `images/uploads/`)
atau **Pilih** (memakai gambar yang sudah ada di website).

---

## 3. Cara login admin dilindungi

- Password disimpan **hanya sebagai hash bcrypt** (12 rounds) di `.env`, tidak pernah sebagai teks biasa.
- Sesi memakai **cookie `HttpOnly` + `SameSite=Lax`**, jadi tidak bisa dibaca JavaScript.
- Semua permintaan yang mengubah data wajib membawa **token CSRF**.
- **Rate limit**: 5 percobaan login gagal per 15 menit → dikunci 15 menit.
- Halaman `/admin` ber-**noindex**, dilarang di `robots.txt`, dan tidak ada tautan menuju dashboard dari website publik.
- Berkas sensitif (`.env`, `server.js`, `data/*.json`, folder `lib/`) **tidak bisa diunduh** lewat browser.
- Unggahan berkas dibatasi jenis (gambar/video) dan ukuran (40 MB); penghapusan berkas dikunci hanya untuk isi `images/uploads/`.
- URL berbahaya (`javascript:`, `data:`) otomatis ditolak saat menyimpan data.

> Penting: jangan pernah meng-commit file `.env` (sudah ada di `.gitignore`).

---

## 4. Struktur folder

```
server.js              Aplikasi Express (website publik + API admin)
package.json
.env                   Kredensial admin (dibuat otomatis, JANGAN dibagikan)
.env.example           Contoh isi .env

data/
  content.json         Isi halaman utama (hero, about, portfolio, dll.)
  galleries.json       Isi halaman galeri portfolio

views/                 Template EJS (HTML yang dirender server)
  index.ejs            Halaman utama
  gallery.ejs          Halaman detail portfolio
  not-found.ejs        Halaman 404
  admin/login.ejs      Form login admin
  admin/dashboard.ejs  Kerangka dashboard admin

public/admin/          Aset dashboard (admin.css, admin.js)

lib/
  auth.js              bcrypt, rate limit, middleware login, CSRF
  config.js            Pembacaan & pembuatan .env
  schema.js            Validasi + pembersihan data dari browser
  session-store.js     Penyimpanan sesi (memori + file, atomik)
  store.js             Baca/tulis data/*.json
  uploads.js           Unggah & hapus berkas media

scripts/
  seed.mjs             Ekstrak isi dari HTML lama -> data/*.json
  setup.mjs            Siapkan / reset kredensial admin
  hash-password.mjs    Buat hash bcrypt manual

images/                Semua gambar & video website
  uploads/             Berkas hasil unggahan dari dashboard

legacy/                HTML statis versi lama (cadangan, tidak dipakai server)
styles.css             Gaya tampilan website publik
```

---

## 5. Mengubah atau menambah isi

Cukup lewat dashboard admin. Data tersimpan di `data/content.json` dan
`data/galleries.json`, jadi bisa juga di-backup/di-copy manual.

**Menambah halaman portfolio baru** (misalnya kategori baru):

1. Tambahkan definisi galeri baru di `data/galleries.json`, contoh:

   ```json
   "video": {
     "id": "video",
     "file": "portfolio-video.html",
     "href": "portfolio-video.html",
     "variant": "default",
     "kicker": "Portfolio",
     "title": "Video Editing",
     "description": "Kumpulan hasil editing video.",
     "sections": [{ "title": "", "items": [] }]
   }
   ```

2. Muat ulang dashboard. Halaman `portfolio-video.html` langsung aktif, dan
   kategori ini langsung muncul di pilihan "Halaman galeri" pada menu
   **Kartu Portfolio**.
3. Tambahkan kartunya di menu **Kartu Portfolio**.

**Ingin kembali ke versi statis?** File HTML lama ada di `legacy/`. Pindahkan
kembali ke root proyek dan buka langsung tanpa server.

**Mengubah tampilan (CSS/warna)** ada di `styles.css` (website) dan
`public/admin/admin.css` (dashboard).

---

## 6. Deploy ke hosting

Website ini butuh Node.js (bukan hosting statis). Cocok di VPS, Railway,
Render, Fly.io, atau cPanel dengan Node.js.

```bash
npm install --omit=dev
node server.js
```

- Set `PORT` bila hosting menentukan port sendiri.
- **Set `SECURE_COOKIE=true`** bila sudah memakai HTTPS (wajib, agar cookie sesi
  hanya terkirim lewat HTTPS).
- Jangan lupa mengatur `SESSION_SECRET` dan `ADMIN_PASSWORD_HASH` di environment
  hosting, dan pastikan folder `data/` serta `images/uploads/` bisa ditulis.
- Backup berkala: unduh dari **Akun & Keamanan → Unduh backup (JSON)** dan
  salin folder `images/`.

---

## 7. Perintah yang tersedia

| Perintah | Fungsi |
| --- | --- |
| `npm start` | Jalankan website + dashboard |
| `npm run dev` | Jalankan dengan auto-restart saat file berubah |
| `npm run setup` | Siapkan / reset kredensial admin |
| `npm run hash "Password"` | Buat hash bcrypt manual untuk `.env` |
| `npm run seed` | Ekstrak ulang isi dari HTML lama ke `data/*.json` |

`npm run seed` tidak menimpa data yang ada kecuali dijalankan dengan
`npm run seed -- --force` — gunakan hanya bila ingin mengembalikan isi website
ke versi HTML lama.
