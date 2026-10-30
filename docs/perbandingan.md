# Perbandingan

Dibandingkan pada 29 Oktober 2026, dari kode sumber masing-masing proyek.

## 1. Lirik: lyrics-plus vs Spotify Helper

[lyrics-plus](https://github.com/spicetify/cli/tree/main/CustomApps/lyrics-plus) adalah custom app bawaan
Spicetify. Untuk Jepang dan Mandarin, mesin romanisasinya sama dengan app ini: kuroshiro + kuromoji (Jepang)
dan pinyin-pro (Mandarin). Jadi hasil romaji Jepangnya seharusnya sama.

| | **lyrics-plus** | **Spotify Helper** |
|---|---|---|
| Tempat | Hanya di Spotify desktop (Spicetify) | Di mana saja: HP, laptop, tablet (web/PWA) |
| Sumber lirik | Musixmatch, Netease, LRCLIB, Genius (tanpa sinkron), file lokal | LRCLIB, plus cache bersama di Firebase |
| Karaoke per kata | ✅ Kalau datanya tersedia (dari Musixmatch) | ❌ Per baris |
| Jepang | Romaji, Hiragana, Katakana, Furigana | Romaji (Hepburn) |
| Korea | Romaja (`aromanize`) | Romaja (`@romanize/korean`) |
| Mandarin | Pinyin, plus konversi aksara Tradisional ⇄ Sederhana (OpenCC) | Pinyin |
| Deteksi bahasa | Ambang deteksi Jepang/Mandarin yang bisa diatur | Otomatis per lagu (ada kana = Jepang) |
| Delay sinkron | Delay global (`global-delay`) | Offset global di ⚙ |
| Tampilan | Warna, ukuran font, perataan, jumlah baris sebelum/sesudah, blur | Ukuran romaji dan teks asli, 3 warna, teks asli bisa disembunyikan |
| Cache | Hanya di device itu | Di device, plus dibagikan ke pendengar lewat Firebase (HP tidak perlu mengunduh kamus Jepang 12 MB) |

**Belum dipastikan:** apakah lyrics-plus punya terjemahan lewat Musixmatch. `Translator.js` di dalamnya hanya
menangani konversi (romaji, furigana, pinyin, dan sejenisnya), bukan terjemahan.

**Ringkasnya:** untuk diri sendiri di laptop, lyrics-plus lebih kaya fitur. Spotify Helper unggul di HP dan
untuk membagikan lirik romaji ke semua orang di room.

## 2. Dengar bersama: Listen Along vs spicetify-jam

[spicetify-jam](https://github.com/Kyzenkms/spicetify-jam) dicek pada commit `356e679` (1 Oktober 2026).

| | **Listen Along (Spotify Helper)** | **spicetify-jam** |
|---|---|---|
| Siapa yang bisa ikut | Host: web atau Spicetify. Pendengar: HP (web, Spotify Embed), extension browser (YouTube, YouTube Music, Spotify Web), atau Spicetify | Hanya sesama pengguna Spicetify di desktop |
| Koneksi | Firebase Realtime Database (server pusat), jalan di jaringan mana pun | P2P (WebRTC via PeerJS + relay TURN). README mereka sendiri menyebut bisa gagal di jaringan kampus, kantor, atau seluler |
| Queue | Pendengar request, host menyetujui dengan **+ Queue**. Ada daftar "Antrian berikutnya" | Queue bersama: semua orang bisa menambah, menghapus, dan mengurutkan |
| Kontrol untuk tamu | ❌ Hanya host | ✅ "Pass the aux": host bisa memberi kontrol ke tamu |
| Kehadiran | Nama dan platform. Kick ditegakkan oleh rules database | Avatar dengan foto profil Spotify |
| Undangan | Kode 6 karakter dan link | Kode 6 karakter, link, dan QR |
| Lirik romaji untuk semua | ✅ | ❌ |
| Persiapan lagu berikutnya | ✅ Lirik dan video disiapkan, lalu pindah tepat saat lagu habis | Belum dicek |
| Tampilan | Jendela dari tombol di bar atas | Sidebar dan mini player |
| Privasi | Database sendiri | Versi asli mengirim telemetri tersembunyi (ID device permanen, heartbeat 30 menit, event sesi) ke server pribadi pembuatnya |
| Lisensi | Milik sendiri | Tidak ada file LICENSE (README menyebut MIT), jadi kodenya tidak boleh disalin |

Batasan yang sama untuk kedua extension Spicetify: hanya desktop, termasuk area abu-abu aturan Spotify, bisa
rusak setiap kali Spotify update (perbaiki dengan `spicetify backup apply`), dan iklan di akun Free membuat
sinkron lepas sebentar.

**Ringkasnya:** spicetify-jam lebih lengkap untuk pesta mendengar di laptop (queue bersama, kontrol tamu,
avatar). Listen Along unggul kalau pendengarnya campuran HP dan laptop, kalau butuh lirik romaji, atau kalau
jaringannya membuat P2P gagal.

## Instalasi di laptop ini

- **lyrics-plus:** `spicetify config custom_apps lyrics-plus` lalu `spicetify apply`.
- **spicetify-jam:** dibuild dari source di `%LOCALAPPDATA%\spicetify-jam-src` dengan telemetri dihapus
  (`__ping` di `src/app.tsx` dan dua `sendBeacon` di `src/JamContext.tsx`), bukan lewat installer satu baris.
  Untuk update, tarik source terbaru, hapus telemetrinya lagi, lalu jalankan `npm run build-local` dan salin
  `dist/spicetify-jam.js` ke `%APPDATA%\spicetify\Extensions`.
- **Listen Along:** `spicetify-listen-along.js` dari dialog 🧩 Extension di situs.

Jangan menjalankan room spicetify-jam dan Listen Along bersamaan, karena keduanya mengontrol player Spotify.
