# Quy tắc tính tiền — bản nghiệp vụ

Bản này mô tả **hành vi thực tế** của hệ thống theo cấu hình đang chạy, viết cho
người không đọc code. Mọi con số trong đây đều đo được từ Stripe test mode, không
phải tính tay.

Phụ lục cuối file ánh xạ từng quy tắc sang ô cấu hình tương ứng, và nói rõ chỗ
nào chỉnh trong app, chỗ nào phải vào dashboard Stripe.

---

> ## 📌 Phạm vi SCIO Portal (MVP)
>
> Khi migrate sang **SCIO Portal**, chỉ mang sang **Standard plan (1 màn hình)**
> và **X add-on (2 tier: Standard, Pro)**, chạy cả **tháng và năm**. Cơ chế tính
> tiền **giữ nguyên** hệ thống đã dựng — không có luật mới nào cho portal.
>
> Các mục dưới đây đều ghi rõ phần nào **trong** phạm vi MVP, phần nào **ngoài**.
> Bản chi tiết: **[scio-portal-mvp.md](scio-portal-mvp.md)**.
>
> | Trong MVP | Ngoài MVP |
> |---|---|
> | Standard plan, cố định 1 màn hình | Pro Plus, Engage |
> | X Social Standard + Pro | Background Music, Video Wall, Wireless Presentation |
> | Chu kỳ tháng ⇄ năm | Thêm / bớt màn hình |
> | Nâng / hạ tier X, huỷ, trial | Lên / hạ gói ở mức plan |

---

## 1. Nguyên tắc xuyên suốt

> **Khách mua thêm thì trả tiền ngay. Khách bớt đi thì tiền ở lại trong tài khoản
> dưới dạng credit, không chảy ngược về thẻ.**

Hai hệ quả:

- Không có khoản nào "ghi nợ để sau trả" — trừ một ngoại lệ là bớt màn hình.
- Không có tiền rời khỏi Stripe trong luồng tự phục vụ. Muốn hoàn về thẻ thì phải
  là thao tác tay của CSKH.

### Một thao tác, một hoá đơn

Một lần bấm chỉ sinh **một hoá đơn** và thẻ chỉ bị trừ **một lần**, dù thao tác
đó đụng tới cả gói nền lẫn add-on. Ví dụ đổi sang gói năm khi đang giữ X: phần
plan và phần allowance nằm chung một hoá đơn, không tách làm hai lần thu.

### Mọi khoản trả lại đều là một dòng đọc được

Tiền trả lại cho khách **hiện thành dòng trong danh sách khoản chi**, không nấp ở
ô *Applied balance* cuối hoá đơn. Hai cách trả lại viết song song nhau:

| Dòng trên hoá đơn | Nghĩa |
|---|---|
| `Unused time on OptiSigns Standard after 05 Oct 2026` | phần **thời gian** chưa dùng của gói nền |
| `Unused quota on X Social Standard — 600 of 1,200 Monthly Post Updates` | phần **hạn mức** chưa tiêu của add-on |

Người đọc hoá đơn thấy ngay khoản trừ đến từ đâu.

**Hệ quả:** khi khoản trả lại **lớn hơn** khoản thu, hoá đơn nét âm. Stripe tự
chuyển phần âm đó thành credit của khách và **không thu đồng nào**. Trước đây
khoản trả lại nấp trong số dư nên hoá đơn luôn dương, nhưng khách không biết
tiền ở đâu ra — đổi lại sự rõ ràng thì chấp nhận con số âm trên chứng từ.

---

## 2. Khách mua thêm

> **MVP:** chỉ còn hai đường — **mua X lần đầu** và **nâng X Standard → Pro**.
> Thêm màn hình và lên gói plan không có trong portal. Nguyên tắc *thu ngay, thẻ
> hỏng thì huỷ thao tác, ngày gia hạn không đổi* vẫn áp nguyên.
>
> Lưu ý X khác phần còn lại: **không prorate theo ngày** — mua lúc nào cũng trả
> đủ giá và nhận đủ hạn mức.

Áp cho **thêm màn hình**, **lên gói cao hơn**, **mua add-on**.

