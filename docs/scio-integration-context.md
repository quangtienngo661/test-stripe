# Context bàn giao — mang cơ chế billing sang SCIO Portal

Viết cho người sẽ tích hợp cơ chế này vào SCIO Portal. Tóm tắt project đang có,
cấu hình đã chốt, và phần nào port thẳng được / phần nào phải dựng lại.

---

## 1. Vị trí project

| | |
|---|---|
| Thư mục trên máy | `/Users/ryanngo/Desktop/test-stripe` |
| Repo | https://github.com/quangtienngo661/test-stripe (branch `main`) |
| Backend | NestJS, port **3123** |
| Frontend | React + Vite, port **5555** |
| MongoDB | port **27099** |
| Khoá Stripe | `backend/.env` (**không** nằm trong repo; mẫu ở `backend/.env.example`) |

Chạy: `mongod --port 27099 --dbpath ./.mongo-data`, rồi `npm run dev` ở
`backend/` và `npm run dev` ở `frontend/`. Chi tiết trong
[README](../README.md) mục 1.

---

## 2. Project này là gì, và không là gì

**Là:** một bản demo chạy được, mọi luật tính tiền là **cấu hình** chứ không phải
code — sửa policy là đổi hành vi thật của Stripe, không phải đổi số học nội bộ.
Toàn bộ con số trong docs đều đo từ Stripe test mode.

**Không là:** hệ thống production. Không có auth, không có metering thật, không
có webhook secret. Xem mục 7.

**Ý tưởng trung tâm đáng mang sang nhất:** một document policy duy nhất trong
Mongo, mỗi nút trong đó ánh xạ thẳng sang một tham số Stripe. Bảng ánh xạ đầy đủ:
[stripe-mapping.md](stripe-mapping.md).

---

## 3. Stack

| | |
|---|---|
| NestJS | `^12.0.3` |
| Stripe SDK | `^22.6.2` → API version **`2026-08-26.dahlia`** |
| Mongoose | `^9.10.1` |
| TypeScript | `^6.0.3` (bản 7 chưa có compiler API mà nest CLI cần) |
| React / Vite | `^19.3.0` / `^8.3.0` |

API version quan trọng: ở `dahlia`, `current_period_*` nằm trên **SubscriptionItem**
chứ không phải Subscription, và cờ proration nằm ở
`line.parent.subscription_item_details.proration`.

---

## 4. Cấu hình đã chốt cho SCIO

Chọn preset **`scio_portal_mvp`** (tab Billing policy, hoặc
`POST /api/policy/presets/scio_portal_mvp`). Định nghĩa ở
[policy.presets.ts](../backend/src/policy/policy.presets.ts).

### Danh mục trong phạm vi

| Mã | Tên | Tháng | Năm | Hạn mức |
|---|---|---|---|---|
| `standard` | Standard plan | $10.00 | $9.00/th | **1 màn hình** |
| `x_social_standard` | X Social Standard | $10.00 | $9.00/th | 600 post/tháng |
| `x_social_pro` | X Social Pro | $30.00 | $27.00/th | 2.000 post/tháng |

### Luật

| Thao tác | Timing | Cách tính tiền | Tiền đi đâu |
|---|---|---|---|
| Mua X lần đầu | ngay | **đủ giá, đủ hạn mức** — không prorate theo ngày | trừ thẻ |
| Nâng tier X | ngay | trả lại post chưa tiêu, tính đủ giá tier mới | trừ thẻ phần chênh |
| **Hạ tier X** | ngay | `giá × post chưa tiêu / hạn mức` (+ tháng trọn chưa đụng) | **Stripe credit** |
| **Bỏ X** | cuối kỳ | không tính gì | **không hoàn** |
| Huỷ plan | cuối kỳ | không prorate | **không hoàn** |
| Đổi term | ngay | plan theo **thời gian**, X theo **post** | credit hoặc trừ thẻ |

Ranh giới cốt lõi: **hạ gói thì prorate, huỷ thì không.**

### Ba ràng buộc cứng

1. Phải có subscription trả phí mới mua được add-on (`addOnsRequirePaidPlan`)
2. Chu kỳ do plan quyết định — add-on bắt buộc chạy theo, không có trạng thái
   plan tháng + add-on năm
3. Mỗi lúc chỉ giữ một tier X

### Ngoài phạm vi

Pro Plus, Engage, thêm/bớt màn hình, Background Music, Video Wall, Wireless
Presentation, `planUpgrade`/`planDowngrade`. Vẫn còn trong hệ thống, portal MVP
không chạm tới.

Chi tiết đầy đủ: [scio-portal-mvp.md](scio-portal-mvp.md).

---

## 5. Cơ chế cốt lõi cần hiểu trước khi port

### Phân giải rule — 3 tầng

[`policy.service.ts:191`](../backend/src/policy/policy.service.ts:191)

```ts
return { ...rule, ...itemRule, ...(override ?? {}) };
//        toàn cục   theo họ add-on   một lần duy nhất
```

Tầng giữa (`addOnRules`) là thứ cho phép X Social hành xử khác các add-on khác
**mà không phải rẽ nhánh trong engine**.

### Nhánh usage vs time

