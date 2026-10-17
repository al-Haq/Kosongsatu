# 100 ciri untuk Kosongsatu: setanding pesaing, dan cara untuk jadi unik

Disediakan pada 17 Oktober 2026, berdasarkan kod `main` v0.8.0 (commit `8b3f6a9`), GAP-CIRI.md dan AUDIT.md.

**Kemas kini 17 Oktober 2026 (v0.9.0):** kesemua 100 ciri telah dibina dalam PR #7–#12. Status di bawah ialah status selepas PR tersebut; 🟡 bermaksud ciri itu siap tetapi perlukan akaun atau kunci pemilik (SMTP, penyedia bayaran, WhatsApp Business, MyInvois, model AI, storan S3, pelayan). Panduan pemilik setiap modul ada dalam [docs/features](features).

Pesaing yang dijadikan rujukan: Zoho Invoice, Invoice Ninja, Stripe Invoicing, Bukku, SQL Account, AutoCount, Xero dan QuickBooks. Ciri pesaing diambil daripada pengetahuan umum tentang produk mereka dan tidak disemak satu per satu hari ini.

**Status (disahkan dalam kod):**

- ✅ **Ada:** sudah dibina dan berfungsi
- 🟡 **Separa:** siap dibina dan diuji dengan penyedia tiruan; perlukan akaun atau kunci pemilik untuk hidup
- ❌ **Tiada:** belum dibina

**Keutamaan:** 🔴 wajib untuk setanding · 🟠 penting · 🟢 bagus ada / pembeza

## Ringkasan