- Tính theo **số ngày còn lại của kỳ**, không tính nguyên tháng.
- Xuất hoá đơn riêng và **trừ thẻ ngay** khi bấm mua.
- **Ngày gia hạn không đổi.**
- **Thẻ hỏng thì thao tác bị huỷ** — khách không được dùng thứ chưa trả tiền.
- Khi lên gói, phần gói cũ chưa dùng được hoàn trước rồi mới tính gói mới, nên
  khách chỉ trả đúng phần chênh.

| Tình huống đo thật | Thu ngay |
|---|---|
| Engage, 2 → 3 màn hình, còn 20/30 ngày | **$20.00** |
| Standard → Pro Plus, 4 màn hình, còn 20/30 ngày | **$13.33** (hoàn $26.67 + tính $40.00) |
| Mua 2 licence AeriCast, còn 20/30 ngày | **$26.67** |

---

## 3. Khách bớt đi — **không cho giữa kỳ**

> **MVP:** luật chặn này gần như không chạm tới luồng chính, vì trong portal
> *bớt đi* chỉ có hai dạng và cả hai đều đi đường khác:
> - **Hạ X Pro → Standard** — được prorate theo post, trả về credit (mục 10).
> - **Bỏ X** — đặt lịch cuối kỳ, không hoàn đồng nào (mục 5).
>
> Hạ gói ở mức plan và bớt màn hình đều không tồn tại trong MVP. Cửa chặn giữ lại
> cho giai đoạn sau khi portal mở thêm bậc.

Áp cho **bớt màn hình**, **hạ gói**, **bỏ add-on**.

> Chính sách hiện tại: hệ thống **từ chối** mọi thay đổi khiến công ty phải trả
> lại tiền cho khách giữa kỳ. Khách đã trả tiền cho cả kỳ thì dùng hết kỳ.

Cách hoạt động:

- Trước khi gọi Stripe, hệ thống **tính thử** hoá đơn mà thay đổi đó sẽ tạo ra.
- Nếu số tiền **âm** — tức là phải trả lại khách — thao tác bị **từ chối**, kèm
  thông báo nêu rõ số tiền.
- Vì kiểm tra chạy trên bản tính thử, **không có gì bị thay đổi** khi từ chối:
  gói, số màn hình, add-on, số hoá đơn, credit balance đều nguyên vẹn.
- **Không bao giờ có hoá đơn âm** trong lịch sử.

| Thao tác đo thật (đã dùng 15/30 ngày) | Kết quả |
|---|---|
| Bớt màn hình 4 → 2 | ❌ từ chối — *"would leave 15.00 USD owed back"* |
| Hạ gói Pro Plus → Standard | ❌ từ chối — *"would leave 10.00 USD owed back"* |
| Bỏ 2 add-on về 0 | ❌ từ chối — *"would leave 15.00 USD owed back"* |
| Lên gói Pro Plus → Engage | ✅ thu ngay $30.00 |

### Vậy khách muốn giảm thì làm sao

Hiện tại **không có đường tự phục vụ**. Ba lựa chọn:

1. **Chờ tới ngày gia hạn** rồi tự đổi — lúc đó không còn phần chưa dùng nên
   không phát sinh khoản trả lại.
2. **CSKH can thiệp** — dùng mục *One-off policy override* trên màn hình
   Subscription, đặt riêng cho lần đó `create_prorations` +
   `push_to_account_balance`. Thay đổi được áp và khách nhận credit, chỉ áp dụng
   đúng lần bấm đó, không ảnh hưởng chính sách chung.
3. **Đổi chính sách** cho rule tương ứng sang `end_of_period` — khi đó thay đổi
   được đặt lịch, có hiệu lực đúng ngày gia hạn, không ai phải trả lại gì.

> **Cân nhắc nghiệp vụ:** chặn hoàn toàn nghĩa là khách đang gặp khó khăn tài
> chính không thể tự giảm chi tiêu, phải liên hệ hỗ trợ. Đổi lại, công ty không
> bao giờ phải trả lại tiền giữa kỳ và sổ sách không có hoá đơn âm.

## 4. Đổi chu kỳ thanh toán

