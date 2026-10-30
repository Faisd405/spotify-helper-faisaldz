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

Diperbarui 30 Oktober 2026. [spicetify-jam](https://github.com/Kyzenkms/spicetify-jam) dicek pada commit
`356e679` (1 Oktober 2026, belum ada perubahan sejak itu).

### Yang sekarang setara

| Fitur | Listen Along | spicetify-jam |
|---|---|---|
| Panel samping di Spotify desktop | ✅ Ikut tema Spicetify | ✅ |
| Mini player saat panel dikecilkan | ✅ | ✅ |
| Undangan: kode 6 karakter, link, QR | ✅ | ✅ |
| Now playing dengan cover dan progress | ✅ | ✅ |
| Anggota dengan avatar dan badge host | ✅ | ✅ |
| Queue bersama: tambah, hapus, urutkan (drag), putar sekarang | ✅ | ✅ |
| "Added by" di tiap lagu | ✅ | ✅ |
| Klik kanan lagu → tambah ke queue | ✅ | ✅ |
| Kontrol untuk tamu (play/pause/next/prev) | ✅ Toggle host | ✅ Toggle host |
| Kick | ✅ | ✅ |

### Yang hanya ada di Listen Along

| Fitur | Keterangan |
|---|---|
| Pendengar dari **HP, web, YouTube, YouTube Music** | spicetify-jam hanya untuk sesama pengguna Spicetify di desktop |
| **Lirik romaji** untuk semua orang | Dengan cache bersama, jadi HP tidak perlu mengunduh kamus Jepang |
| **Up next** dari Spotify | Ditampilkan setelah queue room, plus baris "Berikutnya" |
| **Persetujuan lagu** | Opsi "Lagu dari tamu perlu disetujui" |
| **Persiapan lagu berikutnya** | Lirik dan video disiapkan lebih dulu, lalu pindah tepat saat lagu habis |
| **Gabung dari web ke Spotify desktop** | Link `spotify:search:listenalong-<kode>` |
| Host bisa dari **web** | Dengan Spotify Premium dan login Web API; atau dari Spicetify |
| **Kick dan izin ditegakkan server** | Rules Firebase: yang di-kick tidak bisa membaca room atau mengirim apa pun |
| **Jalan di jaringan ketat** | Firebase (server pusat), bukan P2P yang bisa gagal di NAT kampus, kantor, atau seluler |
| **Tanpa telemetri** | spicetify-jam asli mengirim telemetri tersembunyi ke server pribadi pembuatnya |

### Yang masih lebih baik di spicetify-jam

| Fitur | spicetify-jam | Listen Along sekarang |
|---|---|---|
| **Ketepatan sinkron** | Host mengecek setiap 400 ms, seek terkirim seketika, tamu dikoreksi kalau selisih lebih dari 160 ms (dengan filter) | Host Spicetify mengirim saat ganti lagu/play/pause **dan setiap 3 detik**; seek baru terkirim hingga 3 detik kemudian; toleransi selisih **2 detik** |
| **Kecepatan sampai ke tamu** | P2P langsung (puluhan ms) | Web: push Firebase (sekitar 100–300 ms). Spicetify dan extension: polling setiap 1–1,5 detik |
| **Seek dengan klik progress bar** | ✅ Host, atau tamu kalau diizinkan | ❌ Belum ada (perintah `seek` sudah didukung, tapi belum ada tombol/bar untuk memakainya) |
| **Tanpa server** | Tidak butuh database | Butuh Firebase (paket gratis cukup) |
| Durasi di queue dari pencarian | Ada | Lagu yang ditambah lewat pencarian di Spicetify belum punya durasi |

### Kesimpulan

Untuk **fitur dan tampilan**, Listen Along sekarang setara dan lebih luas (HP, web, YouTube, lirik romaji). Yang masih
tertinggal adalah **ketepatan sinkron**. Perbaikannya sudah direncanakan sebagai Phase 5: cek posisi host setiap
400 ms dan kirim seek seketika, streaming Firebase untuk pendengar, toleransi sekitar 300 ms dengan filter, dan
progress bar yang bisa diklik.

## Instalasi di laptop ini

- **lyrics-plus:** `spicetify config custom_apps lyrics-plus` lalu `spicetify apply`.
- **spicetify-jam:** dibuild dari source di `%LOCALAPPDATA%\spicetify-jam-src` dengan telemetri dihapus
  (`__ping` di `src/app.tsx` dan dua `sendBeacon` di `src/JamContext.tsx`), bukan lewat installer satu baris.
  Untuk update, tarik source terbaru, hapus telemetrinya lagi, lalu jalankan `npm run build-local` dan salin
  `dist/spicetify-jam.js` ke `%APPDATA%\spicetify\Extensions`.
- **Listen Along:** `spicetify-listen-along.js` dari dialog 🧩 Extension di situs.

Jangan menjalankan room spicetify-jam dan Listen Along bersamaan, karena keduanya mengontrol player Spotify.
