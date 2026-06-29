# Local Image Compress

Nén tệp PNG và JPEG trực tiếp trong kho Obsidian trên máy tính, không dùng dịch vụ đám mây hay API. Giảm 30–70% dung lượng đĩa do hình ảnh chiếm dụng mà không làm giảm chất lượng.

Read in your language: [English](https://github.com/Haperone/local-image-compress/blob/main/README.md) • [العربية](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ar.md) • [Deutsch](https://github.com/Haperone/local-image-compress/blob/main/assets/README.de.md) • [Español](https://github.com/Haperone/local-image-compress/blob/main/assets/README.es.md) • [فارسی](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fa.md) • [Français](https://github.com/Haperone/local-image-compress/blob/main/assets/README.fr.md) • [Bahasa Indonesia](https://github.com/Haperone/local-image-compress/blob/main/assets/README.id.md) • [Italiano](https://github.com/Haperone/local-image-compress/blob/main/assets/README.it.md) • [Nederlands](https://github.com/Haperone/local-image-compress/blob/main/assets/README.nl.md) • [Polski](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pl.md) • [Português](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt.md) • [Português (Brasil)](https://github.com/Haperone/local-image-compress/blob/main/assets/README.pt-br.md) • [Русский](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ru.md) • [ไทย](https://github.com/Haperone/local-image-compress/blob/main/assets/README.th.md) • [Türkçe](https://github.com/Haperone/local-image-compress/blob/main/assets/README.tr.md) • [Українська](https://github.com/Haperone/local-image-compress/blob/main/assets/README.uk.md) • [Tiếng Việt](https://github.com/Haperone/local-image-compress/blob/main/assets/README.vi.md) • [日本語](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ja.md) • [한국어](https://github.com/Haperone/local-image-compress/blob/main/assets/README.ko.md) • [中文简体](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-cn.md) • [中文繁體](https://github.com/Haperone/local-image-compress/blob/main/assets/README.zh-tw.md)

![Local Image Compress features](https://raw.githubusercontent.com/Haperone/local-image-compress/main/assets/Features.gif)

### Mục lục
- [Tính năng](#tính-năng)
- [Định dạng được hỗ trợ](#định-dạng-được-hỗ-trợ)
- [Cài đặt](#cài-đặt)
- [Cách hoạt động](#cách-hoạt-động)
- [Lưu trữ dữ liệu và sao lưu](#lưu-trữ-dữ-liệu-và-sao-lưu)
- [Tự động hóa](#tự-động-hóa)
- [Tương tác với Paste Image Rename](#tương-tác-với-paste-image-rename)
- [Quyền riêng tư và hoạt động bên ngoài](#quyền-riêng-tư-và-hoạt-động-bên-ngoài)
- [Mẹo](#mẹo)
- [Câu hỏi thường gặp](#câu-hỏi-thường-gặp)
- [Giấy phép](#giấy-phép)

### Tính năng
- **Nén cục bộ**: nén hình ảnh PNG và JPEG ngay trên máy.
- **Lệnh**:
  - **Nén mọi hình ảnh trong ghi chú**: xử lý hình ảnh được tham chiếu hoặc sử dụng trong ghi chú đang hoạt động.
  - **Nén mọi hình ảnh trong thư mục**: cho phép chọn thư mục và nén mọi ảnh được hỗ trợ, trừ thư mục đầu ra.
  - **Nén mọi hình ảnh trong kho**: quét toàn bộ kho, trừ thư mục đầu ra.
  - **Di chuyển tệp đã nén**: chuyển kết quả về vị trí tệp gốc; trước đó sao lưu cả phiên bản gốc và phiên bản đã nén.
- **Tự động hóa**:
  - Tự động nén tệp mới khi được thêm
  - Nén nền sau khi người dùng không hoạt động và số ảnh chưa nén đạt ngưỡng
- **Giao diện và tiện ích**:
  - Menu ngữ cảnh cho tệp và thư mục
  - Chỉ báo dung lượng tiết kiệm kèm chú giải chi tiết
  - Chỉ báo tiến trình trên thanh trạng thái
- **An toàn và tin cậy**:
  - Bộ nhớ đệm của tệp đã xử lý cùng bản sao lưu
  - Sao lưu trước khi di chuyển tệp đã nén, có thể tự động xóa

### Định dạng được hỗ trợ
- PNG (quy trình WASM `imagequant`)
- JPEG/JPG (quy trình WASM `mozjpeg`)

WebP, GIF, BMP, HEIC/HEIF và AVIF được chủ ý bỏ qua trong bản phát hành này vì plugin không kèm bộ mã hóa cho các định dạng đó.

### Cài đặt

| Cài đặt | Mô tả | Kiểu/phạm vi | Mặc định |
|---|---|---|---|
| Chất lượng PNG (tối thiểu-tối đa) | Phạm vi chất lượng lượng tử hóa PNG có mất dữ liệu | 1-100 (ví dụ `65-80`) | `65-80` |
| Chất lượng JPEG | Chất lượng nén JPEG | 1-95 | `85` |
| Gốc được phép | Đường dẫn tương đối được phép nén. Trống = toàn bộ kho | danh sách chuỗi | trống |
| Thư mục đầu ra | Nơi lưu tệp đã nén | chuỗi | `Compressed` |
| Tự động nén tệp mới | Nén hình ảnh mới khi được thêm | boolean | `false` |
| Nén nền | Nén trong nền khi không hoạt động | boolean | `true` |
| Ngưỡng nén nền | Số ảnh chưa nén cần có để tự động bắt đầu | 10-1000 | `50` |
| Ngưỡng không hoạt động | Số phút không có hoạt động trước khi nén nền | 1-60 phút | `2` |
| Tự động giữ bản sao lưu | Tự động xóa bản sao lưu cũ trước khi di chuyển | boolean | `false` |
| Giữ bản sao lưu, ngày | Xóa bản sao di chuyển cũ hơn N ngày khi tính năng giữ tự động bật | 1-365 | `30` |
| Tự động di chuyển tệp đã nén | Khi khởi động, chuyển tệp về vị trí ảnh gốc và thay thế tệp gốc | boolean | `false` |
| Ngưỡng tự động di chuyển | Số tệp sẵn sàng cần có để kích hoạt tự động di chuyển | 1-1000 | `50` |


### Cách hoạt động
1. Tệp đã nén được lưu trong `Compressed` và giữ nguyên cấu trúc đường dẫn ban đầu.
2. Bộ nhớ đệm ghi lại tệp đã xử lý và kích thước gốc để tránh nén lặp và tính chính xác dung lượng tiết kiệm.
3. “Di chuyển tệp đã nén” đưa tệp từ `Compressed` về vị trí ban đầu nếu tệp gốc nằm trong một gốc được phép. Bản sao lưu được tạo trước.

Tệp rất nhỏ thường được bỏ qua (PNG `<5KB`, JPEG `<10KB`).

Giới hạn an toàn nội bộ được cố định: tệp lớn hơn `100 MB` bị bỏ qua trước khi đọc, và ảnh trên `100 triệu` pixel bị bỏ qua sau khi xác thực phần đầu tệp.

### Lưu trữ dữ liệu và sao lưu
- **Bộ nhớ đệm chính:** lưu trong thư mục plugin.
- **Bản sao bộ nhớ đệm:** lưu tại `Vault/.local-image-compress/backups/cache/`; giữ tối đa 50 tệp.
- **Bản sao hình ảnh:** lưu tại `Vault/.local-image-compress/backups/originals/`; được tạo trước khi thay thế tệp gốc.

### Tự động hóa
- Bật “Nén nền” sẽ hiện hai thanh trượt:
  - Ngưỡng nén nền: 10–1000 hình ảnh, mặc định 50.
  - Ngưỡng không hoạt động: 1–60 phút, mặc định 2.
- Bật “Giữ bản sao lưu, ngày” sẽ hiện thanh trượt thời gian lưu.
- Bật “Tự động di chuyển tệp đã nén” sẽ hiện ngưỡng số tệp. Khi khởi động, quá trình di chuyển bắt đầu nếu số tệp trong `Compressed` đạt hoặc vượt ngưỡng.

### Tương tác với Paste Image Rename

Plugin này tạm thời tắt plugin bên thứ ba `obsidian-paste-image-rename` trong khi nén hoặc di chuyển. Không thể tắt cơ chế bảo vệ này vì việc ánh xạ kết quả nén với tệp gốc yêu cầu tệp mới không bị plugin khác đổi tên.

<details>
<summary>Vì sao cần biện pháp bảo vệ này</summary>

Lý do cần thiết:

- Paste Image Rename đăng ký trình xử lý `vault.on("create")`, chạy cho mỗi ảnh được thêm vào kho khoảng một giây sau khi tạo. Trình xử lý luôn tác động lên tên bắt đầu bằng `Pasted image ` và lên mọi ảnh khác nếu “Handle all attachments” được bật.
- Bản sao nén ghi vào thư mục đầu ra sẽ kích hoạt trình xử lý. Khi có chế độ xem Markdown đang hoạt động, nó đổi tên kết quả và phá vỡ ánh xạ dùng để di chuyển, hoặc hiện hộp thoại đổi tên cho từng tệp. Khi không có chế độ xem hoạt động, nó hiện `Error: No active file found` cho từng tệp, làm giao diện đầy lỗi trong khi xử lý hàng loạt.
- Obsidian không có API công khai để một plugin tạm dừng plugin khác. Vì vậy, tạm thời tắt duy nhất plugin này là giải pháp đáng tin cậy duy nhất.

Xử lý an toàn:

- Chỉ ID đã biết `obsidian-paste-image-rename` bị ảnh hưởng, và chỉ trong khi nén hoặc di chuyển.
- Plugin được khôi phục sau đó, thử lại nếu cần, trừ khi trạng thái bị thay đổi từ bên ngoài. Cơ chế bảo vệ ghi lại việc chính nó đã tắt plugin và không cố khôi phục sau thay đổi như vậy.
- Việc bật và tắt dùng API nội bộ `app.plugins` của Obsidian vì không có API công khai tương đương. Tính năng được kiểm tra trước và lỗi được xử lý an toàn.

</details>

### Quyền riêng tư và hoạt động bên ngoài

- **Mạng**: plugin không gửi yêu cầu mạng khi chạy. Bộ mã hóa/giải mã PNG/JPEG nằm trong `main.js`; hình ảnh không được tải lên.
- **Đo từ xa và quảng cáo**: không có phân tích, đo từ xa, báo cáo sự cố, theo dõi, quảng cáo động hay tự cập nhật.
- **Tài khoản và thanh toán**: không cần tài khoản, đăng ký, khóa giấy phép hay thanh toán. Plugin không bao giờ truy cập liên kết tài trợ tùy chọn trong manifest.
- **Tệp trong kho**: plugin đọc ảnh được chọn bởi lệnh, tự động hóa hoặc gốc được phép. Kết quả được ghi vào thư mục tương đối đã cấu hình; tệp gốc chỉ được thay thế qua luồng di chuyển thủ công hoặc tự động đã mô tả sau khi sao lưu.
- **Trạng thái cục bộ**: bộ nhớ đệm nằm trong thư mục plugin. Bản sao bộ nhớ đệm và di chuyển nằm dưới `Vault/.local-image-compress/backups/`.
- **Tệp bên ngoài**: dữ liệu do plugin quản lý vẫn nằm trong kho hiện tại. “Mở thư mục” chỉ yêu cầu hệ điều hành hiển thị thư mục sao lưu đã mô tả và không truyền dữ liệu.
- **Plugin khác**: `obsidian-paste-image-rename` có thể bị tắt tạm thời như trên, rồi được khôi phục sau khi kiểm tra bên nào đã thay đổi trạng thái.

### Mẹo
- Phạm vi chất lượng hợp lý: PNG `65-80`, JPEG `75-90`.
- Đặt “Gốc được phép” nếu chỉ muốn nén các thư mục như `files/` hoặc `images/`.
- Dùng nén nền khi kho có nhiều ảnh chưa nén.

### Câu hỏi thường gặp
**Plugin báo không thể khởi tạo mô-đun WebAssembly.**
Tải lại plugin. Nếu lỗi lặp lại, hãy đưa phiên bản Obsidian, nền tảng và lỗi bảng điều khiển vào báo cáo lỗi.

**Tệp đã nén được lưu ở đâu?**
Mặc định trong `Compressed`. Để thay thế tệp gốc, dùng “Di chuyển tệp đã nén”.

**Dung lượng tiết kiệm được tính như thế nào?**
Kết quả chính xác khi bộ nhớ đệm có kích thước gốc và đầu ra. Với PNG/JPEG chưa nén, plugin dùng ước tính thận trọng với tỷ lệ có giới hạn; kích thước tệp nén hiện tại được đọc từ đĩa khi cần.

### Giấy phép
GPL-3.0-or-later. Giấy phép và thông báo của bên thứ ba: [THIRD_PARTY_NOTICES.md](https://github.com/Haperone/local-image-compress/blob/main/THIRD_PARTY_NOTICES.md).