> **MVP: trong phạm vi.** Đổi một lần là **cả plan lẫn X cùng nhảy** — không có
> trạng thái plan tháng + add-on năm. Plan settle theo **thời gian**, X settle
> theo **post**.

**Tháng → Năm** (khách muốn rẻ hơn 10%)
- Chu kỳ **tính lại từ hôm nay**; ngày gia hạn mới là hôm nay + 1 năm.
- Thu ngay tiền cả năm, **trừ phần tháng chưa dùng**.
- Đo thật: Engage 1 màn hình, mới dùng 1 ngày → thu **$294.00** ($324 − $30).
- Add-on đo theo hạn mức đi kèm được mua **trọn 12 tháng tính từ hôm nay**, đủ
  giá và đủ allowance — vì chu kỳ vừa khởi động lại nên không còn tháng nào dở.

**Năm → Tháng** (khách muốn giảm cam kết)
- Có hiệu lực **ngay**, không bắt chờ hết năm.
- Phần năm chưa dùng thành **credit**, tháng đầu của gói tháng được tính trong
  cùng lần đó.
- Credit thường đủ nuôi vài tháng tiếp theo.
- Đo thật: Pro Plus 2 màn hình, gói năm $324, đổi sau 2 tháng → credit
  **$240.74**, hoàn về thẻ **$0.00**, hoá đơn tháng kế tiếp **$0.00**.

---

## 5. Huỷ

> **MVP: trong phạm vi**, và đây là ranh giới quan trọng nhất cần nhớ:
> **hạ gói thì được prorate, huỷ thì không.** Huỷ plan hay bỏ X đều **giữ nguyên
> trạng thái đang dùng tới hết kỳ** rồi mới cắt, không hoàn đồng nào.

- Huỷ **vào cuối kỳ đã trả tiền** — khách xài hết những gì đã mua, nên **không có
  gì để hoàn**.
- Huỷ xong tài khoản **rơi về gói Free**, giữ tối đa 3 màn hình, không bị khoá sạch.
- Đổi ý trước ngày hết hạn thì hoàn tác được.
- Có tuỳ chọn huỷ ngay lập tức. Nếu bật thì **phải bật kèm "tính lại phần chưa
  dùng"**, không thì khách vừa mất dịch vụ vừa không được gì — trang Billing
  policy sẽ cảnh báo nếu rơi vào trạng thái này.

---

## 6. Dùng thử

> **MVP: trong phạm vi.** Trial của plan mô tả dưới đây **đã dựng**.
>
> ⚠️ **Trial riêng của X add-on chưa dựng** — theo MODEL V5 là *14 ngày / 200 post
> / mỗi tài khoản một lần / chỉ khi plan nền là gói tháng*. Đây là phần còn thiếu
> duy nhất của phạm vi MVP.

- **14 ngày**, chỉ cho khách **chưa gắn thẻ**. Ai đã gắn thẻ thì tính tiền ngay
  từ đầu.
- Trong trial mọi thay đổi có hiệu lực ngay nhưng **không thu đồng nào**.
- Hết trial mà chưa có thẻ → **subscription bị huỷ**.
- Có thể **kết thúc trial sớm**: hệ thống chốt luôn và xuất hoá đơn kỳ đầu tiên.
- Người vận hành ép bật/tắt trial cho từng lần tạo được, không phụ thuộc quy tắc chung.

---

## 7. Thu tiền thất bại

- **Lúc mua thêm:** chặn luôn, không cho dùng trước trả sau.
- **Lúc gia hạn:** hoá đơn chuyển sang quá hạn, Stripe tự retry theo lịch cấu hình
  trong dashboard, subscription giữ nguyên. App hiện cảnh báo trên màn hình tài khoản.
- **Lúc giảm quy mô:** không bị chặn, vì không cần charge.
- **Tạm dừng theo mùa:** dừng xuất hoá đơn mà không mất cấu hình, mở lại bất cứ lúc nào.

---

## 8. Hoàn tiền về thẻ (thao tác tay của CSKH)

Đây là con đường **duy nhất** tiền rời khỏi Stripe.

