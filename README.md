# Website Portofolio — Rangga Febrianto

Website portfolio + **dashboard admin** untuk mengelola seluruh isi website (CRUD),
dilindungi login yang hanya bisa diakses oleh admin.

Aplikasi ini bisa dijalankan dua cara:

| Cara | Data isi website | Gambar & video | Cocok untuk |
| --- | --- | --- | --- |
| **Lokal / VPS / Railway / Render** | file `data/*.json` | folder `images/` | paling sederhana, semua di satu tempat |
| **Vercel** | Redis (Upstash) | Vercel Blob | hosting gratis, otomatis deploy dari GitHub |

Perbedaan ini penting: Vercel **tidak punya disk yang bisa ditulis**, jadi di sana
data dan media harus berada di layanan penyimpanan. Bagian [6](#6-deploy-ke-vercel)
menjelaskan langkahnya.

---

## 1. Cara menjalankan di komputer

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

Tanpa konfigurasi tambahan, versi lokal menyimpan data di `data/*.json` dan
media di folder `images/`. Redis dan Vercel Blob opsional (lihat bagian 6).

---

## 2. Isi dashboard admin

| Menu | Yang bisa diubah |
| --- | --- |
| Dashboard | Statistik isi website + grafik pengunjung (live) + pintasan |
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

Unggah gambar/video: gunakan tombol **Unggah** (berkas baru) atau **Pilih**
(memakai gambar yang sudah ada di website).

**Grafik pengunjung** ada di menu **Dashboard**. Isinya jumlah tampilan halaman
publik (`/` dan `portfolio-*.html`) per jam untuk 24 jam terakhir, ditambah
angka **Total kunjungan**, **Hari ini**, dan **Jam ini**. Grafiknya menyegarkan
diri otomatis tiap 15 detik (tombol **Segarkan** untuk memaksa).

Catatan:

- Angka mulai terkumpul **sejak fitur ini dipasang** — tidak ada data sebelum itu.
- Bot/crawler dan admin yang sedang login **tidak** dihitung, supaya angkanya
  mencerminkan pengunjung sungguhan.
- Yang disimpan hanya angka. **Tidak ada IP, cookie, atau data pribadi.**
- Di Vercel angkanya tersimpan di Redis; saat lokal di `data/analytics.json`.
- Bucket waktu memakai WIB (UTC+7) agar label sama di laptop maupun Vercel.

---

## 3. Cara login admin dilindungi

- Password disimpan **hanya sebagai hash bcrypt** (12 rounds), tidak pernah sebagai teks biasa.
- Sesi disimpan di **cookie `HttpOnly` + `SameSite=Lax`** yang ditandatangani, jadi tidak bisa dibaca maupun dipalsukan JavaScript.
- Semua permintaan yang mengubah data wajib membawa **token CSRF**.
- **Penguncian login dimatikan secara default**, supaya salah ketik password tidak
  mengunci akun sendiri selama 15 menit. Bila ingin mengaktifkannya lagi, isi
  `LOGIN_RATE_LIMIT=on` (5 percobaan gagal per 15 menit → dikunci 15 menit;
  penghitungnya di Redis sehingga berlaku untuk semua instance).
- Halaman `/admin` ber-**noindex**, dilarang di `robots.txt`, dan tidak ada tautan menuju dashboard dari website publik.
- Berkas sensitif (`.env`, `server.js`, `data/*.json`, folder `lib/`) tidak pernah dilayani sebagai file publik.
- Unggahan berkas dibatasi jenis (gambar/video) dan ukuran (40 MB); penghapusan berkas hanya berlaku untuk berkas hasil unggahan, media lama tidak bisa terhapus dari dashboard.
- URL berbahaya (`javascript:`, `data:`) otomatis ditolak saat menyimpan data.

> Penting: jangan pernah meng-commit file `.env` (sudah ada di `.gitignore`).

---

## 4. Struktur folder

```
server.js              Aplikasi Express (website publik + API admin)
package.json
.env                   Kredensial admin (dibuat otomatis, JANGAN dibagikan)
.env.local             Kredensial hasil `vercel env pull` (JANGAN dibagikan)
.env.example           Contoh isi .env

data/
  content.json         Isi halaman utama (hero, about, portfolio, dll.)
  galleries.json       Isi halaman galeri portfolio
                       (di Vercel kedua file ini hanya jadi nilai awal)
  analytics.json       Hitungan kunjungan versi lokal (dibuat otomatis;
                       di Vercel angkanya tersimpan di Redis)

views/                 Template EJS (HTML yang dirender server)
  index.ejs            Halaman utama
  gallery.ejs          Halaman detail portfolio
  not-found.ejs        Halaman 404
  admin/login.ejs      Form login admin
  admin/dashboard.ejs  Kerangka dashboard admin

public/                Aset statis. Di Vercel folder INI yang dilayani CDN.
  styles.css           Gaya tampilan website publik
  assets/admin/        Aset dashboard (admin.css, admin.js)

lib/
  auth.js              bcrypt, rate limit, middleware login, CSRF
  config.js            Pembacaan environment variable / .env
  schema.js            Validasi + pembersihan data dari browser
  redis.js             Sambungan Redis (data + rate limit)
  store.js             Baca/tulis data (Redis atau data/*.json)
  analytics.js         Hitung kunjungan halaman publik (grafik dashboard)
  media.js             Unggah/hapus media di Vercel Blob

scripts/
  seed.mjs             Ekstrak isi dari HTML lama -> data/*.json
  setup.mjs            Siapkan / reset kredensial admin
  hash-password.mjs    Buat hash bcrypt manual
  migrate-media.mjs    Pindahkan images/ -> Vercel Blob + perbarui data
  migrate-kv.mjs       Kirim data/*.json -> Redis

images/                Gambar & video lokal (tidak ikut ke Vercel)
  uploads/             Berkas hasil unggahan saat versi lokal

legacy/                HTML statis versi lama (cadangan, tidak dipakai server)
```

---

## 5. Mengubah atau menambah isi

Cukup lewat dashboard admin.

- **Versi lokal / VPS**: data tersimpan di `data/content.json` dan
  `data/galleries.json`, jadi bisa di-backup atau di-copy manual.
- **Versi Vercel**: data tersimpan di Redis, file `data/*.json` hanya dipakai
  sebagai isi awal saat Redis masih kosong. Untuk memindahkan data lokal ke
  Redis, jalankan `npm run migrate:kv`.

**Menambah halaman portfolio baru** (misalnya kategori baru):

1. Tambahkan definisi galeri baru di `data/galleries.json` (atau lewat backup),
   contoh:

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

2. Kirim ke Redis dengan `npm run migrate:kv` (di Vercel) atau muat ulang
   dashboard (di lokal). Halaman `portfolio-video.html` langsung aktif, dan
   kategori ini muncul di pilihan "Halaman galeri" pada menu **Kartu Portfolio**.
3. Tambahkan kartunya di menu **Kartu Portfolio**.

**Ingin kembali ke versi statis?** File HTML lama ada di `legacy/`.

**Mengubah tampilan (CSS/warna)** ada di `public/styles.css` (website) dan
`public/assets/admin/admin.css` (dashboard).

---

## 6. Deploy ke Vercel

Di Vercel, `server.js` otomatis menjadi **satu Vercel Function** (tanpa konfigurasi
tambahan). Dua hal yang wajib diingat:

- `express.static()` **diabaikan** Vercel. Semua aset statis harus berada di
  folder `public/` — sudah begitu di struktur sekarang.
- Body request function dibatasi **4.5 MB**, sedangkan berkas unggahan boleh
  sampai 40 MB. Karena itu browser mengunggah **langsung ke Vercel Blob** memakai
  URL bertanda tangan dari server, bukan lewat function.

### Langkah setup

**1. Hubungkan penyimpanan**

Buka project di dashboard Vercel → tab **Storage**:

| Store | Pilihan | Dipakai untuk |
| --- | --- | --- |
| **Redis** | paket gratis | isi website + rate limit login |
| **Blob** | akses **Public** | semua gambar & video |

Dua hal yang mudah terlewat dan gejalanya membingungkan:

> **Akses Blob harus Public.** Store bertipe Private punya alamat
> `....private.blob.vercel-storage.com` yang menuntut autentikasi, sehingga
> `<img src="...">` tidak akan pernah tampil di website. Akses ditentukan saat
> store dibuat dan **tidak bisa diubah** setelahnya — kalau sudah terlanjur
> Private, buat store baru yang Public lalu hapus yang lama.
> Cek lewat CLI: `npx vercel storage inspect <nama-store>`.

> **Centang environment Development, bukan hanya Production & Preview.**
> `vercel env pull` selalu menerbitkan token OIDC bercakupan **development**
> (bisa dipastikan dari isi token: `"environment":"development"`). Kalau store
> tidak terhubung ke Development, semua operasi Blob dari laptop gagal dengan
> pesan *"OIDC is enabled for this project, but not for the development
> environment"*.
>
> Penting: environment Development **hanya bisa dipilih saat store dibuat atau
> saat pertama kali dihubungkan**. Menambahkannya belakangan lewat
> `vercel storage update -e development` akan ditolak Vercel dengan
> *"Cannot request sensitive env vars when the 'development' environment is
> targeted"*.

**Agar bisa dijalankan dari laptop**, hubungkan Blob dengan token baca-tulis
statis (selain OIDC):

```bash
npx vercel storage connect <nama-store> -e production -e preview -e development --auth oidc --add-rw-token -y
```

Token itu membuat `BLOB_READ_WRITE_TOKEN` tersedia lewat `vercel env pull`,
sehingga migrasi & unggahan bisa berjalan dari laptop tanpa bergantung pada
cakupan OIDC.

**2. Isi environment variable**

Project → **Settings → Environment Variables**:

| Nama | Nilai |
| --- | --- |
| `SESSION_SECRET` | teks acak minimal 32 karakter — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_USER` | mis. `admin` |
| `ADMIN_PASSWORD_HASH` | hasil `npm run hash "PasswordKamu123"` |
| `ADMIN_DISPLAY_NAME` | opsional, mis. `Administrator` |
| `LOGIN_RATE_LIMIT` | opsional. Kosong/`off` = penguncian mati (default). `on` = aktifkan |

Kredensial Redis dan Blob tidak perlu diisi manual — Vercel menambahkannya
sendiri saat store dihubungkan.

**3. Pindahkan media ke Blob (sekali saja)**

```bash
npx vercel env pull     # mengambil kredensial store ke .env.local
npm run migrate:media   # unggah images/ ke Blob + perbarui data/*.json
npm run migrate:kv      # kirim data ke Redis (opsional, lihat catatan)
```

Perintah `migrate:media` aman dijalankan berulang kali (berkas yang sudah ada di
Blob dilewati). Cek dulu tanpa mengunggah apa pun:

```bash
npm run migrate:media -- --dry
```

> Setelah migrasi, alamat media di `data/content.json` dan `data/galleries.json`
> berubah menjadi alamat Blob. Kalau langkah ini dilewati, gambar tidak akan
> tampil di Vercel karena folder `images/` tidak ikut di-deploy.

> **`migrate:kv` sebenarnya opsional.** Selama kunci Redis belum ada, website
> otomatis memakai isi `data/*.json` yang ikut ter-bundle ke function. Jadi
> website sudah tampil benar segera setelah deploy; `migrate:kv` hanya
> "menyalin" isi lokal ke Redis supaya Redis jadi sumber data sejak awal.

> **Variabel bertipe Secret tidak bisa dibaca ulang.** `vercel env pull` menulis
> `[SENSITIVE]` sebagai gantinya untuk `REDIS_URL`, `SESSION_SECRET`, dan
> `ADMIN_*`. Nilai itu otomatis diabaikan aplikasi (tidak dianggap kredensial),
> sehingga `npm run migrate:kv` **tidak bisa jalan hanya dari
> `vercel env pull`**. Salin `REDIS_URL` dari dashboard (project → **Storage** →
> store Redis → Quickstart), lalu tulis manual di file `.env`:

> ```bash
> REDIS_URL=rediss://default:password@xxxx.upstash.io:6379
> ```

> Simpan di `.env` (bukan `.env.local`, karena file itu ditimpa setiap
> `vercel env pull`). Setelah itu `npm run migrate:kv` bisa dijalankan.
>
> ```bash
> REDIS_URL=rediss://default:xxxxxxxx@xxxx.upstash.io:6379
> ```
>
> Simpan di `.env` (bukan `.env.local`, karena file itu ditimpa setiap
> `vercel env pull`).

> Selama kredensial store terbaca, `npm start` di laptop akan langsung bekerja
> pada **data produksi** (Redis & Blob yang sama). Jadi hati-hati saat mengedit
> isi website dari lokal. Kalau ingin mengembangkan tampilan tanpa menyentuh data
> produksi, pindahkan dulu file itu (`Rename-Item .env.local .env.local.simpan`).

**4. Berhenti melacak folder images/**

```bash
git rm -r --cached images
git add -A
git commit -m "pindahkan media ke Vercel Blob"
git push
```

Setelah ini repo jadi ringan (dari ±380 MB menjadi beberapa ratus KB) dan deploy
jauh lebih cepat.

**5. Periksa hasilnya**

Buka `https://<project>.vercel.app/`, lalu login ke `/admin`. Di menu
**Dashboard → Statistik** ada keterangan penyimpanan yang sedang dipakai.
Kalau masih tertulis `file-lokal`, berarti environment variable store belum
terbaca (di situlah letak masalah kalau store belum terhubung ke Development).

### Catatan Vercel

- **Preset project harus Express, bukan Next.js.** Kalau preset-nya Next.js,
  Vercel menjalankan `next build` dan deploy gagal dalam belasan detik dengan
  pesan `No Next.js version detected`. Berkas `vercel.json` di repo ini memaksa
  `"framework": "express"`, sehingga aman walaupun preset di dashboard keliru.
  Jangan menambahkan skrip `vercel-build` ke `package.json`: skrip itu ikut
  dijalankan Vercel dan akan gagal karena aplikasi ini tidak punya tahap build.
- Preset Express menaruh `views/` ke dalam fungsi lewat `filePathMap`. Jadi
  `views/` wajib ada; jangan memindahkannya keluar dari repo.
- **Backup lebih penting di sini**: data hidup di Redis. Unduh berkala dari
  **Akun & Keamanan → Unduh backup (JSON)**, dan simpan salinannya.
- Ganti password dari dashboard disimpan di Redis, jadi berlaku untuk semua
  instance.
- Setiap store di Vercel punya kuota gratis. Setelah media dipindahkan,
  perhatikan pemakaian bandwidth bila video berukuran besar.
- Saat menambah media baru, cukup unggah dari dashboard — berkas otomatis masuk
  ke Blob.

---

## 7. Deploy ke hosting Node biasa

Untuk VPS, Railway, Render, Fly.io, atau cPanel dengan Node.js. Cara ini tidak
memerlukan Redis maupun Blob.

```bash
npm install --omit=dev
node server.js
```

- Set `PORT` bila hosting menentukan port sendiri.
- **Set `SECURE_COOKIE=true`** bila sudah memakai HTTPS (wajib, agar cookie sesi
  hanya terkirim lewat HTTPS).
- Set `SESSION_SECRET` dan `ADMIN_PASSWORD_HASH` di environment hosting.
- Pastikan folder `data/` dan `images/uploads/` bisa ditulis (wajib, karena
  semua data dan media disimpan di situ).
- Backup berkala: unduh dari **Akun & Keamanan → Unduh backup (JSON)** dan salin
  folder `images/`.

---

## 8. Perintah yang tersedia

| Perintah | Fungsi |
| --- | --- |
| `npm start` | Jalankan website + dashboard |
| `npm run dev` | Jalankan dengan auto-restart saat file berubah |
| `npm run setup` | Siapkan / reset kredensial admin |
| `npm run hash "Password"` | Buat hash bcrypt manual untuk `ADMIN_PASSWORD_HASH` |
| `npm run seed` | Ekstrak ulang isi dari HTML lama ke `data/*.json` |
| `npm run migrate:media [-- --dry]` | Pindahkan `images/` ke Vercel Blob dan perbarui data |
| `npm run migrate:kv` | Kirim `data/*.json` ke Redis |

`npm run seed` tidak menimpa data yang ada kecuali dijalankan dengan
`npm run seed -- --force` — gunakan hanya bila ingin mengembalikan isi website
ke versi HTML lama.
