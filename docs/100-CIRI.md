# 100 ciri untuk Kosongsatu: setanding pesaing, dan cara untuk jadi unik

Disediakan pada 17 Oktober 2026, berdasarkan kod `main` v0.8.0 (commit `8b3f6a9`), GAP-CIRI.md dan AUDIT.md.

Pesaing yang dijadikan rujukan: Zoho Invoice, Invoice Ninja, Stripe Invoicing, Bukku, SQL Account, AutoCount, Xero dan QuickBooks. Ciri pesaing diambil daripada pengetahuan umum tentang produk mereka dan tidak disemak satu per satu hari ini.

**Status (disahkan dalam kod):**

- ✅ **Ada:** sudah dibina dan berfungsi
- 🟡 **Separa:** ada sebahagian, atau perlukan akaun pengguna untuk hidup
- ❌ **Tiada:** belum dibina

**Keutamaan:** 🔴 wajib untuk setanding · 🟠 penting · 🟢 bagus ada / pembeza

## Ringkasan

| Status | Bilangan |
|---|---|
| ✅ Ada | 29 |
| 🟡 Separa | 9 |
| ❌ Tiada | 62 |

Bahagian A hingga I (no. 1–85) ialah ciri yang pesaing sudah ada. Bahagian J (no. 86–100) ialah idea untuk menjadikan Kosongsatu berbeza daripada mereka.

---

## A. Dokumen dan bil

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 1 | Draf invois dan quotation dengan pratonton langsung | ✅ | 🔴 | |
| 2 | Nombor dokumen dijana semasa issue, snapshot klien dikunci | ✅ | 🔴 | |
| 3 | PDF berjenama (invois, quotation, resit, nota, refund) | ✅ | 🔴 | |
| 4 | Duplicate / clone dokumen | ✅ | 🟢 | PR #2 |
| 5 | Padam draf dan arkib rekod | ✅ | 🔴 | PR #2 |
| 6 | Diskaun per baris (selain diskaun keseluruhan) | ❌ | 🟠 | Kini diskaun keseluruhan sahaja |
| 7 | Unit pada servis | 🟡 | 🟠 | Medan `unit` ada; tiada SKU / kod item |
| 8 | Templat PDF boleh ubah (warna, susun atur, medan, logo) | ❌ | 🟠 | Satu templat tetap |
| 9 | Recurring fleksibel: mingguan, suku tahun, tahunan | ❌ | 🟠 | Bulanan sahaja |
| 10 | Recurring banyak baris, auto-issue dan auto-hantar | ❌ | 🟠 | Satu servis, draf dijana manual |
| 11 | Proforma invoice | ❌ | 🟠 | |
| 12 | Delivery order dan sales order | ❌ | 🟢 | Bukku, SQL, AutoCount ada |
| 13 | Pelbagai mata wang dengan kadar tukaran | ❌ | 🟢 | MYR sahaja |
| 14 | Dokumen dwibahasa (BM / EN / 中文) | ❌ | 🟢 | Inggeris sahaja |
| 15 | Medan tersuai (custom fields) dan lampiran fail pada invois | ❌ | 🟢 | |

## B. Cukai dan pematuhan Malaysia

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 16 | SST per baris (0/5/6/8/10%) | ✅ | 🔴 | PR #4 |
| 17 | TIN, BRN dan nombor SST penjual dan pembeli pada PDF | ✅ | 🔴 | PR #4 |
| 18 | Laporan ringkasan SST untuk SST-02 | 🟡 | 🟠 | CSV sahaja, tiada borang SST-02 |
| 19 | SST pada nota kredit / debit | ❌ | 🟠 | Diakui dalam README |
| 20 | Pengecualian SST (exemption) per pelanggan | ❌ | 🟢 | |
| 21 | LHDN MyInvois: hantar, validasi, UUID dan QR pada PDF | ❌ | 🟠 | Belum wajib di bawah RM3 juta jualan |
| 22 | MyInvois: batal dalam 72 jam, nota kredit/debit e-Invoice | ❌ | 🟠 | Bergantung pada no. 21 |
| 23 | Consolidated e-Invoice dan self-billed | ❌ | 🟢 | |
| 24 | Kod klasifikasi dan alamat penuh pembeli (kod negeri) | ❌ | 🟠 | Persediaan MyInvois |