| Status | Bilangan |
|---|---|
| ✅ Ada | 88 |
| 🟡 Separa | 12 |
| ❌ Tiada | 0 |

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
| 6 | Diskaun per baris (selain diskaun keseluruhan) | ✅ | 🟠 | Modul documents (PR #11) |
| 7 | Unit pada servis | ✅ | 🟠 | SKU & unit pada servis dan baris (PR #11) |
| 8 | Templat PDF boleh ubah (warna, susun atur, medan, logo) | ✅ | 🟠 | 3 susun atur, warna, logo sendiri (PR #11) |
| 9 | Recurring fleksibel: mingguan, suku tahun, tahunan | ✅ | 🟠 | Mingguan hingga tahunan (PR #10) |
| 10 | Recurring banyak baris, auto-issue dan auto-hantar | ✅ | 🟠 | Berbilang baris, auto-issue, auto-hantar (PR #10) |
| 11 | Proforma invoice | ✅ | 🟠 | Awalan PF (PR #11) |
| 12 | Delivery order dan sales order | ✅ | 🟢 | SO & DO (PR #11) |
| 13 | Pelbagai mata wang dengan kadar tukaran | ✅ | 🟢 | 11 mata wang, kadar tetap semasa issue (PR #11) |
| 14 | Dokumen dwibahasa (BM / EN / 中文) | ✅ | 🟢 | BM / EN / 中文; 中文 perlukan fon CJK (PR #11) |
| 15 | Medan tersuai (custom fields) dan lampiran fail pada invois | ✅ | 🟢 | 10 medan tersuai, lampiran (PR #11) |

## B. Cukai dan pematuhan Malaysia

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 16 | SST per baris (0/5/6/8/10%) | ✅ | 🔴 | PR #4 |
| 17 | TIN, BRN dan nombor SST penjual dan pembeli pada PDF | ✅ | 🔴 | PR #4 |
| 18 | Laporan ringkasan SST untuk SST-02 | ✅ | 🟠 | Lembaran kerja SST-02 PDF/CSV (PR #12) |
| 19 | SST pada nota kredit / debit | ✅ | 🟠 | Pecahan SST pada nota (PR #12) |
| 20 | Pengecualian SST (exemption) per pelanggan | ✅ | 🟢 | Per pelanggan, dengan tarikh tamat (PR #12) |
| 21 | LHDN MyInvois: hantar, validasi, UUID dan QR pada PDF | 🟡 | 🟠 | Siap; perlukan ID klien & rahsia MyInvois; belum diuji dengan sandbox sebenar (PR #12) |
| 22 | MyInvois: batal dalam 72 jam, nota kredit/debit e-Invoice | 🟡 | 🟠 | Siap; bergantung pada no. 21 (PR #12) |
| 23 | Consolidated e-Invoice dan self-billed | 🟡 | 🟢 | (PR #10) |
| 24 | Kod klasifikasi dan alamat penuh pembeli (kod negeri) | ✅ | 🟠 | Kod negeri, negara, MSIC, klasifikasi (PR #12) |

## C. Pembayaran dan kutipan

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 25 | Resit diagih ke banyak invois, bayaran separa | ✅ | 🔴 | |
| 26 | Nota kredit, nota debit dan refund bernombor | ✅ | 🔴 | |
| 27 | Payment gateway (FPX, kad, DuitNow) | 🟡 | 🔴 | Kunci boleh dimasukkan dalam Tetapan; perlukan akaun penyedia (PR #12) |
| 28 | Status invois bertukar Paid automatik selepas bayaran | 🟡 | 🔴 | Siap; hidup bila kunci dimasukkan (PR #12) |
| 29 | Gateway alternatif (ToyyibPay, Stripe, iPay88) | 🟡 | 🟢 | (PR #10) |
| 30 | DuitNow QR statik pada PDF invois | ✅ | 🟠 | Payload EMVCo disahkan atau imej bank (PR #12) |
| 31 | Klien muat naik slip bayaran | ✅ | 🟠 | Imej/PDF 5 MB, privat kepada pemilik (PR #12) |
| 32 | Peringatan automatik sebelum dan selepas tarikh akhir | 🟡 | 🔴 | Siap; perlukan akaun SMTP (boleh dimasukkan dalam Tetapan) (PR #10) |
| 33 | Caj lewat bayar automatik | ✅ | 🟢 | Nota debit automatik, had & pengecualian (PR #10) |
| 34 | Deposit / bayaran awal pada quotation | ✅ | 🟢 | Deposit & invois akhir dengan SST betul (PR #11) |
| 35 | Bayaran ansuran (payment plan) | ✅ | 🟢 | 2–24 ansuran, peringatan ikut ansuran (PR #11) |
| 36 | Import CSV bank dengan padanan dan dedupe | ✅ | 🟠 | |
| 37 | Import format asli Maybank / CIMB / Public Bank, atau bank feed | ✅ | 🟠 | Layout bank utama + pemetaan lajur; sahkan dengan fail sebenar (PR #12) |

## D. Penghantaran dan komunikasi

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 38 | Hantar emel invois / quotation dengan PDF | 🟡 | 🔴 | Siap; perlukan akaun SMTP (PR #10) |
| 39 | Log emel pada setiap dokumen | ✅ | 🟠 | PR #3 |
| 40 | Templat emel boleh ubah | ✅ | 🟠 | 7 templat EN/BM, pratonton (PR #10) |
| 41 | Penjejakan emel dibuka / bounce | ✅ | 🟢 | Buka dijejak; bounce perlukan webhook penyedia e-mel (PR #10) |
| 42 | Pembuka WhatsApp composer | ✅ | 🟢 | |
| 43 | WhatsApp Business API (hantar automatik) | 🟡 | 🟠 | Siap; perlukan akaun WhatsApp Business (Meta) (PR #10) |
| 44 | Pautan klien selamat (token, tamat tempoh, revoke) | ✅ | 🔴 | |
| 45 | Notifikasi kepada pemilik (bayaran masuk, quotation diterima) | ✅ | 🟠 | Loceng dalam app, e-mel/WhatsApp pilihan (PR #10) |

## E. Klien dan portal

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 46 | Katalog klien dengan terma bayaran | ✅ | 🔴 | |
| 47 | Klien terima quotation dalam talian dengan nama penandatangan | ✅ | 🟠 | |
| 48 | Statement of account dan aging per klien | ✅ | 🟠 | PR #3 |
| 49 | Akaun portal klien (semua dokumen di satu tempat) | ✅ | 🟠 | Pautan sekali guna, sesi berasingan (PR #10) |
| 50 | Berbilang kenalan per klien (bil, teknikal, CC) | ✅ | 🟠 | Peranan, Cc automatik (PR #10) |
| 51 | Had kredit dan tahan kerja bila tertunggak | ✅ | 🟢 | (PR #10) |
| 52 | Tandatangan elektronik pada quotation (lukis / taip) | ✅ | 🟢 | Lukis atau taip, dicetak pada PDF (PR #10) |

## F. Perakaunan dan laporan

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 53 | Dashboard invois, kutipan, baki dan overdue | ✅ | 🔴 | |
| 54 | Laporan aging seluruh perniagaan | ✅ | 🟠 | Melalui statement (PR #3) |
| 55 | Rekod perbelanjaan dan resit vendor | ✅ | 🟠 | Modul books (PR #10) |
| 56 | Imbas resit dengan OCR | 🟡 | 🟢 | Siap; perlukan model AI sendiri (PR #10) |
| 57 | Laporan jualan ikut klien / servis / bulan | ✅ | 🟠 | Ikut klien/item/bulan, CSV (PR #10) |
| 58 | Untung rugi ringkas | ✅ | 🟠 | Akruan & tunai, PDF/CSV (PR #10) |
| 59 | Eksport ke Bukku / SQL / Xero / AutoCount | ✅ | 🟠 | Xero, QuickBooks, Bukku, SQL, AutoCount; sahkan dengan import sebenar (PR #10) |
| 60 | Eksport CSV dan JSON perniagaan | ✅ | 🟠 | |
| 61 | Akses baca sahaja untuk akauntan | ✅ | 🟠 | Peranan akauntan baca sahaja (PR #9) |
| 62 | Laporan unjuran aliran tunai | ✅ | 🟢 | 13 minggu (PR #10) |
| 63 | Ringkasan cukai pendapatan tahunan (Borang B / P) | ✅ | 🟢 | Alat bantu; semak dengan ejen cukai (PR #10) |
| 64 | Purchase order kepada pembekal / bil pembekal | ✅ | 🟢 | PO pembekal & bil (PR #10) |

## G. Jualan dan operasi

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 65 | Opportunity → quotation → acceptance → PO → invois | ✅ | 🟠 | |
| 66 | Penerimaan luar talian dengan bukti | ✅ | 🟢 | |
| 67 | PO separa, pindaan dan muat naik fail PO | ✅ | 🟢 | PO separa, pindaan, fail (PR #10) |
| 68 | Jejak masa / timesheet → invois | ✅ | 🟢 | Pemasa & invois masa (PR #10) |
| 69 | Projek dan milestone billing | ✅ | 🟢 | Projek & milestone (PR #10) |
| 70 | Kontrak / retainer dengan tarikh tamat dan pembaharuan | ✅ | 🟢 | Kontrak & pembaharuan (PR #10) |
| 71 | Inventori ringkas | ✅ | 🟢 | Pilihan, mati secara lalai (PR #10) |

## H. Pengguna dan keselamatan

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 72 | Login, sesi server, CSRF, throttle login | ✅ | 🔴 | |
| 73 | MFA (TOTP) dan kod pemulihan | ✅ | 🟠 | |
| 74 | Kod QR untuk setup MFA | ✅ | 🟢 | (PR #9) |
| 75 | Audit sebelum/selepas yang tidak boleh dipadam | ✅ | 🟠 | |
| 76 | Berbilang pengguna dan peranan (admin, staf, akauntan) | ✅ | 🟠 | Pemilik, staf, akauntan (PR #9) |
| 77 | Reset kata laluan melalui emel | ✅ | 🟠 | Siap; e-mel perlukan SMTP (PR #9) |
| 78 | Backup bersulit harian dan restore | ✅ | 🔴 | |
| 79 | Backup luar server (S3 / Google Drive) | 🟡 | 🔴 | Siap; perlukan bucket S3 & kunci (PR #9) |

## I. Teknikal dan integrasi

| No | Ciri | Status | Keutamaan | Catatan |
|---|---|---|---|---|
| 80 | Hosting produksi dengan domain dan HTTPS | 🟡 | 🔴 | Kit pemasangan siap; pelayan & domain keputusan pemilik (PR #11) |
| 81 | Pagination, carian dan API dokumen berhalaman | ✅ | 🟠 | PR #6 |
| 82 | Sokongan reverse proxy (`TRUST_PROXY`) | ✅ | 🟠 | PR #6 |
| 83 | Ujian browser automatik (Playwright) | ✅ | 🟠 | Playwright dalam CI (PR #8) |
| 84 | Webhook keluar (n8n / Zapier tanpa polling) | ✅ | 🟢 | Tandatangan HMAC, retry, SSRF (PR #11) |
| 85 | Import data (CSV klien, servis, invois lama) dan PWA mudah alih | ✅ | 🟠 | (PR #10) |

---

## J. Idea untuk jadi unik

Kosongsatu sudah ada kelebihan yang jarang ada dalam sistem invois kecil: server MCP sebenar, proposal AI yang perlu kelulusan pemilik, ledger tunai yang ketat, dan self-hosted tanpa yuran. Idea di bawah membina di atas kelebihan itu.

| No | Idea | Status | Kenapa unik |
|---|---|---|---|
| 86 | **Server MCP dan proposal AI dengan kelulusan pemilik** | ✅ | Sudah ada. Pesaing tempatan belum ada |
| 87 | **Self-hosted, data milik sendiri, tiada yuran langganan** | ✅ | Sudah ada. Pesaing SaaS caj bulanan |
| 88 | **Cipta invois dengan bahasa biasa** (BM atau EN, melalui chat atau WhatsApp): "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" | ✅ | Assistant AI sudah ada; perlukan model sendiri dan aliran draf yang lancar |
| 89 | **Ramalan klien lewat bayar** berdasarkan sejarah bayaran, dengan cadangan bila hantar peringatan | ✅ | Kebanyakan sistem hantar peringatan ikut jadual tetap sahaja |
| 90 | **Ejen kutipan AI**: draf mesej susulan yang sopan dan ikut budaya (BM/EN), tunggu kelulusan pemilik sebelum hantar | ✅ | Guna semula aliran proposal sedia ada |
| 91 | **Padanan bank automatik dengan AI**: cadang padanan bagi rujukan bank yang tidak kemas | ✅ | Mengurangkan kerja manual paling membosankan |
| 92 | **"Kesihatan tunai" sekali pandang**: berapa hari tunai bertahan, invois mana paling kritikal | ✅ | Lebih berguna daripada carta biasa |
| 93 | **Mod "siap MyInvois"**: semak setiap invois sama ada cukup data untuk e-Invoice, sebelum ambang dicapai | ✅ | Bersedia awal tanpa terikat dengan LHDN dulu |
| 94 | **Pemantau ambang cukai**: amaran bila jualan 12 bulan menghampiri RM500k (SST) atau RM3 juta (e-Invoice) | ✅ | Tiada pesaing kecil yang memberi amaran ini |
| 95 | **Laporan bulanan untuk akauntan** dihantar automatik (PDF + CSV) setiap awal bulan | ✅ | Menjimatkan masa tutup buku |
| 96 | **Pautan bayar dikongsi di WhatsApp dengan pratonton kemas** (Open Graph: nombor invois, amaun, butang Bayar) | ✅ | Kebanyakan klien Malaysia buka pautan di WhatsApp |
| 97 | **Bukti kerja dalam invois**: lampir gambar sebelum/selepas, log kerja atau laporan servis | ✅ | Kurangkan pertikaian, sesuai untuk syarikat servis |
| 98 | **Rantai audit boleh disahkan** (hash berantai) supaya akauntan atau juruaudit boleh sahkan rekod tidak diusik | ✅ | Lanjutan audit sedia ada yang sudah tidak boleh dipadam |
| 99 | **Maklum balas klien selepas bayar** (rating dan komen ringkas) dan testimoni | ✅ | Mengubah invois jadi titik hubungan pelanggan |
| 100 | **Pemasangan sekali klik** (templat Docker untuk VPS Malaysia) supaya perniagaan lain boleh guna Kosongsatu | ✅ | Membuka peluang Kosongsatu jadi produk, bukan alat dalaman sahaja |

---

## Cadangan urutan seterusnya

Ciri yang sudah siap tetapi menunggu akaun pengguna (no. 27, 28, 32, 38) akan hidup sebaik kunci Billplz dan akaun SMTP dimasukkan. Selepas itu, urutan yang dicadangkan:

1. **Hosting produksi dan backup luar server** (no. 80, 79). Tanpa ini data perniagaan berisiko.
2. **Rutin harian:** templat emel, notifikasi pemilik, DuitNow QR statik, muat naik slip (no. 40, 45, 30, 31).
3. **Bil yang fleksibel:** recurring mingguan/tahunan dan auto-issue, diskaun per baris, proforma (no. 9, 10, 6, 11).
4. **Duit keluar dan laporan:** perbelanjaan, untung rugi, laporan jualan, akses akauntan (no. 55, 58, 57, 61).
5. **Pembeza AI:** invois dengan bahasa biasa, ejen kutipan, padanan bank AI, pemantau ambang cukai (no. 88, 90, 91, 94).
6. **MyInvois** apabila jualan menghampiri RM3 juta atau pelanggan memintanya (no. 21–24).
