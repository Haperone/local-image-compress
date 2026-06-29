# Local Image Compress

Kompres file PNG dan JPEG langsung di vault Obsidian pada komputer Anda, tanpa layanan cloud atau API. Kurangi ruang disk yang digunakan gambar sebesar 30–70% tanpa mengorbankan kualitas.

Read in your language: [English](https://github.com/Haperone/local-image-compress/blob/main/README.md) • [العربية](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ar.md) • [Deutsch](https://github.com/Haperone/local-image-compress/blob/main/assets/README.de.md) • [Español](https://github.com/Haperone/local-image-compress/blob/main/assets/README.es.md) • [فارسی](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fa.md) • [Français](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fr.md) • [Bahasa Indonesia](https://github.com/Haperone/local-image-compress/blob/main/assets/README.id.md) • [Italiano](https://github.com/Haperone/local-image-compress/blob/main/assets/README.it.md) • [Nederlands](https://github.com/Haperone/local-image-compress/blob/main/assets/README.nl.md) • [Polski](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pl.md) • [Português](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt.md) • [Português (Brasil)](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt-br.md) • [Русский](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ru.md) • [ไทย](https://github.com/Haperone/local-image-compress/blob/main/assets/README.th.md) • [Türkçe](https://github.com/Haperone/local-image-compress/blob/main/assets/README.tr.md) • [Українська](https://github.com/Haperone/local-image-compress/blob/main/assets/README.uk.md) • [Tiếng Việt](https://github.com/Haperone/local-image-compress/blob/main/assets/README.vi.md) • [日本語](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ja.md) • [한국어](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ko.md) • [中文简体](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-cn.md) • [中文繁體](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-tw.md)

![Local Image Compress features](https://raw.githubusercontent.com/Haperone/local-image-compress/main/assets/Features.gif)

### Daftar isi
- [Fitur](#fitur)
- [Format yang didukung](#format-yang-didukung)
- [Pengaturan](#pengaturan)
- [Cara kerja](#cara-kerja)
- [Penyimpanan data dan cadangan](#penyimpanan-data-dan-cadangan)
- [Otomatisasi](#otomatisasi)
- [Interaksi dengan Paste Image Rename](#interaksi-dengan-paste-image-rename)
- [Privasi dan perilaku eksternal](#privasi-dan-perilaku-eksternal)
- [Kiat](#kiat)
- [Pertanyaan umum](#pertanyaan-umum)
- [Lisensi](#lisensi)

### Fitur
- **Kompresi lokal**: gambar PNG dan JPEG dikompres secara lokal.
- **Perintah**:
  - **Kompres semua gambar di catatan**: memproses gambar yang dirujuk atau digunakan dalam catatan aktif.
  - **Kompres semua gambar di folder**: memungkinkan Anda memilih folder dan mengompres semua gambar yang didukung di dalamnya, kecuali folder keluaran.
  - **Kompres semua gambar di vault**: memindai seluruh vault, kecuali folder keluaran.
  - **Pindahkan file terkompresi**: memindahkan hasil kompresi ke lokasi file asli. Sebelumnya, versi asli dan terkompresi dicadangkan.
- **Otomatisasi**:
  - Kompres file baru secara otomatis saat ditambahkan
  - Kompresi latar belakang setelah pengguna tidak aktif ketika jumlah gambar yang belum dikompres mencapai ambang
- **Antarmuka dan kemudahan**:
  - Menu konteks untuk file dan folder
  - Indikator penghematan ruang dengan tooltip terperinci
  - Indikator progres di bilah status
- **Keamanan dan keandalan**:
  - Cache file yang telah diproses beserta cadangannya
  - Cadangan sebelum pemindahan file terkompresi, dengan penghapusan otomatis

### Format yang didukung
- PNG (pipeline WASM `imagequant`)
- JPEG/JPG (pipeline WASM `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF, dan AVIF sengaja dilewati dalam rilis ini karena plugin tidak menyertakan encoder untuk format tersebut.

### Pengaturan

| Pengaturan | Deskripsi | Jenis/rentang | Bawaan |
|---|---|---|---|
| Kualitas PNG (min-maks) | Rentang kualitas kuantisasi PNG lossy | 1-100 (mis. `65-80`) | `65-80` |
| Kualitas JPEG | Kualitas kompresi JPEG | 1-95 | `85` |
| Akar yang diizinkan | Jalur relatif tempat kompresi diizinkan. Kosong = seluruh vault | daftar string | kosong |
| Folder keluaran | Folder tempat file terkompresi disimpan | string | `Compressed` |
| Kompres otomatis file baru | Kompres gambar baru saat ditambahkan | boolean | `false` |
| Kompresi latar belakang | Kompres di latar belakang saat tidak aktif | boolean | `true` |
| Ambang latar belakang | Jumlah gambar belum terkompresi untuk memulai kompresi latar belakang otomatis | 10-1000 | `50` |
| Ambang tidak aktif | Menit tanpa aktivitas sebelum kompresi latar belakang dimulai | 1-60 menit | `2` |
| Retensi cadangan otomatis | Hapus otomatis cadangan lama sebelum pemindahan | boolean | `false` |
| Simpan cadangan, hari | Hapus cadangan pemindahan yang lebih lama dari N hari saat retensi otomatis aktif | 1-365 | `30` |
| Pindahkan file terkompresi otomatis | Pindahkan file kembali ke lokasi gambar asli saat mulai dan ganti file asli | boolean | `false` |
| Ambang pindah otomatis | Jumlah file siap dipindahkan yang memicu pemindahan otomatis | 1-1000 | `50` |


### Cara kerja
1. File terkompresi disimpan dalam folder `Compressed` sambil mempertahankan struktur jalur asli.
2. Cache mencatat file yang diproses dan ukuran aslinya untuk mencegah kompresi berulang dan menghitung penghematan dengan benar.
3. “Pindahkan file terkompresi” mengembalikan file dari `Compressed` ke lokasi asal jika file asli berada dalam akar yang diizinkan. Cadangan dibuat sebelumnya.

File yang sangat kecil biasanya dilewati (`<5KB` untuk PNG dan `<10KB` untuk JPEG).

Batas keamanan internal bersifat tetap: file lebih besar dari `100 MB` dilewati sebelum dibaca, dan gambar di atas `100 juta` piksel dilewati setelah validasi header.

### Penyimpanan data dan cadangan
- **Cache utama:** disimpan dalam folder plugin.
- **Cadangan cache:** disimpan di `Vault/.local-image-compress/backups/cache/`; maksimal 50 file dipertahankan.
- **Cadangan gambar:** disimpan di `Vault/.local-image-compress/backups/originals/`; dibuat sebelum file asli diganti.

### Otomatisasi
- Mengaktifkan “Kompresi latar belakang” menyediakan dua slider:
  - Ambang kompresi latar belakang: 10–1000 gambar, bawaan 50.
  - Ambang tidak aktif: 1–60 menit, bawaan 2.
- Mengaktifkan “Simpan cadangan, hari” menampilkan slider masa retensi.
- Mengaktifkan “Pindahkan file terkompresi otomatis” menampilkan ambang jumlah file. Saat mulai, pemindahan berlangsung jika jumlah file dalam `Compressed` mencapai atau melebihi ambang.

### Interaksi dengan Paste Image Rename

Plugin ini menonaktifkan sementara plugin pihak ketiga `obsidian-paste-image-rename` selama kompresi atau pemindahan. Perlindungan ini tidak dapat dimatikan karena pemetaan hasil kompresi ke file asli bergantung pada file baru yang tidak diganti namanya oleh plugin lain.

<details>
<summary>Mengapa perlindungan ini diperlukan</summary>

Mengapa diperlukan:

- Paste Image Rename mendaftarkan handler `vault.on("create")` yang berjalan untuk setiap gambar yang ditambahkan ke vault sekitar satu detik setelah dibuat. Handler selalu memproses nama yang diawali `Pasted image `, dan semua gambar lain jika “Handle all attachments” aktif.
- Salinan terkompresi yang ditulis ke folder keluaran memicu handler tersebut. Dengan tampilan Markdown aktif, handler mengganti nama hasil dan merusak pemetaan untuk pemindahan, atau menampilkan dialog ganti nama bagi setiap file. Tanpa tampilan aktif, pesan `Error: No active file found` muncul bagi setiap file dan memenuhi antarmuka selama pemrosesan massal.
- Obsidian tidak memiliki API publik agar satu plugin dapat menjeda plugin lain. Menonaktifkan sementara plugin ini saja merupakan satu-satunya solusi yang andal.

Penanganan yang aman:

- Hanya ID `obsidian-paste-image-rename` yang terpengaruh, dan hanya selama kompresi atau pemindahan.
- Plugin dipulihkan setelahnya, dengan percobaan ulang bila perlu, kecuali statusnya berubah secara eksternal. Pelindung mencatat apakah ia yang menonaktifkan plugin dan tidak memulihkannya setelah perubahan semacam itu.
- Pengaktifan dan penonaktifan memakai API internal Obsidian `app.plugins` karena tidak ada padanan publik. Ketersediaan fitur diperiksa dan galat ditangani dengan baik.

</details>

### Privasi dan perilaku eksternal

- **Jaringan**: plugin tidak membuat permintaan jaringan saat berjalan. Codec PNG/JPEG disertakan dalam `main.js`; gambar tidak diunggah.
- **Telemetri dan iklan**: tidak ada analitik, telemetri, pelaporan crash, pelacakan, iklan dinamis, atau mekanisme pembaruan mandiri.
- **Akun dan pembayaran**: tidak perlu akun, langganan, kunci lisensi, atau pembayaran. Tautan pendanaan opsional dalam manifest tidak pernah diakses plugin.
- **File vault**: plugin membaca gambar yang dipilih oleh perintah, otomatisasi, atau akar yang diizinkan. Hasil ditulis ke folder relatif vault yang dikonfigurasi; file asli hanya diganti melalui alur pindah manual atau otomatis yang didokumentasikan setelah cadangan dibuat.
- **Status lokal**: data cache disimpan dalam folder plugin. Cadangan cache dan pemindahan berada di bawah `Vault/.local-image-compress/backups/`.
- **File eksternal**: data yang dikelola plugin tetap di vault saat ini. Tindakan “Buka folder” hanya meminta sistem operasi menampilkan folder cadangan yang didokumentasikan dan tidak mengirim data.
- **Plugin lain**: `obsidian-paste-image-rename` dapat dinonaktifkan sementara seperti dijelaskan di atas, lalu dipulihkan dengan pemeriksaan kepemilikan perubahan.

### Kiat
- Rentang kualitas yang wajar: PNG `65-80`, JPEG `75-90`.
- Atur “Akar yang diizinkan” jika hanya ingin mengompres folder tertentu, seperti `files/` atau `images/`.
- Gunakan kompresi latar belakang ketika vault memiliki banyak gambar yang belum dikompres.

### Pertanyaan umum
**Plugin melaporkan bahwa modul WebAssembly gagal diinisialisasi.**
Muat ulang plugin. Jika galat berulang, sertakan versi Obsidian, platform, dan galat konsol dalam laporan bug.

**Di mana file terkompresi disimpan?**
Secara bawaan di `Compressed`. Untuk mengganti file asli, gunakan “Pindahkan file terkompresi”.

**Bagaimana penghematan dihitung?**
Perhitungan tepat jika cache memiliki ukuran asli dan keluaran. Untuk PNG/JPEG yang belum dikompres, plugin memakai perkiraan konservatif dengan rasio terbatas; ukuran file terkompresi saat ini dibaca dari disk bila perlu.

### Lisensi
GPL-3.0-or-later. Lisensi dan pemberitahuan pihak ketiga: [THIRD_PARTY_NOTICES.md](https://github.com/Haperone/local-image-compress/blob/main/THIRD_PARTY_NOTICES.md).
