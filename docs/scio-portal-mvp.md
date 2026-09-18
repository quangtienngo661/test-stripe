# SCIO Portal — phạm vi MVP

Bản chi tiết cho đợt migrate sang SCIO Portal. Quy tắc đầy đủ của hệ thống nằm ở
[business-rules.md](business-rules.md); file này chỉ nói **phần nào được mang sang**
và phần đó chạy ra sao.

> **Chốt phạm vi:** portal chỉ bán **Standard plan (1 màn hình)** và **X add-on
> (2 tier: Standard, Pro)**, chạy cả **tháng và năm**. Cơ chế tính tiền **giữ
> nguyên** hệ thống billing/payment đã dựng và đã đo trên Stripe test mode —
> không có luật mới nào phát sinh cho portal.

---

## 1. Danh mục bán

| Mặt hàng | Tháng | Năm (−10%) | Hạn mức |
|---|---|---|---|
| **Standard plan** | $10.00 | $9.00/tháng → $108/năm | 1 màn hình |
| **X Social Standard** | $10.00 | $9.00/tháng → $108/năm | 600 post/tháng |
| **X Social Pro** | $30.00 | $27.00/tháng → $324/năm | 2.000 post/tháng |

Mỗi gói Standard là **1 màn hình**. Portal MVP không bán thêm màn hình, nên hai
luật `thêm màn hình` / `bớt màn hình` không có đường chạm tới.

---

## 2. Ba ràng buộc cứng

1. **Phải có plan mới mua được add-on.** Không có subscription trả phí thì không
   mua được X, ở bất kỳ tier nào. Hệ thống chặn ngay khi nhận request.
2. **Chu kỳ do plan quyết định.** Plan chuyển sang năm thì X **bắt buộc** chuyển
   theo. Không tồn tại trạng thái plan tháng + add-on năm — cấu trúc dữ liệu chỉ
   có **một** trường chu kỳ cho cả subscription.
3. **Mỗi lúc chỉ giữ một tier X.** Không thể vừa Standard vừa Pro.

---

## 3. Mua và nâng — thu ngay

| Thao tác | Cách tính | Thu |
|---|---|---|
| Mua X lần đầu | **đủ giá, đủ hạn mức**, bất kể còn mấy ngày trong kỳ | giá gói |
| Nâng X Standard → Pro | trả lại phần post chưa tiêu của Standard, rồi tính đủ giá Pro | phần chênh |

Tiền trừ thẻ **ngay lúc bấm**, không dồn vào hoá đơn kỳ sau. **Thẻ hỏng thì thao
tác bị huỷ** — khách không dùng được thứ chưa trả tiền. **Ngày gia hạn không đổi.**

X **không bao giờ** tính theo ngày. Mua ngày cuối tháng vẫn trả đủ giá và vẫn
nhận đủ 600 (hoặc 2.000) post.

---

## 4. Hạ gói — prorate rồi trả về credit

Chỉ **hạ gói** mới được prorate. Trong MVP điều đó nghĩa là **X Pro → X Standard**
(plan chỉ có một bậc nên không có đường hạ).

```
credit = giá đã mua × (post chưa tiêu / hạn mức)
       + giá đã mua × số tháng trọn chưa đụng tới   (chỉ gói năm)
```

Tiền trả lại vào **credit Stripe của khách**, **không hoàn về thẻ**. Phần credit
dư so với gói mới nằm lại chờ trừ dần vào các hoá đơn sau.

**Đo thật** — X Pro gói tháng, đã tiêu 1.500/2.000 post, hạ về Standard:

| | |
|---|---|
| credit trả lại | $30.00 × 500/2.000 = **$7.50** |
| tính gói Standard | **$10.00** đủ giá |
| thẻ thực trừ | **$2.50** |

Đổi tier xong, **hạn mức cũ về 0 và cấp hạn mức mới** của tier mới.

---

## 5. Huỷ — không prorate

| Thao tác | Kết quả |
|---|---|
| **Bỏ X add-on** | giữ nguyên hạn mức **tới hết kỳ**, hết kỳ mới cắt. **Không hoàn đồng nào.** |
| **Huỷ plan** | có hiệu lực **cuối kỳ đã trả tiền**. Khách xài hết thứ đã mua nên không có gì để hoàn. |