## C. Pembayaran dan kutipan

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 25 | Resit diagih ke banyak invois, bayaran separa | ✅ | 🔴 | |
| 26 | Nota kredit, nota debit dan refund bernombor | ✅ | 🔴 | |
| 27 | Payment gateway (FPX, kad, DuitNow) | 🟡 | 🔴 | Billplz siap (PR #5); perlukan kunci Billplz |
| 28 | Status invois bertukar Paid automatik selepas bayaran | 🟡 | 🔴 | Siap untuk Billplz; hidup bila kunci dimasukkan |
| 29 | Gateway alternatif (ToyyibPay, Stripe, iPay88) | ❌ | 🟢 | |
| 30 | DuitNow QR statik pada PDF invois | ❌ | 🟠 | Bayar tanpa gateway, tiada yuran |
| 31 | Klien muat naik slip bayaran | ❌ | 🟠 | Kini rujukan teks sahaja |
| 32 | Peringatan automatik sebelum dan selepas tarikh akhir | 🟡 | 🔴 | Siap (PR #3); perlukan akaun SMTP |
| 33 | Caj lewat bayar automatik | ❌ | 🟢 | |
| 34 | Deposit / bayaran awal pada quotation | ❌ | 🟢 | |
| 35 | Bayaran ansuran (payment plan) | ❌ | 🟢 | |
| 36 | Import CSV bank dengan padanan dan dedupe | ✅ | 🟠 | |
| 37 | Import format asli Maybank / CIMB / Public Bank, atau bank feed | ❌ | 🟠 | CSV format normal sahaja |

## D. Penghantaran dan komunikasi

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 38 | Hantar emel invois / quotation dengan PDF | 🟡 | 🔴 | Siap (PR #3); perlukan akaun SMTP |
| 39 | Log emel pada setiap dokumen | ✅ | 🟠 | PR #3 |
| 40 | Templat emel boleh ubah | ❌ | 🟠 | |
| 41 | Penjejakan emel dibuka / bounce | ❌ | 🟢 | Hanya "viewed" bila pautan dibuka |
| 42 | Pembuka WhatsApp composer | ✅ | 🟢 | |
| 43 | WhatsApp Business API (hantar automatik) | ❌ | 🟠 | Sangat relevan di Malaysia |
| 44 | Pautan klien selamat (token, tamat tempoh, revoke) | ✅ | 🔴 | |
| 45 | Notifikasi kepada pemilik (bayaran masuk, quotation diterima) | ❌ | 🟠 | Emel / WhatsApp / push |

## E. Klien dan portal

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 46 | Katalog klien dengan terma bayaran | ✅ | 🔴 | |
| 47 | Klien terima quotation dalam talian dengan nama penandatangan | ✅ | 🟠 | |
| 48 | Statement of account dan aging per klien | ✅ | 🟠 | PR #3 |
| 49 | Akaun portal klien (semua dokumen di satu tempat) | ❌ | 🟠 | Kini pautan per dokumen |
| 50 | Berbilang kenalan per klien (bil, teknikal, CC) | ❌ | 🟠 | |
| 51 | Had kredit dan tahan kerja bila tertunggak | ❌ | 🟢 | |
| 52 | Tandatangan elektronik pada quotation (lukis / taip) | 🟡 | 🟢 | Nama sahaja, tiada tandatangan |

## F. Perakaunan dan laporan

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 53 | Dashboard invois, kutipan, baki dan overdue | ✅ | 🔴 | |
| 54 | Laporan aging seluruh perniagaan | ✅ | 🟠 | Melalui statement (PR #3) |
| 55 | Rekod perbelanjaan dan resit vendor | ❌ | 🟠 | |
| 56 | Imbas resit dengan OCR | ❌ | 🟢 | |
| 57 | Laporan jualan ikut klien / servis / bulan | 🟡 | 🟠 | Dashboard asas sahaja |
| 58 | Untung rugi ringkas | ❌ | 🟠 | Perlukan no. 55 |
| 59 | Eksport ke Bukku / SQL / Xero / AutoCount | ❌ | 🟠 | Kini CSV dan JSON umum |
| 60 | Eksport CSV dan JSON perniagaan | ✅ | 🟠 | |
| 61 | Akses baca sahaja untuk akauntan | ❌ | 🟠 | |
| 62 | Laporan unjuran aliran tunai | ❌ | 🟢 | |
| 63 | Ringkasan cukai pendapatan tahunan (Borang B / P) | ❌ | 🟢 | |
| 64 | Purchase order kepada pembekal / bil pembekal | ❌ | 🟢 | |

## G. Jualan dan operasi

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 65 | Opportunity → quotation → acceptance → PO → invois | ✅ | 🟠 | |
| 66 | Penerimaan luar talian dengan bukti | ✅ | 🟢 | |
| 67 | PO separa, pindaan dan muat naik fail PO | ❌ | 🟢 | Satu PO bernilai penuh sahaja |
| 68 | Jejak masa / timesheet → invois | ❌ | 🟢 | |
| 69 | Projek dan milestone billing | ❌ | 🟢 | |
| 70 | Kontrak / retainer dengan tarikh tamat dan pembaharuan | ❌ | 🟢 | |
| 71 | Inventori ringkas | ❌ | 🟢 | Tidak perlu untuk syarikat servis |

## H. Pengguna dan keselamatan

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 72 | Login, sesi server, CSRF, throttle login | ✅ | 🔴 | |
| 73 | MFA (TOTP) dan kod pemulihan | ✅ | 🟠 | |
| 74 | Kod QR untuk setup MFA | ❌ | 🟢 | Kini kunci teks sahaja |
| 75 | Audit sebelum/selepas yang tidak boleh dipadam | ✅ | 🟠 | |
| 76 | Berbilang pengguna dan peranan (admin, staf, akauntan) | ❌ | 🟠 | Seorang pemilik sahaja |
| 77 | Reset kata laluan melalui emel | ❌ | 🟠 | Pemulihan konsol sahaja |
| 78 | Backup bersulit harian dan restore | ✅ | 🔴 | |
| 79 | Backup luar server (S3 / Google Drive) | ❌ | 🔴 | Backup kini dalam server yang sama |

## I. Teknikal dan integrasi

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 80 | Hosting produksi dengan domain dan HTTPS | ❌ | 🔴 | Perlukan keputusan pengguna |
| 81 | Pagination, carian dan API dokumen berhalaman | ✅ | 🟠 | PR #6 |
| 82 | Sokongan reverse proxy (`TRUST_PROXY`) | ✅ | 🟠 | PR #6 |
| 83 | Ujian browser automatik (Playwright) | ❌ | 🟠 | CI ujian server sudah ada |
| 84 | Webhook keluar (n8n / Zapier tanpa polling) | ❌ | 🟢 | Kini polling `read_events` |
| 85 | Import data (CSV klien, servis, invois lama) dan PWA mudah alih | ❌ | 🟠 | |

---

## J. Idea untuk jadi unik

Kosongsatu sudah ada kelebihan yang jarang ada dalam sistem invois kecil: server MCP sebenar, proposal AI yang perlu kelulusan pemilik, ledger tunai yang ketat, dan self-hosted tanpa yuran. Idea di bawah membina di atas kelebihan itu.

| No | Idea | Status | Kenapa unik |
|---|---|---|---|
| 86 | **Server MCP dan proposal AI dengan kelulusan pemilik** | ✅ | Sudah ada. Pesaing tempatan belum ada |
| 87 | **Self-hosted, data milik sendiri, tiada yuran langganan** | ✅ | Sudah ada. Pesaing SaaS caj bulanan |
| 88 | **Cipta invois dengan bahasa biasa** (BM atau EN, melalui chat atau WhatsApp): "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" | 🟡 | Assistant AI sudah ada; perlukan model sendiri dan aliran draf yang lancar |
| 89 | **Ramalan klien lewat bayar** berdasarkan sejarah bayaran, dengan cadangan bila hantar peringatan | ❌ | Kebanyakan sistem hantar peringatan ikut jadual tetap sahaja |
| 90 | **Ejen kutipan AI**: draf mesej susulan yang sopan dan ikut budaya (BM/EN), tunggu kelulusan pemilik sebelum hantar | ❌ | Guna semula aliran proposal sedia ada |
| 91 | **Padanan bank automatik dengan AI**: cadang padanan bagi rujukan bank yang tidak kemas | ❌ | Mengurangkan kerja manual paling membosankan |
| 92 | **"Kesihatan tunai" sekali pandang**: berapa hari tunai bertahan, invois mana paling kritikal | ❌ | Lebih berguna daripada carta biasa |
| 93 | **Mod "siap MyInvois"**: semak setiap invois sama ada cukup data untuk e-Invoice, sebelum ambang dicapai | ❌ | Bersedia awal tanpa terikat dengan LHDN dulu |
| 94 | **Pemantau ambang cukai**: amaran bila jualan 12 bulan menghampiri RM500k (SST) atau RM3 juta (e-Invoice) | ❌ | Tiada pesaing kecil yang memberi amaran ini |
| 95 | **Laporan bulanan untuk akauntan** dihantar automatik (PDF + CSV) setiap awal bulan | ❌ | Menjimatkan masa tutup buku |
| 96 | **Pautan bayar dikongsi di WhatsApp dengan pratonton kemas** (Open Graph: nombor invois, amaun, butang Bayar) | ❌ | Kebanyakan klien Malaysia buka pautan di WhatsApp |
| 97 | **Bukti kerja dalam invois**: lampir gambar sebelum/selepas, log kerja atau laporan servis | ❌ | Kurangkan pertikaian, sesuai untuk syarikat servis |
| 98 | **Rantai audit boleh disahkan** (hash berantai) supaya akauntan atau juruaudit boleh sahkan rekod tidak diusik | ❌ | Lanjutan audit sedia ada yang sudah tidak boleh dipadam |
| 99 | **Maklum balas klien selepas bayar** (rating dan komen ringkas) dan testimoni | ❌ | Mengubah invois jadi titik hubungan pelanggan |
| 100 | **Pemasangan sekali klik** (templat Docker untuk VPS Malaysia) supaya perniagaan lain boleh guna Kosongsatu | ❌ | Membuka peluang Kosongsatu jadi produk, bukan alat dalaman sahaja |

---

## Cadangan urutan seterusnya

Ciri yang sudah siap tetapi menunggu akaun pengguna (no. 27, 28, 32, 38) akan hidup sebaik kunci Billplz dan akaun SMTP dimasukkan. Selepas itu, urutan yang dicadangkan:

1. **Hosting produksi dan backup luar server** (no. 80, 79). Tanpa ini data perniagaan berisiko.
2. **Rutin harian:** templat emel, notifikasi pemilik, DuitNow QR statik, muat naik slip (no. 40, 45, 30, 31).
3. **Bil yang fleksibel:** recurring mingguan/tahunan dan auto-issue, diskaun per baris, proforma (no. 9, 10, 6, 11).
4. **Duit keluar dan laporan:** perbelanjaan, untung rugi, laporan jualan, akses akauntan (no. 55, 58, 57, 61).
5. **Pembeza AI:** invois dengan bahasa biasa, ejen kutipan, padanan bank AI, pemantau ambang cukai (no. 88, 90, 91, 94).
6. **MyInvois** apabila jualan menghampiri RM3 juta atau pelanggan memintanya (no. 21–24).