- Chỉ hoàn được hoá đơn **đã thanh toán**.
- Phát hành **credit note** — vừa chỉnh hoá đơn cho đúng sổ sách/thuế, vừa chuyển
  tiền về thẻ.
- **Cửa sổ 30 ngày** kể từ ngày lập hoá đơn; quá hạn bị từ chối, muốn vượt phải
  tick ô ghi đè.
- **Trần tự động duyệt $500**; trên mức đó phải ghi đè thủ công.
- Cho phép hoàn một phần.
- Không hoàn quá số thực còn lại — hệ thống trừ cả phần đã hoàn trước đó.

---

## 9. Ràng buộc hệ thống không cho vi phạm

> **MVP:** ràng buộc quan trọng nhất là **phải có subscription trả phí mới mua
> được add-on**. Không có plan thì không mua được X ở bất kỳ tier nào.

- **Add-on phải có gói trả phí đỡ bên dưới** — ít nhất 1 màn hình. Không có
  subscription thì không mua được add-on nào, kể cả X.
- Gói **Free tối đa 3 màn hình**, **không được dùng add-on**.
- Add-on tính theo màn hình (Background Music, AeriCast) **không được nhiều hơn
  số màn hình**.
- Mỗi gói có số màn hình tối thiểu riêng.
- Cho phép **giảm về 0 màn hình** để tạm dừng theo mùa.

---

## 10. X Social — add-on bán theo allowance, không theo thời gian

> **MVP: đây là phần lõi của portal.** Cả hai tier Standard và Pro đều trong
> phạm vi, chạy cả tháng lẫn năm.

Khác mọi add-on còn lại ở hai điểm: giá tính **theo account** (số lượng luôn 1),
và **lịch không đóng vai trò gì**. Cái khách mua là một hạn mức post, nên cái
khách được trả lại là phần hạn mức chưa tiêu — mua ngày 2 hay ngày 29 cũng vậy.

| | Standard | Pro |
|---|---|---|
| Giá tháng | $10.00/account | $30.00/account |
| Giá năm (−10%) | $108.00 | $324.00 |
| Monthly Post Updates | 600 | 2,000 |
| Profile theo dõi | 10 | 25 |

Chu kỳ của add-on **luôn bám theo gói chính**.

### Nguyên tắc định giá

| | Cách tính |
|---|---|
| **Nhận một tier giữa kỳ** | tháng đang dở được bán theo **phần còn lại**: giá và allowance cùng cắt một tỉ lệ, nên giá mỗi post không phụ thuộc ngày mua |
| **Nhận một tier khi đổi term** | mốc chu kỳ khởi động lại nên **không có tháng nào dở**: mua **trọn 12 tháng** (hoặc 1 nếu về gói tháng), **đủ giá, đủ allowance** |
| **Trả lại một tier** | `giá đã trả cho tháng này × (allowance chưa tiêu / allowance)`, cộng thêm các tháng trọn chưa đụng tới nếu đang ở gói năm |
| **Huỷ hẳn** | không hoàn đồng nào, giữ allowance tới hết kỳ |

Phần trả lại định giá theo **term đang có**, phần nhận định giá theo **term mới**.

Vì hệ thống không tự đếm post, số post đã tiêu lấy từ **đồng hồ usage** của tài khoản; request có thể truyền `quotaUsed` để đè lên. Đồng hồ chưa từng ghi nghĩa là **chưa đăng post nào (= 0)**, không phải thiếu dữ liệu.

### Gói năm chứa 12 hạn mức tháng

Gói năm trả tiền trước cho 12 hạn mức, mỗi tháng 600 (hoặc 2.000) post riêng. Stripe chỉ gia hạn **một lần mỗi năm** nên không đánh dấu được 11 mốc tháng bên trong; hệ thống tự mốc theo **tháng lịch** neo vào ngày bắt đầu kỳ.

| | |
|---|---|
| **Sang tháng mới** | đồng hồ về `0/600`, hạn mức mới cấp đủ |
| **Post thừa tháng cũ** | **mất**, không dồn sang tháng sau và không quy ra tiền |
| **Khi settle** | tháng đang dùng tính theo post còn lại; các tháng phía sau chưa đụng tới hoàn trọn tháng |

