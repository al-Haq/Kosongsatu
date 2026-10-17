import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { currency as formatMoney, taxSummary, AppError } from "./domain.mjs";
import { drawQr } from "./qr.mjs";
import { labels, titleFor, statusLabel } from "../public/ext/documents-i18n.mjs";
import { pdfStore } from "./documents-assets.mjs";
import { documentSettings, fieldApplies } from "./documents-store.mjs";
import { hasCjk, cjkFontPath, loadFontFace, boldSibling, CJK_MESSAGE } from "./documents-fonts.mjs";
const regular = fileURLToPath(
  new URL("../public/assets/fonts/DejaVuSans.ttf", import.meta.url),
);
const bold = fileURLToPath(
  new URL("../public/assets/fonts/DejaVuSans-Bold.ttf", import.meta.url),
);
const logo = fileURLToPath(
  new URL("../public/assets/nawlogic-logo.png", import.meta.url),
);
// Layout styles. "classic" is the original Nawlogic look and stays the default.
const LAYOUT = {
  classic: { title: 17, body: 10, small: 9, rowMin: 30, rowPad: 17, head: 27 },
  modern: { title: 18, body: 10, small: 9, rowMin: 30, rowPad: 17, head: 27 },
  compact: { title: 14, body: 9, small: 8, rowMin: 22, rowPad: 11, head: 22 },
};
function tint(accent) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(accent || "") || accent.toUpperCase() === "#087F7E") return "#E8F8F6";
  const mix = (i) => Math.round(parseInt(accent.slice(i, i + 2), 16) * 0.1 + 255 * 0.9);
  return "#" + [1, 3, 5].map((i) => mix(i).toString(16).padStart(2, "0")).join("");
}
// Fonts, template and labels shared by every PDF of a document, receipt or statement.
export function pdfContext(pdf, doc, requiredText = []) {
  pdf.registerFont("Body", regular);
  pdf.registerFont("Bold", bold);
  const store = pdfStore(doc.business);
  const language = doc.language || documentSettings(doc.business).documentLanguage || "en";
  const fontPath = store?.cjkFont ? store.cjkFont() : cjkFontPath(process.env.PDF_CJK_FONT);
  const face = fontPath ? loadFontFace(fontPath) : null;
  if (face) {
    pdf.registerFont("CJK", face.data, face.family || undefined);
    const boldPath = boldSibling(fontPath);
    const strong = (boldPath && loadFontFace(boldPath)) || face;
    pdf.registerFont("CJKBold", strong.data, strong.family || undefined);
  } else if (language === "zh" || requiredText.some(hasCjk)) throw new AppError(CJK_MESSAGE, 409);
  const s = documentSettings(doc.business);
  const custom = store?.logoFor ? store.logoFor(doc.business) : null;
  return {
    t: labels(language),
    language,
    template: s,
    layout: LAYOUT[s.pdfLayout] || LAYOUT.classic,
    accent: /^#[0-9A-Fa-f]{6}$/.test(s.pdfAccent || "") ? s.pdfAccent : "#087F7E",
    logo: custom?.data || null,
    // CJK text uses the CJK font (it also has Latin glyphs), everything else DejaVu.
    font: (name, value) => (face && hasCjk(value) ? (name === "Bold" ? "CJKBold" : "CJK") : name),
    money: (v) => formatMoney(v, doc.currency || "MYR"),
    // A light tint of the accent for panels; the default keeps the original teal tint.
    tint: tint(s.pdfAccent),
  };
}
// Logo at the top left: the business logo when set, otherwise Nawlogic.
export function drawLogo(pdf, ctx, x, y, width, height) {
  if (ctx.logo) {
    try {
      pdf.image(ctx.logo, x + 5, y, { fit: [width, height] });
      return;
    } catch {
      // An unreadable image falls back to the default logo.
    }
  }
  pdf.image(logo, x, y, { width });
}
// The page footer: owner text (or "Nawlogic | Business document"), the e-Invoice notice and page numbers.
export function drawFooter(pdf, ctx, line, rule, kindText, disclaimer = null) {
  const pages = pdf.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    pdf.switchToPage(i);
    rule(778);
    if (ctx.template.pdfShowFooter !== false)
      line(
        `${ctx.template.pdfFooterText || "Nawlogic | " + kindText} | ${disclaimer || ctx.t("notEInvoice")}`,
        42,
        788,
        7,
        "Body",
        "#64748B",
        450,
      );
    line(`${i + 1} / ${pages.count}`, 511, 788, 7, "Body", "#64748B", 42);
  }
}
export function renderPdf(invoice, payment = null, blocks = []) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: {
        Title: payment
          ? "Nawlogic payment receipt"
          : `${labels("en")("kind_" + invoice.kind)} ${invoice.number || "DRAFT"}`,
        Author: invoice.business.company,
      },
    });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    const items = invoice.items || [];
    const customFields = payment
      ? []
      : (documentSettings(invoice.business).customFields || [])
          .filter((f) => f.show === "pdf" && fieldApplies(f, invoice.kind) && invoice.meta?.custom?.[f.id])
          .map((f) => [f.label, invoice.meta.custom[f.id]]);
    let ctx;
    try {
      ctx = pdfContext(pdf, invoice, [
        ...items.map((i) => i.description),
        invoice.notes,
        invoice.terms,
        ...customFields.map((f) => f[1]),
      ]);
    } catch (e) {
      reject(e);
      return;
    }
    const { t, money, layout: L, template: T } = ctx;
    const ink = "#0F172A",
      teal = ctx.accent,
      muted = "#64748B";
    const kind = invoice.kind || "invoice";
    const priced = kind !== "delivery_order";
    const currencyCode = invoice.currency || "MYR";
    let y = 42;
    const line = (
      value,
      x,
      yy,
      size = 10,
      font = "Body",
      color = ink,
      width = 510,
    ) => {
      pdf
        .font(ctx.font(font, value))
        .fontSize(size)
        .fillColor(color)
        .text(String(value || ""), x, yy, { width, lineGap: 3 });
      return pdf.y;
    };
    const rule = (yy) =>
      pdf
        .strokeColor("#E2E8F0")
        .lineWidth(0.7)
        .moveTo(42, yy)
        .lineTo(553, yy)
        .stroke();
    const newPage = () => {
      pdf.addPage();
      y = 46;
      line(`${invoice.number || "DRAFT"} / ${t("continued")}`, 42, y, 10, "Bold");
      y += 35;
    };
    const room = (h) => {
      if (y + h > 755) newPage();
    };
    const title = payment ? titleFor(ctx.language, "receipt") : titleFor(ctx.language, kind);
    // Long translated titles shrink to fit on one line.
    const fit = (value, size) => {
      pdf.font(ctx.font("Bold", value));
      while (size > 11 && pdf.fontSize(size).widthOfString(value) > 214) size--;
      return size;
    };
    const subtitle = payment
      ? `${t("receipt")} ${payment.number || payment.id.slice(0, 8).toUpperCase()}`
      : invoice.number || t("draftNotIssued");
    if (T.pdfLayout === "modern") {
      pdf.rect(0, 0, 595.28, 104).fill(teal);
      pdf.roundedRect(34, 24, 186, 58, 7).fill("#FFFFFF");
      drawLogo(pdf, ctx, 40, 30, 165, 46);
      line(title, 337, 36, fit(title, L.title), "Bold", "#FFFFFF", 216);
      line(subtitle, 337, 66, 10, "Body", "#FFFFFF", 216);
      y = 124;
    } else if (T.pdfLayout === "compact") {
      drawLogo(pdf, ctx, 37, 30, 130, 40);
      line(title, 337, 38, fit(title, L.title), "Bold", teal, 216);
      line(subtitle, 337, 60, 9, "Body", muted, 216);
      y = 88;
    } else {
      drawLogo(pdf, ctx, 37, 32, 165, 60);
      line(title, 337, 49, fit(title, L.title), "Bold", ink, 216);
      line(subtitle, 337, 79, 10, "Body", muted, 216);
      y = 114;
    }
    line(invoice.business.company, 42, y, L.body + 2, "Bold");
    y = pdf.y + 9;
    const company = [
      invoice.business.registration
        ? `${t("registration")}: ${invoice.business.registration}`
        : "",
      [
        invoice.business.tin ? `${t("tin")}: ${invoice.business.tin}` : "",
        invoice.business.sstNumber ? `${t("sstNo")}: ${invoice.business.sstNumber}` : "",
      ]
        .filter(Boolean)
        .join("  |  "),
      invoice.business.address,
      invoice.business.email,
      invoice.business.phone,
    ]
      .filter(Boolean)
      .join("\n");
    if (company) {
      line(company, 42, y, L.small, "Body", muted, 320);
      y = pdf.y + 15;
    } else y += 10;
    rule(y);
    y += 19;
    line((kind === "delivery_order" ? t("deliverTo") : t("billTo")).toUpperCase(), 42, y, L.small, "Bold", muted);
    line(
      (payment ? t("paymentDetails") : t("documentDetails")).toUpperCase(),
      337,
      y,
      L.small,
      "Bold",
      muted,
      216,
    );
    y += 19;
    const clientEnd = line(
      [
        invoice.client.name,
        invoice.client.contact,
        invoice.client.address,
        invoice.client.email,
        T.pdfShowBuyerTax === false
          ? ""
          : [
              invoice.client.brn ? `${t("regIc")}: ${invoice.client.brn}` : "",
              invoice.client.tin ? `${t("tin")}: ${invoice.client.tin}` : "",
              invoice.client.sst_number ? `SST: ${invoice.client.sst_number}` : "",
            ]
              .filter(Boolean)
              .join("  |  "),
      ]
        .filter(Boolean)
        .join("\n"),
      42,
      y,
      L.body,
      "Body",
      ink,
      275,
    );
    const dueLabel =
      kind === "quote" || kind === "proforma"
        ? t("validUntil")
        : kind === "sales_order"
          ? t("requiredBy")
          : kind === "delivery_order"
            ? t("deliveryDate")
            : t("due");
    const details = payment
      ? `${payment.receiptMode ? t("receipt") : t("invoiceRef")}: ${invoice.number}\n${t("received")}: ${payment.paid_date}\n${t("method")}: ${payment.method}\n${t("reference")}: ${payment.reference}`
      : [
          `${t("issued")}: ${invoice.issue_date}`,
          `${dueLabel}: ${invoice.due_date}`,
          `${t("currency")}: ${currencyCode}`,
          currencyCode !== "MYR" && invoice.fx_rate
            ? `${t("exchangeRate")}: 1 ${currencyCode} = ${invoice.fx_rate} MYR`
            : "",
          `${t("status")}: ${statusLabel(ctx.language, invoice.status)}`,
          invoice.links?.source?.number ? `${t("basedOn")}: ${invoice.links.source.number}` : "",
          ...[...new Set(items.filter((i) => i.deposit_id).map((i) => i.deposit_number))].map(
            (n) => `${t("deposit")}: ${n}`,
          ),
          ...customFields.map(([label, value]) => `${label}: ${value}`),
        ]
          .filter(Boolean)
          .join("\n");
    const detailEnd = line(details, 337, y, L.small, "Body", muted, 216);
    y = Math.max(clientEnd, detailEnd) + 26;
    if (invoice.business.demo) {
      line(t("demo"), 42, y, 10, "Bold", "#9A4600");
      y = pdf.y + 17;
    }
    if (payment) {
      room(120);
      pdf.roundedRect(42, y, 511, 85, 8).fill(ctx.tint);
      line(t("paymentReceived").toUpperCase(), 59, y + 15, 9, "Bold", teal);
      line(money(payment.amount), 59, y + 37, 26, "Bold", teal);
      y += 111;
      line(t("receiptAck"), 42, y, 10);
      y = pdf.y + 18;
      line(
        payment.receiptMode
          ? `${t("allocated")}: ${money(invoice.paid)} | ${t("unallocated")}: ${money(invoice.balance)} | ${t("refunded")}: ${money(payment.refunded || 0)}`
          : `${t("invoiceTotal")}: ${money(invoice.total)} | ${t("currentBalance")}: ${money(invoice.balance)}`,
        42,
        y,
        10,
      );
      y = pdf.y + 20;
    } else {
      // Columns: code, unit and discount only appear when a line has one.
      const showCode = items.some((i) => i.sku),
        showUnit = items.some((i) => i.unit),
        showDiscount = priced && items.some((i) => i.discount);
      const head = (key) => t(key).toUpperCase();
      let cols;
      if (priced && !showCode && !showUnit && !showDiscount)
        cols = [
          { key: "description", x: 52, w: 269, head: head("description") },
          { key: "qty", x: 333, w: 50, head: head("qty") },
          { key: "rate", x: 389, w: 78, head: `${head("rate")} (${currencyCode === "MYR" ? "RM" : currencyCode})` },
          { key: "amount", x: 477, w: 78, head: head("amount") },
        ];
      else {
        const right = [
          { key: "qty", w: priced ? 34 : 60, head: head("qty") },
          ...(showUnit ? [{ key: "unit", w: priced ? 44 : 80, head: head("unit") }] : []),
          ...(priced
            ? [
                { key: "rate", w: 66, head: `${head("rate")} (${currencyCode === "MYR" ? "RM" : currencyCode})` },
                ...(showDiscount ? [{ key: "discount", w: 54, head: head("discount") }] : []),
                { key: "amount", w: 70, head: head("amount") },
              ]
            : []),
        ];
        let x = 553;
        for (const c of right.reverse()) {
          x -= c.w;
          c.x = x;
          x -= 6;
        }
        right.reverse();
        const left = showCode ? [{ key: "code", x: 52, w: 58, head: head("code") }] : [];
        const descX = showCode ? 116 : 52;
        cols = [...left, { key: "description", x: descX, w: x - descX, head: head("description") }, ...right];
      }
      const desc = cols.find((c) => c.key === "description");
      const tableHead = () => {
        pdf.rect(42, y, 511, L.head).fill(T.pdfLayout === "modern" ? ctx.tint : "#F4F7FA");
        for (const c of cols) {
          // Long translated headers shrink to stay on one line.
          let size = L.small;
          pdf.font(ctx.font("Bold", c.head));
          while (size > 6.5 && pdf.fontSize(size).widthOfString(c.head) > c.w + 5) size -= 0.5;
          line(c.head, c.x, y + (L.head - 11) / 2, size, "Bold", muted, c.w + 6);
        }
        y += L.head + 8;
      };
      const cell = (i, key) =>
        ({
          code: i.sku || "",
          qty: String(i.quantity),
          unit: i.unit || "",
          rate: (i.rate / 100).toFixed(2),
          discount: i.discount ? (i.discount / 100).toFixed(2) + (i.discount_percent ? `\n${i.discount_percent}%` : "") : "",
          amount: (i.amount / 100).toFixed(2),
        })[key];
      room(90);
      tableHead();
      // Deposit deductions are shown in the totals, so the amount column adds up.
      for (const item of items.filter((i) => !i.deposit_id)) {
        const description =
          priced && item.tax_rate && !item.deposit_id
            ? `${item.description}\n${t("sst")} ${item.tax_rate}%`
            : item.description;
        pdf.font(ctx.font("Body", description)).fontSize(L.body);
        const height = Math.max(
          L.rowMin,
          pdf.heightOfString(description, { width: desc.w }) + L.rowPad,
        );
        if (y + height > 735) {
          newPage();
          tableHead();
        }
        for (const c of cols)
          if (c.key === "description") line(description, c.x, y, L.body, "Body", ink, c.w);
          else line(cell(item, c.key), c.x, y, L.small, "Body", ink, c.w);
        y += height;
        rule(y - 6);
      }
      if (priced) {
        const totals = [
          [t("subtotal"), invoice.subtotal],
          [t("discount"), invoice.discount],
          ...(items.some((i) => i.deposit_id)
            ? [[t("lessDepositShort"), items.filter((i) => i.deposit_id).reduce((sum, i) => sum + i.amount, 0)]]
            : []),
          ...taxSummary(items).map((x) => [`${t("sst")} ${x.rate}%`, x.tax]),
          [kind === "invoice" ? t("originalTotal") : t("total"), invoice.total, kind !== "invoice"],
          ...(invoice.credit ? [[t("creditNotes"), -invoice.credit]] : []),
          ...(invoice.debit ? [[t("debitNotes"), invoice.debit]] : []),
          ...(invoice.credit || invoice.debit
            ? [[t("adjustedTotal"), invoice.adjusted_total]]
            : []),
          ...(kind === "invoice"
            ? [
                [t("paid"), invoice.paid],
                [t("balanceDue"), invoice.balance, true],
              ]
            : []),
        ];
        // Reserve the whole totals block (SST rows included) so it never splits across a page.
        const step = T.pdfLayout === "compact" ? 18 : 24;
        room(Math.max(215, totals.length * step + 23));
        y += 10;
        for (const [label, value, strong] of totals) {
          line(
            label,
            330,
            y,
            strong ? 11 : 10,
            strong ? "Bold" : "Body",
            strong ? ink : muted,
            110,
          );
          line(
            money(value),
            449,
            y,
            strong ? 11 : 10,
            strong ? "Bold" : "Body",
            strong ? teal : ink,
            104,
          );
          y += step;
        }
      }
    }
    const instalments = invoice.instalments || [];
    const deposit = kind === "quote" ? invoice.deposit : null;
    const visibleFiles = invoice.meta?.list_attachments
      ? (invoice.attachments || []).filter((f) => f.visibility === "client")
      : [];
    for (const [heading, value] of [
      [
        t("adjustments"),
        (invoice.adjustments || [])
          .map(
            (a) =>
              `${a.number} / ${t("kind_" + a.kind)}: ${money(a.amount)} / ${a.reason}`,
          )
          .join("\n"),
      ],
      [
        t("depositRequired"),
        deposit && deposit.total
          ? t("depositOf", {
              value: deposit.type === "percent" ? deposit.value + "%" : "",
              amount: money(deposit.total) + (deposit.tax ? ` (${t("inclSst")})` : ""),
            }).replace("  ", " ")
          : "",
      ],
      [
        t("instalmentPlan"),
        instalments.length
          ? [
              ...instalments.map(
                (i) => `${i.seq}. ${i.due_date}   ${money(i.amount)}   ${t("ins_" + i.status)}`,
              ),
              ...(invoice.next_due_date
                ? ["", t("nextPaymentDue", { amount: money(invoice.next_due_amount), date: invoice.next_due_date })]
                : []),
            ].join("\n")
          : "",
      ],
      [
        t("paymentInformation"),
        payment || T.pdfShowBank === false
          ? ""
          : kind === "invoice" || kind === "proforma"
            ? [
                invoice.business.bankName,
                invoice.business.bankHolder,
                invoice.business.bankAccount,
                invoice.business.bankAccount
                  ? `${t("reference")}: ${invoice.number || "DRAFT"}`
                  : t("bankMissing"),
              ]
                .filter(Boolean)
                .join("\n")
            : "",
      ],
      [t("terms"), T.pdfShowTerms === false ? "" : invoice.terms],
      [t("notes"), T.pdfShowNotes === false ? "" : invoice.notes],
      [t("attachments"), visibleFiles.map((f) => `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join("\n")],
    ]) {
      if (!value) continue;
      room(55);
      y += 13;
      line(heading, 42, y, 10, "Bold");
      y += 19;
      // Wrap long audit/note blocks explicitly so every page retains its footer margin.
      pdf.font(ctx.font("Body", value)).fontSize(9);
      const lines = [];
      for (const paragraph of String(value).split("\n")) {
        let current = "";
        for (const word of paragraph.split(/\s+/)) {
          const candidate = current ? current + " " + word : word;
          if (pdf.widthOfString(candidate) <= 511) {
            current = candidate;
            continue;
          }
          if (current) lines.push(current);
          current = "";
          for (const char of word) {
            if (pdf.widthOfString(current + char) > 511) {
              lines.push(current);
              current = "";
            }
            current += char;
          }
        }
        lines.push(current);
      }
      for (const text of lines) {
        room(18);
        line(text || " ", 42, y, 9, "Body", muted);
        y += 16;
      }
      y += 8;
    }
    // Delivery orders end with signature boxes for both sides.
    if (kind === "delivery_order" && !payment) {
      room(170);
      y += 18;
      for (const [x, label] of [
        [42, t("deliveredBy")],
        [313, t("receivedBy")],
      ]) {
        line(label.toUpperCase(), x, y, 9, "Bold", muted, 240);
        if (x === 313) line(t("goodsReceived"), x, y + 16, 8, "Body", muted, 240);
        let yy = y + 52;
        for (const f of [t("signature"), t("name"), t("date")]) {
          pdf.strokeColor("#94A3B8").lineWidth(0.7).moveTo(x, yy).lineTo(x + 240, yy).stroke();
          line(f, x, yy + 4, 8, "Body", muted, 240);
          yy += 34;
        }
      }
      y += 160;
    }
    // Extra blocks from feature modules: QR codes, signatures, photos, notes.
    // Each block keeps its visual and its text together on one page.
    for (const block of blocks || []) {
      const visual = block.qr ? block.qrSize || 96 : block.image ? block.imageWidth || 140 : 0;
      const textX = visual ? 42 + visual + 16 : 42,
        textWidth = 553 - textX;
      pdf.font(ctx.font("Body", block.text)).fontSize(9);
      const textHeight = block.text
        ? pdf.heightOfString(String(block.text), { width: textWidth, lineGap: 3 })
        : 0;
      let visualHeight = block.qr ? visual : 0;
      if (block.image) {
        try {
          const img = pdf.openImage(block.image);
          visualHeight = Math.min(block.imageHeight || 220, (img.height / img.width) * visual);
          block._img = img;
        } catch {
          block._img = null;
        }
      }
      room(Math.max(visualHeight, textHeight) + 40);
      y += 13;
      if (block.heading) {
        line(block.heading, 42, y, 10, "Bold");
        y += 19;
      }
      if (block.qr) drawQr(pdf, block.qr, 42, y, visual);
      if (block._img) pdf.image(block._img, 42, y, { fit: [visual, visualHeight] });
      if (block.text) line(block.text, textX, y, 9, "Body", muted, textWidth);
      y += Math.max(visualHeight, textHeight) + 12;
    }
    // A module block may replace the disclaimer, e.g. for a validated e-Invoice.
    drawFooter(pdf, ctx, line, rule, payment ? t("footerReceipt") : t("footerDocument"), (blocks || []).find((b) => b.footer)?.footer);
    pdf.end();
  });
}

export function renderReceiptPdf(receipt) {
  const language =
    receipt.client?.language || documentSettings(receipt.business).documentLanguage || "en";
  const invoice = {
    kind: "invoice",
    number: receipt.number,
    business: receipt.business,
    client: receipt.client,
    currency: receipt.currency || "MYR",
    language,
    issue_date: receipt.paid_date,
    due_date: receipt.paid_date,
    status: receipt.voided ? "Void" : "Received",
    items: [],
    total: receipt.amount,
    subtotal: receipt.amount,
    discount: 0,
    paid: receipt.allocated,
    balance: receipt.available,
    terms: "",
    notes: labels(language)("receiptNotes"),
  };
  return renderPdf(invoice, {
    ...receipt,
    receiptMode: true,
    refunded: receipt.refunded,
  });
}
export function renderAdjustmentPdf(invoice, note, blocks = []) {
  const t = labels(invoice.language || "en");
  // A note's SST split by rate (tax module), else one tax-inclusive line.
  let split = null;
  try {
    split = note.tax_lines ? JSON.parse(note.tax_lines) : null;
  } catch {
    split = null;
  }
  const items = split?.some((l) => l.tax)
    ? split.map((l) => ({
        description: split.length > 1 ? `${note.reason}\n${t("portionAt", { rate: l.rate })}` : note.reason,
        quantity: 1,
        rate: l.taxable,
        amount: l.taxable,
        tax_rate: l.rate,
        tax: l.tax,
      }))
    : [{ description: note.reason, quantity: 1, rate: note.amount, amount: note.amount }];
  return renderPdf({
    ...invoice,
    kind: note.kind,
    number: note.number,
    issue_date: note.issue_date || note.paid_date,
    due_date: note.issue_date || note.paid_date,
    status: "Issued",
    items,
    subtotal: items.reduce((s, i) => s + i.amount, 0),
    discount: 0,
    total: note.amount,
    adjusted_total: note.amount,
    credit: 0,
    debit: 0,
    adjustments: [],
    instalments: [],
    deposit: null,
    meta: {},
    links: null,
    paid: 0,
    balance: 0,
    terms: "",
    notes: `${t("noteReferencing", { note: t("kind_" + note.kind), number: invoice.number })}\n${note.reference ? t("transactionReference") + ": " + note.reference : ""}`,
  }, null, blocks);
}
