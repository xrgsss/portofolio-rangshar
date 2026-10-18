/**
 * scripts/hash-password.mjs
 * ---------------------------------------------------------------------------
 * Membuat hash bcrypt untuk sebuah password.
 *
 * Contoh:
 *   npm run hash "PasswordBaruSaya123"
 *   npm run hash            (lalu ketik password saat diminta)
 *
 * Salin hasilnya ke .env pada baris ADMIN_PASSWORD_HASH.
 * Cara paling mudah tetap lewat dashboard admin: menu "Akun & Keamanan".
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

const askHidden = (question) =>
  new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      // Bukan terminal interaktif (mis. dipipe): baca baris biasa.
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        data += chunk;
        const newline = data.indexOf('\n');
        if (newline !== -1) {
          stdin.pause();
          process.stdout.write('\n');
          resolve(data.slice(0, newline).trim());
        }
      });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let buffer = '';
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buffer.trim());
          break;
        case '\u0003': // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
          break;
        case '\u007f': // Backspace
        case '\b':
          buffer = buffer.slice(0, -1);
          break;
        default:
          buffer += char;
          break;
      }
    };

    stdin.on('data', onData);
  });

const main = async () => {
  let password = process.argv[2];

  if (!password) {
    password = await askHidden('Password admin baru: ');
  }

  if (!password || password.length < 10) {
    console.error('✖  Password minimal 10 karakter.');
    process.exit(1);
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    console.error('✖  Password harus mengandung huruf dan angka.');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, ROUNDS);

  console.log('\nTambahkan baris berikut ke file .env:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);

  // Pemeriksaan cepat.
  const ok = bcrypt.compareSync(password, hash);
  console.log(ok ? '✔  Hash terverifikasi.' : '⚠  Verifikasi hash gagal.');
  console.log(`   (cadangan: ${crypto.createHash('sha256').update(password).digest('hex').slice(0, 12)}…)`);
};

main().catch((error) => {
  console.error('✖  Gagal:', error.message);
  process.exit(1);
});