Khác biệt cốt lõi với mục 4: **hạ gói** thì được prorate, **huỷ** thì không.

---

## 6. Đổi chu kỳ

Đổi một lần là **cả plan lẫn X cùng nhảy** sang chu kỳ mới.

| | Cách tính |
|---|---|
| **Plan** | theo **thời gian** — phần chưa dùng quy ra tiền theo ngày |
| **X add-on** | theo **post** — không dính dáng gì tới lịch |

**Tháng → Năm:** thu tiền cả năm ngay, trừ phần chưa dùng.
**Năm → Tháng:** có hiệu lực ngay, phần năm chưa dùng thành credit.

---

## 7. Gói năm chứa 12 hạn mức tháng

Gói năm trả trước cho **12 hạn mức**, mỗi tháng 600 (hoặc 2.000) post riêng.
Stripe chỉ gia hạn **một lần mỗi năm** nên không đánh dấu được 11 mốc tháng bên
trong — hệ thống tự mốc theo **tháng lịch** neo vào ngày bắt đầu kỳ.

| | |
|---|---|
| Sang tháng mới | đồng hồ về `0/600`, cấp hạn mức mới |
| Post thừa tháng cũ | **mất** — không dồn sang tháng sau, không quy ra tiền |
| Khi settle | tháng đang dùng tính theo post còn lại; các tháng phía sau hoàn trọn |

**Đo thật** — X Standard gói năm ($9/tháng), tháng 1–2–3 mỗi tháng tiêu 400/600,
tới tháng 3 mới hạ tier:

| Phần | Tính | Tiền |
|---|---|---|
| tháng 3 đang dùng | $9 × 200/600 | **$3.00** |
| tháng 4–12 chưa đụng | $9 × 9 | **$81.00** |
| dư 200 post của tháng 1 và 2 | bỏ | **$0.00** |
| | | **$84.00** vào credit |

Nếu dồn dư của tháng đã qua thì con số sẽ là $90.00 — cố ý không làm vậy.

---

## 8. Dùng thử — **trong phạm vi**

**Trial của plan — đã dựng.** 14 ngày, chỉ cho khách **chưa gắn thẻ**; ai đã gắn
thẻ thì tính tiền ngay. Trong trial mọi thay đổi có hiệu lực nhưng không thu
đồng nào. Hết trial mà chưa có thẻ thì subscription bị huỷ. Kết thúc trial sớm
được.

**Trial của X add-on — CHƯA DỰNG.** Theo MODEL V5: **14 ngày / 200 post / mỗi tài
khoản một lần / chỉ khi plan nền đang là gói tháng**. Đây là phần còn thiếu duy
nhất của phạm vi MVP, cần dựng trước khi migrate.

---

## 9. Không bao giờ có hoá đơn âm

Trước khi gọi Stripe, hệ thống **tính thử** hoá đơn. Nếu ra số âm — tức công ty
phải trả lại tiền — thao tác bị **từ chối**, không có gì thay đổi.

Trong MVP, cửa chặn này gần như không chạm tới các luồng chính:

- **X Pro → Standard** đi theo luật riêng của add-on đo theo hạn mức, trả về
  credit chứ không tạo hoá đơn âm.
- **Bỏ X** đặt lịch cuối kỳ, không phát sinh tiền.
- **Hạ plan** không có đích để hạ.

Nó đứng đó cho các trường hợp ngoài rìa và cho giai đoạn sau khi portal mở thêm bậc.

---

## 10. Những gì **bỏ** khỏi MVP

| | Lý do |
|---|---|
| Gói **Pro Plus**, **Engage** | portal chỉ bán Standard |
| Luật `lên gói` / `hạ gói` ở mức plan | một bậc thì không có đích để nhảy |
| **Thêm / bớt màn hình** | mỗi Standard cố định 1 màn hình |
| Add-on theo đơn vị: **Background Music**, **Video Wall**, **Wireless Presentation** | ngoài phạm vi |
| Gói **Free** | vẫn là trạng thái "chưa mua"; chọn Free nghĩa là **huỷ subscription** |

Những phần này vẫn còn nguyên trong hệ thống và trong
[business-rules.md](business-rules.md), chỉ là portal MVP không chạm tới.
