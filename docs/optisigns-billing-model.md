# Mô hình billing của OptiSigns (tham khảo)

Tài liệu này ghi lại cách OptiSigns thật sự bán hàng và tính tiền — là cơ sở cho
các mặc định trong app demo.

## 1. Đơn vị tính tiền: mỗi màn hình là một licence

Mọi gói trả phí đều tính **per screen / per month**. Số màn hình chính là
`quantity` của subscription item trên Stripe. Thêm màn hình = tăng quantity,
bớt màn hình = giảm quantity.

## 2. Bảng giá (USD)

Đối chiếu trực tiếp trên optisigns.com/pricing ngày 17/09/2026, cả hai chế độ
Monthly và Annual.

| Gói | Monthly | Annual (−10%) | Ghi chú |
|---|---|---|---|
| Free | $0 | — | tối đa 3 màn hình, 25 app cơ bản, 1GB, tối đa 3 user, có logo OptiSigns |
| Standard | $10.00 | $9.00 | playlist, lịch phát, 100+ app, unlimited storage, tối đa 25 user |
| Pro Plus *(Most Popular)* | $15.00 | $13.50 | M365/Google Workspace, dashboard, OptiSync, workflow, SAML SSO, unlimited user |
| Engage | $30.00 | $27.00 | kiosk tương tác, Lift & Learn, Check-In, QR scan, analytics theo sự kiện |
| Enterprise | $45.00 | $40.50 | **tối thiểu 25 màn hình**, "Talk With Sales", CSM riêng, GraphQL API, on-premise |

> **Không có gói "Pro".** Bảng giá hiện tại chỉ có 5 bậc kể trên. Nếu gặp tài
> liệu nào nhắc tới "Pro $12.50" thì đó là thông tin cũ/sai.

Add-on (licence riêng, đi kèm subscription của gói nền):

| Add-on | Đơn vị | Monthly | Annual |
|---|---|---|---|
| Video Wall | mỗi wall | $25.00 | $22.50 |
| Background Music | mỗi screen | $15.00 | $13.50 |
| Wireless Presentation | mỗi screen | $20.00 | $18.00 |
| Ads Portal | — | liên hệ sales | — |

Term annual giảm đúng 10% ở mọi tier (kể cả add-on); giá annual được trình bày
theo "mỗi màn hình mỗi tháng, billed annually" nhưng **thu một lần cho 12
tháng**. Trang pricing còn có bộ chọn tiền tệ (USD/EUR/GBP/AUD/CAD).

### Phạm vi được dựng trong app demo

App demo dựng **Free + Standard + Pro Plus + Engage** cùng cả 3 add-on.
Enterprise bị lược bỏ vì là kênh sales ("Talk With Sales"), không self-serve;
muốn thêm lại chỉ cần một entry trong `backend/src/catalog/catalog.constants.ts`
(`minQuantity: 25` sẽ tự được enforce).

## 3. Trial

14 ngày, không cần thẻ. Hết trial mà chưa có thẻ thì tài khoản bị deactivate và
có thể kích hoạt lại ở gói Free. AeriCast có trial riêng 14 ngày với 2 licence.

## 4. Proration — điểm cốt lõi

### Tăng quy mô: prorate rồi **thu ngay**

Đây là hành vi production, **xác nhận nội bộ** (mentor team OptiSigns): khi khách
mua thêm — thêm màn hình, lên gói, mua add-on — hệ thống tính prorate cho phần
thời gian còn lại của kỳ và **charge ngay tại thời điểm mua**, không chờ hoá đơn
kỳ sau.

Trong Stripe tương ứng với `proration_behavior: 'always_invoice'`. App demo dùng
đúng cấu hình này cho cả ba rule `screensIncrease` / `planUpgrade` /
`addOnIncrease`, kèm `payment_behavior: 'error_if_incomplete'` để thẻ hỏng thì
thay đổi bị huỷ chứ không cho dùng trước trả sau.

### Cảnh báo: bài support công khai mô tả khác, và mô tả sai