**Ví dụ:** gói năm X Standard ($9/tháng). Tháng 1, 2, 3 mỗi tháng tiêu 400/600. Tới tháng 3 hạ tier:

| phần | tính | tiền |
|---|---|---|
| tháng 3 đang dùng | $9 × 200/600 | $3.00 |
| tháng 4–12 chưa đụng | $9 × 9 | $81.00 |
| dư 200 post của tháng 1 và tháng 2 | bỏ | $0.00 |
| | | **$84.00** vào credit |

### Số đo thật

**Mua lần đầu khi chỉ còn 10/30 ngày** → thu **$3.33** và cấp **200 post**, tức
33,3% của cả giá lẫn hạn mức. Cắt cùng một tỉ lệ nên giá mỗi post không đổi:
khách mua ngày nào cũng trả đúng chừng đó tiền cho chừng đó post.

**Đổi term thì khác hẳn** — mốc chu kỳ khởi động lại nên không còn tháng nào dở
dang. Đổi sang gói năm hôm nay nghĩa là **12 tháng trọn tính từ hôm nay**: thu
đủ `$9 × 12 = $108.00` và cấp đủ 600 post mỗi tháng, không cắt gì cả.

**Đổi Standard → Pro giữa kỳ, đã tiêu 200/600**

| | |
|---|---|
| Trả lại hạn mức chưa tiêu | `$10 × 400/600` = **−$6.67** |
| Pro, đủ giá đủ hạn mức | **+$30.00** |
| Hoá đơn | **$30.00** (dương) · thu thẻ **$23.33** |

**Đổi term tháng → năm, Standard 1 màn hình + X Standard × 2, đã tiêu 600/1,200,
đang ở giữa kỳ** — đây là hoá đơn thật, nguyên văn:

```
Unused time on OptiSigns Standard after 05 Oct 2026                  −$5.33
X Social Standard × 2 — 12 whole months, 1,200 Monthly Post Updates  $216.00
Unused quota on X Social Standard — 600 of 1,200 Monthly Post Upd…  −$10.00
1 × OptiSigns Standard (at $108.00 / year)                          $108.00
                                                          Total     $308.67
                                                    Amount paid     $308.67
```

Bốn dòng, bốn nguyên tắc nằm cạnh nhau:

| Dòng | Nói lên điều gì |
|---|---|
| −$5.33 | gói nền trả lại phần **thời gian** chưa dùng (16/30 tháng) |
| $216.00 | X mua **trọn 12 tháng** ở giá năm, đủ allowance — không cắt theo ngày |
| −$10.00 | X trả lại phần **hạn mức** chưa tiêu, hiện thành dòng chứ không nấp ở Applied balance |
| $108.00 | gói nền chạy tròn một năm tính từ hôm nay |

Gói nền prorate theo ngày như thường. Chỉ X là không. Và cả hai nằm **chung một
hoá đơn**, thẻ trừ một lần.

### Một cạm bẫy của Stripe

Reset chu kỳ thanh toán sẽ định giá lại **mọi dòng đang gắn** trên subscription,
kể cả dòng bị loại khỏi danh sách cập nhật — loại khỏi `items` chỉ có nghĩa
"đừng sửa dòng này", không có nghĩa "đừng tính tiền dòng này". Lần đầu dựng,
Stripe cộng thêm `Remaining time on X Social Pro $17.75` lên trên $324 đã thu.

Nên khi đổi term, dòng X được **tháo ra trước**, đổi term cho phần còn lại, rồi
**gắn lại** ở giá mới. Cả ba bước đều không dính thanh toán vì tiền đã settle
xong từ trước.

### Huỷ

**Không hoàn đồng nào.** Lên lịch kết thúc tại ngày gia hạn; trong thời gian đó
khách vẫn tiêu hết allowance đã trả tiền. Có thể huỷ lịch trước ngày đó.

### Nhập số post đã tiêu ở đâu

Khối **Usage meter** ở cột trái, ngay trên Time machine. Nó đóng vai đúng như
Time machine nhưng cho mức dùng: production lấy con số này từ dịch vụ đo usage,
demo thì có núm để bạn đặt.

