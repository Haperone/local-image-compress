# Local Image Compress

PNG ve JPEG dosyalarını bulut hizmetleri veya API kullanmadan doğrudan bilgisayarınızdaki Obsidian kasasında sıkıştırın. Görsellerin kullandığı disk alanını kaliteyi düşürmeden %30–70 azaltın.

Read in your language: [English](../README.md) • [العربية](README.ar.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [فارسی](README.fa.md) • [Français](README.fr.md) • [Bahasa Indonesia](README.id.md) • [Italiano](README.it.md) • [Nederlands](README.nl.md) • [Polski](README.pl.md) • [Português](README.pt.md) • [Português (Brasil)](README.pt-br.md) • [Русский](README.ru.md) • [ไทย](README.th.md) • [Türkçe](README.tr.md) • [Українська](README.uk.md) • [Tiếng Việt](README.vi.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [中文简体](README.zh-cn.md) • [中文繁體](README.zh-tw.md)

![Local Image Compress features](Features.gif)

### İçindekiler
- [Özellikler](#özellikler)
- [Desteklenen biçimler](#desteklenen-biçimler)
- [Ayarlar](#ayarlar)
- [Çalışma şekli](#çalışma-şekli)
- [Veri depolama ve yedekler](#veri-depolama-ve-yedekler)
- [Otomasyon](#otomasyon)
- [Paste Image Rename ile etkileşim](#paste-image-rename-ile-etkileşim)
- [Gizlilik ve dış davranış](#gizlilik-ve-dış-davranış)
- [İpuçları](#i̇puçları)
- [Sık sorulan sorular](#sık-sorulan-sorular)
- [Lisans](#lisans)

### Özellikler
- **Yerel sıkıştırma**: PNG ve JPEG görselleri yerel olarak sıkıştırılır.
- **Komutlar**:
  - **Nottaki tüm görselleri sıkıştır**: etkin notta başvurulan veya kullanılan görselleri işler.
  - **Klasördeki tüm görselleri sıkıştır**: klasör seçtirir ve çıktı klasörü dışındaki desteklenen görselleri sıkıştırır.
  - **Kasadaki tüm görselleri sıkıştır**: çıktı klasörü dışında tüm kasayı tarar.
  - **Sıkıştırılmış dosyaları taşı**: sonuçları özgün konumlara taşır; önce özgün ve sıkıştırılmış sürümleri yedekler.
- **Otomasyon**:
  - Yeni dosyaları eklendiklerinde otomatik sıkıştır
  - Sıkıştırılmamış görsel sayısı eşiğe ulaştığında kullanıcı hareketsizliğinden sonra arka planda sıkıştır
- **Arayüz ve kolaylık**:
  - Dosya ve klasörler için bağlam menüsü
  - Ayrıntılı araç ipucuyla alan tasarrufu göstergesi
  - Durum çubuğu ilerleme göstergesi
- **Güvenlik ve güvenilirlik**:
  - İşlenen dosyaların önbelleği ve önbellek yedekleri
  - Sıkıştırılmış dosyaları taşımadan önce yedekleme ve otomatik silme

### Desteklenen biçimler
- PNG (`imagequant` WASM işlem hattı)
- JPEG/JPG (`mozjpeg` WASM işlem hattı)

WebP, GIF, BMP, HEIC/HEIF ve AVIF, eklenti bu biçimlerin kodlayıcılarını içermediği için bu sürümde bilerek atlanır.

### Ayarlar

| Ayar | Açıklama | Tür/aralık | Varsayılan |
|---|---|---|---|
| PNG kalitesi (min-maks) | Kayıplı PNG niceleme kalite aralığı | 1-100 (örn. `65-80`) | `65-80` |
| JPEG kalitesi | JPEG sıkıştırma kalitesi | 1-95 | `85` |
| İzin verilen kökler | Sıkıştırmaya izin verilen göreli yollar. Boş = tüm kasa | dize listesi | boş |
| Çıktı klasörü | Sıkıştırılmış dosyaların kaydedildiği klasör | dize | `Compressed` |
| Yeni dosyaları otomatik sıkıştır | Yeni görselleri eklendiklerinde sıkıştır | mantıksal | `false` |
| Arka plan sıkıştırması | Hareketsizlikte arka planda sıkıştır | mantıksal | `true` |
| Arka plan eşiği | Otomatik başlatma için gereken sıkıştırılmamış görsel sayısı | 10-1000 | `50` |
| Hareketsizlik eşiği | Arka plan sıkıştırmasından önce etkinliksiz dakika | 1-60 dakika | `2` |
| Otomatik yedek saklama | Taşıma öncesi eski yedekleri otomatik sil | mantıksal | `false` |
| Yedekleri tut, gün | Saklama etkinse N günden eski taşıma yedeklerini sil | 1-365 | `30` |
| Sıkıştırılmış dosyaları otomatik taşı | Başlangıçta dosyaları özgün konumlara taşıyıp orijinalleri değiştir | mantıksal | `false` |
| Otomatik taşıma eşiği | Otomatik taşımayı başlatan hazır dosya sayısı | 1-1000 | `50` |


### Çalışma şekli
1. Sıkıştırılmış dosyalar özgün yol yapısı korunarak `Compressed` klasörüne kaydedilir.
2. Önbellek, yinelenen sıkıştırmayı önlemek ve tasarrufu doğru hesaplamak için işlenen dosyaları ve özgün boyutları kaydeder.
3. “Sıkıştırılmış dosyaları taşı”, özgün dosya izin verilen bir kökteyse dosyaları `Compressed` konumundan geri taşır. Önce yedek oluşturulur.

Çok küçük dosyalar genellikle atlanır (PNG için `<5KB`, JPEG için `<10KB`).

İç güvenlik sınırları sabittir: `100 MB` üzerindeki dosyalar okunmadan, `100 milyon` piksel üzerindeki görseller başlık doğrulamasından sonra atlanır.

### Veri depolama ve yedekler
- **Ana önbellek:** eklenti klasöründe saklanır.
- **Önbellek yedekleri:** `Vault/.local-image-compress/backups/cache/` içinde saklanır; en fazla 50 dosya tutulur.
- **Görsel yedekleri:** `Vault/.local-image-compress/backups/originals/` içinde saklanır; orijinaller değiştirilmeden önce oluşturulur.

### Otomasyon
- “Arka plan sıkıştırması” iki kaydırıcıyı kullanılabilir yapar:
  - Arka plan sıkıştırma eşiği: 10–1000 görsel, varsayılan 50.
  - Hareketsizlik eşiği: 1–60 dakika, varsayılan 2.
- “Yedekleri tut, gün” saklama süresi kaydırıcısını gösterir.
- “Sıkıştırılmış dosyaları otomatik taşı” dosya sayısı eşiğini gösterir. Başlangıçta `Compressed` içindeki sayı eşiğe ulaştığında veya aştığında taşıma başlar.

### Paste Image Rename ile etkileşim

Bu eklenti sıkıştırma veya taşıma sırasında `obsidian-paste-image-rename` eklentisini geçici olarak devre dışı bırakır. Sıkıştırılmış çıktının özgün dosyayla eşleşmesi, yeni dosyaların başka bir eklenti tarafından yeniden adlandırılmamasına bağlı olduğundan bu koruma kapatılamaz.

<details>
<summary>Bu koruma neden gerekli</summary>

Neden gereklidir:

- Paste Image Rename, kasaya eklenen her görsel için oluşturulmasından yaklaşık bir saniye sonra çalışan bir `vault.on("create")` işleyicisi kaydeder. `Pasted image ` ile başlayan adları her zaman, “Handle all attachments” açıksa diğer tüm görselleri işler.
- Çıktı klasörüne yazılan kopyalar bu işleyiciyi tetikler. Etkin Markdown görünümünde çıktıyı yeniden adlandırıp taşıma eşleşmesini bozar veya her dosya için yeniden adlandırma iletişim kutusu gösterir. Etkin görünüm yoksa her dosyada `Error: No active file found` göstererek toplu işlem sırasında arayüzü hatalarla doldurur.
- Obsidian, bir eklentinin diğerini duraklatmasını sağlayan genel API sunmaz. Yalnızca bu eklentiyi geçici olarak kapatmak tek güvenilir çözümdür.

Güvenli işleme:

- Yalnızca bilinen `obsidian-paste-image-rename` kimliği ve yalnızca sıkıştırma veya taşıma sırasında etkilenir.
- Eklenti daha sonra gerekirse yeniden denenerek geri yüklenir; durumu dışarıdan değişirse geri yüklenmez. Koruma, eklentiyi kendisinin kapatıp kapatmadığını kaydeder ve böyle bir değişiklikten sonra geri yüklemeyi denemez.
- Genel eşdeğeri olmadığından etkinleştirme ve devre dışı bırakma Obsidian'ın dahili `app.plugins` API'sini kullanır. Özelliklerin varlığı denetlenir ve hatalar düzgün işlenir.

</details>

### Gizlilik ve dış davranış

- **Ağ**: çalışma zamanında ağ isteği yoktur. PNG/JPEG codec'leri `main.js` içindedir; görseller yüklenmez.
- **Telemetri ve reklamlar**: analiz, telemetri, çökme raporu, izleme, dinamik reklam veya otomatik güncelleme yoktur.
- **Hesaplar ve ödemeler**: hesap, abonelik, lisans anahtarı veya ödeme gerekmez. Eklenti manifestteki isteğe bağlı destek bağlantısına erişmez.
- **Kasa dosyaları**: komutlar, otomasyon veya izin verilen köklerle seçilen görseller okunur. Çıktı yapılandırılan göreli klasöre yazılır; orijinaller yalnızca yedek sonrası belgelenen manuel veya otomatik taşıma ile değiştirilir.
- **Yerel durum**: önbellek eklenti klasöründedir. Önbellek ve taşıma yedekleri `Vault/.local-image-compress/backups/` altındadır.
- **Harici dosyalar**: yönetilen veriler geçerli kasada kalır. “Klasörü aç” yalnızca işletim sisteminden belgelenen klasörleri göstermesini ister, veri aktarmaz.
- **Diğer eklentiler**: `obsidian-paste-image-rename` yukarıda açıklandığı gibi geçici kapatılabilir ve durum değişikliğinin sahibi denetlenerek geri yüklenir.

### İpuçları
- Uygun kalite aralıkları: PNG `65-80`, JPEG `75-90`.
- Yalnızca `files/` veya `images/` gibi klasörleri sıkıştırmak için “İzin verilen kökler”i ayarlayın.
- Kasada çok sayıda sıkıştırılmamış görsel varsa arka plan sıkıştırmasını kullanın.

### Sık sorulan sorular
**Eklenti WebAssembly modüllerinin başlatılamadığını bildiriyor.**
Eklentiyi yeniden yükleyin. Hata tekrarlanırsa rapora Obsidian sürümünü, platformu ve konsol hatasını ekleyin.

**Sıkıştırılmış dosyalar nerede saklanır?**
Varsayılan olarak `Compressed` içinde. Orijinalleri değiştirmek için “Sıkıştırılmış dosyaları taşı”yı kullanın.

**Tasarruf nasıl hesaplanır?**
Önbellek özgün ve çıktı boyutlarını içeriyorsa hesap kesindir. Sıkıştırılmamış PNG/JPEG için sınırlı oranlı ihtiyatlı tahminler kullanılır; güncel boyutlar gerektiğinde diskten okunur.

### Lisans
GPL-3.0-or-later. Üçüncü taraf lisansları ve bildirimleri: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