[`subscriptions.service.ts:632`](../backend/src/subscriptions/subscriptions.service.ts:632)
rẽ theo cờ `usagePriced` của mặt hàng. Nhánh usage tự tính tiền
([`:1022`](../backend/src/subscriptions/subscriptions.service.ts:1022)), lịch
không tham gia vào công thức.

### Thứ tự tiền: tiền trước, subscription sau

[`:1146`](../backend/src/subscriptions/subscriptions.service.ts:1146)

1. `customers.createBalanceTransaction(-credit)` — credit vào trước
2. `invoiceItems.create(charge)`
3. `invoices.create({subscription, auto_advance: false})` — hút credit ở bước 1
4. `finalizeInvoice` → `pay` nếu còn `amount_due`

Hỏng ở bước nào thì `catch` cuốn ngược lại đúng bước đó. **Chỉ khi tiền xong
xuôi subscription mới bị đổi.** Đây là lý do không bao giờ có hoá đơn âm: credit
bị trừ vào hoá đơn dương thay vì tạo hoá đơn âm.

### Gói năm = 12 hạn mức tháng

Stripe chỉ gia hạn một lần mỗi năm nên không đánh dấu được 11 mốc tháng bên trong.
Hệ thống tự mốc theo tháng lịch
([`allowance-cycle.ts`](../backend/src/stripe/allowance-cycle.ts)), và đồng hồ
post mang dấu tháng nó thuộc về — đọc sang tháng mới thì trả 0. **Suy ra lúc
đọc, không có job hẹn giờ.**

---

## 6. File phải đọc, theo thứ tự

1. [`policy.types.ts`](../backend/src/policy/policy.types.ts) — hình dạng cấu hình
2. [`policy.presets.ts`](../backend/src/policy/policy.presets.ts) — giá trị chốt
3. [`subscription.util.ts:64`](../backend/src/subscriptions/subscription.util.ts:64) `classifyChange` — nhận diện tình huống → chọn rule
4. [`subscriptions.service.ts:591`](../backend/src/subscriptions/subscriptions.service.ts:591) `change()` — cửa vào
5. [`:1022`](../backend/src/subscriptions/subscriptions.service.ts:1022) `quoteUsageSettlement` — công thức tiền của X
6. [`:1111`](../backend/src/subscriptions/subscriptions.service.ts:1111) `applyWithUsageSettlement` — cơ chế thanh toán

---

## 7. Phải tự dựng lại ở SCIO — **không port thẳng được**

| Hạng mục | Tình trạng ở demo | Cần làm ở SCIO |
|---|---|---|
| **Đếm post thật** | đồng hồ chỉnh tay (`PUT /api/accounts/:id/usage`) | nối vào hệ thống đếm post thật; engine đọc qua `accounts.readUsage()` nên chỉ cần thay nguồn |
| **Trial của X** | **chưa dựng** | 14 ngày / 200 post / mỗi tài khoản một lần / chỉ khi plan nền là gói tháng |
| **Webhook** | không có secret → dunning tự động không chạy | cấu hình `STRIPE_WEBHOOK_SECRET` |
| **Auth** | không có, mọi endpoint mở | bắt buộc |
| **Test clock** | dùng để tua thời gian | production không có; bỏ đường `nowFor()` hoặc để nó trả về giờ thật |

---

## 8. Đã kiểm chứng tới đâu

`node scripts/verify.mjs` — **151 assertion, chạy trên Stripe test mode thật**,
không phải mock. Bao gồm luồng X Social, lật hạn mức theo tháng, chặn hoá đơn âm,
ràng buộc add-on cần plan.

> Suite **đổi preset toàn cục** trong lúc chạy và reset về `optisigns_default` ở
> cuối. Đừng chạy khi đang có người test trên cùng backend.

---

## 9. Bẫy đã gặp — đừng lặp lại

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| `billing_cycle_anchor: 'now'` **re-price mọi dòng đang gắn** | dòng X đã settle tay bị tính thêm theo ngày | gỡ dòng usage ra → đổi term → gắn lại, cả ba bước `proration_behavior: 'none'` |
| Đọc thời gian bằng đồng hồ máy | account có test clock bị tính sai prorate | mọi lần đọc giờ đi qua `stripe.nowFor(testClockId)` |
| Nuốt lỗi khi đọc subscription | tạo trùng subscription thứ hai | chỉ `resource_missing`/404 mới coi là "không có"; lỗi khác phải ném |
| `create_prorations` thì balance không đổi | tưởng credit không được cấp | đo bằng chênh lệch dòng proration giữa hai lần preview, với `proration_date` ghim cố định |
| Nhầm gross/net khi hoàn tiền | từng hoàn dư $30 và ghi nợ hai lần | chọn gross hay net theo `prorationBehavior` |
| Test clock chỉ nhảy được 2 interval ngắn nhất mỗi lần | nhảy 1 năm thất bại | chia chặng (`advanceInSteps`) |

---

## 10. Tài liệu liên quan

- [business-rules.md](business-rules.md) — luật đầy đủ, ngôn ngữ nghiệp vụ
- [scio-portal-mvp.md](scio-portal-mvp.md) — phạm vi MVP chi tiết
- [stripe-mapping.md](stripe-mapping.md) — từng nút → tham số Stripe
- [optisigns-billing-model.md](optisigns-billing-model.md) — OptiSigns tính tiền thế nào