Bài [What if I want to increase, decrease number of screens during the
month?](https://support.optisigns.com/hc/en-us/articles/360016219114) viết:

> "Our system will prorate the usage and automatically adjust your **next bill**
> with the correct amount."
>
> If you subscribed to 2 screens on Jan 10th, then on Jan 20th, add 1 more
> screen. On Feb 10th, you will get billed for:
> - $10 x 3 screens for Feb 10th - Mar 10th
> - $6.66 for 1 screen for Jan 20th - Mar 10 (prorated part)
>
> Totaled: $36.66 on Mar 10th.

**Đừng dùng đoạn này làm chuẩn nghiệm thu.** Ba vấn đề:

1. **Thời điểm thu sai so với production** — bài viết nói dồn vào hoá đơn kỳ sau,
   thực tế thu ngay lúc mua.
2. **Con số $6.66 là làm tròn kiểu "tháng 30 ngày"** ($10 × 20/30). Chu kỳ
   10/01 → 10/02 dài **31 ngày**, thêm màn hình ngày 20/01 thì còn **21 ngày**,
   nên Stripe tính $10 × 21/31 = **$6.77**, tổng **$36.77**. Đã dựng lại đúng
   ví dụ này trên Stripe test mode để đối chiếu.
3. **Hai lỗi biên tập**: "On Feb 10th you will get billed" nhưng kết luận
   "Totaled $36.66 on **Mar 10th**"; và dòng prorate ghi khoảng "Jan 20th -
   **Mar 10**" trong khi đoạn 10/02 → 10/03 đã nằm ở dòng trên — viết vậy là
   tính trùng một tháng.

### Stripe tách prorate làm hai dòng, không phải một

Điều tài liệu không nói: Stripe không "cộng thêm một màn hình". Nó huỷ toàn bộ
phần chưa dùng của số lượng cũ rồi tính lại số lượng mới cho cùng khoảng thời
gian. Với ví dụ trên:

```
[prorate] Unused time on 2 × Standard     -$13.55   20/01 → 10/02
[prorate] Remaining time on 3 × Standard   $20.32   20/01 → 10/02
          3 × Standard ($10.00 / month)    $30.00   10/02 → 10/03
```

Hiệu hai dòng prorate = $6.77, đúng bằng một màn hình cho 21 ngày.

### Giảm quy mô: credit, không hoàn tiền mặt

> "the system will automatically calculate and give you credit to the next bill
> for the unused portion of the canceled screens for the month."

Phần chưa dùng thành credit, không chuyển tiền về thẻ. App demo dùng
`create_prorations` + `push_to_account_balance` để credit đó hiện ngay trên
`customer.balance` thay vì nằm ẩn dưới dạng pending invoice item.

## 5. Huỷ và tạm dừng

- Huỷ bằng cách giảm licence về 0 hoặc bấm huỷ ở trang Subscription Plan; tài
  khoản luôn có thể kích hoạt lại.
- Use case theo mùa: đưa màn hình vào thư mục **OnHold** (không chiếm slot) rồi
  giảm licence — tương đương `pause_collection` trên Stripe.
- Tài liệu OptiSigns không nêu chính sách hoàn tiền theo tỉ lệ khi huỷ giữa kỳ;
  mặc định là phần còn lại trở thành credit, không phải tiền mặt.

## 6. Return policy

Return policy công khai áp cho hàng hoá: cửa sổ **30 ngày** kể từ ngày mua, hàng
phải còn nguyên trạng, có thể chọn full refund / store credit / exchange, phí
ship trả hàng do khách chịu (dùng nhãn trả sẵn thì trừ $10). Chính sách này
không phân biệt hardware với subscription và không nói tới prorated refund cho
gói năm — nên trong demo, cửa sổ 30 ngày được dùng làm mặc định cho refund
subscription và có thể chỉnh trong billing policy.

## Nguồn

- https://www.optisigns.com/pricing
- https://support.optisigns.com/hc/en-us/articles/1500000493782-Billing-How-Do-I-Change-my-Subscription-Plan
- https://support.optisigns.com/hc/en-us/articles/360016219114-What-if-I-want-to-increase-decrease-number-of-screens-during-the-month
- https://support.optisigns.com/hc/en-us/articles/17639078588691-How-to-cancel-subscription-or-pause-subscription-for-Seasonal-Use-Case
- https://support.optisigns.com/hc/en-us/articles/14502723487379-How-to-use-AeriCast-Add-on-for-Wireless-Presentation-and-Video-Conferencing
- https://www.optisigns.com/terms/return-policy