- Hiện `180 / 600` kèm thanh tiến độ, và **giá trị nếu trả lại ngay bây giờ**
  (`420 còn lại, worth $7.00`) — thấy được hệ quả tiền trước khi bấm gì.
- Nút `+10 / +100 / +500` để tiêu dần như traffic thật, ô nhập + `Set` để đặt
  thẳng, `Reset` về 0.
- Mọi phép tính credit của add-on đo theo usage **tự đọc từ đây**. Form
  Subscription chỉ hiển thị lại con số, không cho nhập — giống như bạn không
  chỉnh đồng hồ ngay trong form.
- Gọi API vẫn **ghi đè được** bằng `quotaUsed` trong request, dùng khi cần thử
  một con số mà không muốn đổi đồng hồ.

Đồng hồ **tự về 0** khi có allowance mới: đổi tier (tier mới cấp hạn mức mới) và
khi kỳ gia hạn (hạn mức reset hàng tháng).

API: `PUT /api/accounts/:id/usage` `{family, used}` · `POST /api/accounts/:id/usage/consume` `{family, amount}`

### Chỉnh số allowance ở đâu

Tab **Billing policy** → khối **Metered allowances**. Nhập số mới rồi Save; có
nút *Reset to defaults* để quay về 600/2.000.

Đây là **mẫu số** trong phép tính credit, nên sửa nó là sửa số tiền khách được
trả lại: đổi Standard từ 600 lên 1.000 thì cùng một lần tiêu 200 post, credit
nhảy từ `$10 × 400/600 = $6.67` lên `$10 × 800/1000 = $8.00`. Không ảnh hưởng gì
tới Stripe.

Số đã sửa **không bị mất khi restart**. Lúc khởi động app chỉ ghi các trường cấu
trúc (tên, giá, ràng buộc) từ code; riêng allowance chỉ ghi khi tạo mới, nên thay
đổi lúc chạy được giữ lại. Muốn về mặc định thì phải bấm *Reset to defaults*
(`POST /api/catalog/reseed?force=true`).

Giá thì **không** chỉnh được lúc chạy: Price trên Stripe là bất biến, đổi giá
phải tạo Price mới và di chuyển subscription sang — nằm ở `catalog.constants.ts`
rồi chạy `node scripts/seed.mjs`.

### Chưa dựng

Trial riêng của add-on (14 ngày, 200 post, một lần mỗi account, chỉ khi gói chính
theo tháng).

---

## Phụ lục A — Ánh xạ sang ô cấu hình

Chỉnh ở tab **Billing policy** trong app. Mọi thay đổi lưu ngay và nhãn preset
chuyển thành `custom`.

| Quy tắc | timing | proration | anchor | payment | credit |
|---|---|---|---|---|---|
| Thêm màn hình | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Lên gói | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Mua add-on | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Bớt màn hình | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Hạ gói | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Bỏ add-on | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Đổi tier add-on đo theo mức dùng | immediate | `none` | unchanged | — | `customer_balance` + **`creditBasis: quota`** |
| Tháng → Năm | immediate | `always_invoice` | **now** | `error_if_incomplete` | — |
| Năm → Tháng | immediate | `always_invoice` | **now** | `error_if_incomplete` | `push_to_account_balance` |

`creditBasis` quyết định **đo bằng gì**: `time` là mặc định, Stripe tính theo số
ngày; `quota` thì app tự tính theo allowance chưa dùng và Stripe phải để
`proration_behavior: none` — nếu không Stripe sẽ tính tiền lần thứ hai cho cùng
số ngày đó. Trang Billing policy cảnh báo nếu đặt sai.

Ngoài các luật chung, còn một tầng **override theo từng add-on** (`addOnRules`)
cho những add-on không đi theo luật chung — hiện dùng cho `x_social` ở hành vi
huỷ.

**Bốn cách xử lý khi thay đổi sinh ra khoản phải trả lại khách:**

| Giá trị | Hành vi | Có hoá đơn âm không |
|---|---|---|
| `block` | **đang dùng** — từ chối thao tác, không thay đổi gì | không |
| `push_to_account_balance` | cho đổi, credit hiện ngay trên account balance | tuỳ proration |
| `customer_balance` | cho đổi, credit nằm ẩn dưới dạng điều chỉnh treo | tuỳ proration |
| `refund_to_payment_method` | cho đổi, hoàn tiền thật về thẻ | có thể |

Hoá đơn âm chỉ sinh ra khi `proration_behavior = always_invoice` **và** số tiền
ra âm. Với `block` thì trường hợp đó bị chặn trước, nên không bao giờ xảy ra.
Với `create_prorations` thì Stripe không chốt sổ nên cũng không có hoá đơn nào.

| Nhóm khác | Giá trị hiện tại |
|---|---|
| Huỷ | cuối kỳ · không prorate · về gói Free (không có gì để trả lại) |
| Trial | 14 ngày · chỉ khi chưa có thẻ · hết trial không thẻ thì huỷ |
| Hoá đơn | thu tự động bằng thẻ · engine prorate theo giây · không tính thuế tự động |
| Hoàn tiền | credit note · cửa sổ 30 ngày · trần tự duyệt $500 · cho hoàn một phần |
| Ràng buộc | ép số lượng tối thiểu · **add-on cần gói trả phí** · add-on ≤ màn hình · Free ≤ 3 màn hình · cho về 0 |
| Allowance | X Standard 600 · X Pro 2.000 Monthly Post Updates — sửa được lúc chạy |
| Thu thất bại | để Stripe tự retry · tạm dừng kiểu `void` |

---

## Phụ lục B — Chỉnh ở đâu

### Chỉ chỉnh được trong app này

Những thứ dưới đây là **tham số của từng lời gọi API**, Stripe không có màn hình
nào để set mặc định:

- Prorate hay không, và prorate xong thu ngay hay để dành (`proration_behavior`)
- Áp ngay hay chờ cuối kỳ
- Có reset chu kỳ thanh toán không (`billing_cycle_anchor`)
- Thẻ hỏng thì chặn hay cho qua (`payment_behavior`)
- Credit đi đâu: balance / hoàn thẻ / thu hồi
- Toàn bộ quy tắc trial, cửa sổ hoàn tiền, trần tự duyệt, và mọi ràng buộc gói

### Phải vào dashboard Stripe

| Việc | Vị trí trong dashboard |
|---|---|
| Lịch retry khi thu tiền hỏng, và làm gì sau lần retry cuối | Settings → Billing → Subscriptions and emails |
| Email gửi khách: biên lai, báo thu hỏng, nhắc gia hạn | Settings → Billing → Subscriptions and emails |
| Giao diện hoá đơn: logo, màu, số hiệu, memo, footer | Settings → Billing → Invoices |
| Đăng ký thuế để tính thuế tự động | Settings → Tax |
| Loại phương thức thanh toán chấp nhận | Settings → Payment methods |
| Card updater, thu hồi doanh thu | Settings → Billing → Revenue recovery |

### Cả hai nơi, app ghi đè

| Việc | Ghi chú |
|---|---|
| **Customer Portal** | Dashboard có cấu hình mặc định, nhưng app tạo cấu hình riêng từ billing policy và dùng cấu hình đó. Bấm *Sync portal config* trong app để đẩy sang. |
| **Sản phẩm và bảng giá** | Sửa được trong dashboard, nhưng app là nguồn chân lý — chạy sync sẽ ghi đè tên/mô tả và tạo Price mới nếu giá lệch. Đừng sửa giá trực tiếp trên dashboard. |

### Nằm trong code, không có UI

| Việc | File |
|---|---|
| Bảng giá gốc: gói, giá, add-on, ràng buộc số lượng | `backend/src/catalog/catalog.constants.ts` |
| Giá trị mặc định và 5 preset | `backend/src/policy/policy.presets.ts` |
| Danh sách lựa chọn hiện trên dropdown | `backend/src/policy/policy.fields.ts` |
| Quy tắc phát hiện cấu hình vô hiệu | `backend/src/policy/policy.service.ts` |

Cấu hình đang chạy lưu trong MongoDB, collection `billing_policies`, một document
duy nhất. Sửa trên UI là ghi thẳng vào đó, không cần deploy lại.
