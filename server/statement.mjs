import PDFDocument from "pdfkit";
import { currency as formatMoney } from "./domain.mjs";
import { pdfContext, drawLogo } from "./pdf.mjs";
import { LOCALES } from "../public/ext/documents-i18n.mjs";
const TYPE_KEYS = {
  Invoice: "kind_invoice",
  "Credit note": "kind_credit",
  "Debit note": "kind_debit",
  Payment: "payment",
  "Moved to customer funds": "movedToFunds",
};
export function renderStatementPdf(s) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: {
        Title: `Statement of account ${s.client.name} ${s.to}`,
        Author: s.business.company,
      },
    });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    let ctx;
    try {
      ctx = pdfContext(pdf, { business: s.business, language: s.client.language || s.language });
    } catch (e) {
      reject(e);
      return;
    }
    const { t } = ctx;
    const ink = "#0F172A",
      muted = "#64748B",
      teal = ctx.accent;
    const label = (v) =>
      new Date(v + "T00:00:00Z").toLocaleDateString(LOCALES[ctx.language] || "en-MY", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
    const put = (v, x, y, size = 9, f = "Body", color = ink, width = 510, align = "left") =>
      pdf
        .font(ctx.font(f, v))
        .fontSize(size)
        .fillColor(color)
        .text(String(v ?? ""), x, y, { width, align, lineGap: 2 });
    const rule = (y) =>
      pdf.strokeColor("#E2E8F0").lineWidth(0.7).moveTo(42, y).lineTo(553, y).stroke();
    if (ctx.template.pdfLayout === "modern") {
      pdf.rect(0, 0, 595.28, 84).fill(teal);
      pdf.roundedRect(34, 18, 168, 50, 7).fill("#FFFFFF");
      drawLogo(pdf, ctx, 40, 23, 150, 40);
      put(t("kind_statement").toUpperCase(), 330, 30, 14, "Bold", "#FFFFFF", 223, "right");
      put(`${label(s.from)} – ${label(s.to)}`, 330, 52, 9, "Body", "#FFFFFF", 223, "right");
    } else {
      drawLogo(pdf, ctx, 37, 32, 150, 52);
      put(t("kind_statement").toUpperCase(), 330, 46, 14, "Bold", teal, 223, "right");
      put(`${label(s.from)} – ${label(s.to)}`, 330, 68, 9, "Body", muted, 223, "right");
    }
    const b = s.business;
    put(
      [b.company, b.registration ? `${t("regShort")}: ${b.registration}` : "", b.address, b.email, b.phone]
        .filter(Boolean)
        .join("\n"),
      42,
      92,
      8,
      "Body",
      muted,
      250,
    );
    put(t("statementFor").toUpperCase(), 330, 92, 7, "Bold", muted, 223);
    put(
      [s.client.name, s.client.contact, s.client.address].filter(Boolean).join("\n"),
      330,
      104,
      9,
      "Body",
      ink,
      223,
    );
    let y = Math.max(pdf.y, 170) + 14;
    const cols = [
      [42, 70, t("date")],
      [112, 90, t("type")],
      [202, 120, t("reference")],
      [322, 75, t("charges")],
      [397, 75, t("credits")],
      [472, 81, t("balance")],
    ];
    const header = () => {
      for (const [x, w, text] of cols)
        put(text.toUpperCase(), x, y, 7, "Bold", muted, w, x >= 322 ? "right" : "left");
      y += 14;
      rule(y);
      y += 6;
    };
    const page = (need) => {
      if (y > 790 - need) {
        pdf.addPage();
        y = 46;
        return true;
      }
      return false;
    };
    // One section per currency; a single-currency statement looks as it always did.
    const groups = s.groups?.length ? s.groups : [{ ...s, currency: s.currency || "MYR" }];
    for (const [n, g] of groups.entries()) {
      const money = (v) => formatMoney(v, g.currency || "MYR");
      if (groups.length > 1) {
        if (n) page(160);
        put(`${t("currency").toUpperCase()}: ${g.currency}`, 42, y, 9, "Bold", teal);
        y += 18;
      }
      header();
      const row = (cells, f = "Body") => {
        if (page(50)) header();
        cells.forEach((v, i) =>
          put(v, cols[i][0], y, 8.5, f, ink, cols[i][1], i >= 3 ? "right" : "left"),
        );
        y += 16;
      };
      row([label(g.from), t("openingBalance"), "", "", "", money(g.opening)], "Bold");
      for (const l of g.lines)
        row([
          label(l.date),
          TYPE_KEYS[l.type] ? t(TYPE_KEYS[l.type]) : l.type,
          l.ref,
          l.debit ? money(l.debit) : "",
          l.credit ? money(l.credit) : "",
          money(l.balance),
        ]);
      rule(y);
      y += 6;
      row([label(g.to), t("closingBalance"), "", "", "", money(g.closing)], "Bold");
      y += 14;
      page(100);
      put(t("aging").toUpperCase(), 42, y, 7, "Bold", muted);
      y += 14;
      const buckets = [
        [t("current"), g.aging.current],
        [t("d30"), g.aging.d30],
        [t("d60"), g.aging.d60],
        [t("d90"), g.aging.d90],
        [t("over90"), g.aging.over90],
        [t("totalDue"), g.outstanding],
      ];
      buckets.forEach(([text, v], i) => {
        put(text, 42 + i * 85, y, 7.5, "Body", muted, 82);
        put(money(v), 42 + i * 85, y + 12, 9, i === 5 ? "Bold" : "Body", ink, 82);
      });
      y += 40;
    }
    if (b.bankAccount && ctx.template.pdfShowBank !== false) {
      page(60);
      put(t("paymentDetails").toUpperCase(), 42, y, 7, "Bold", muted);
      put([b.bankName, b.bankHolder, b.bankAccount].filter(Boolean).join("\n"), 42, y + 12, 9);
    }
    const pages = pdf.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      pdf.switchToPage(i);
      if (ctx.template.pdfShowFooter !== false)
        put(
          ctx.template.pdfFooterText ? `${ctx.template.pdfFooterText} | ${t("notEInvoice")}` : t("statementFooter"),
          42,
          788,
          7,
          "Body",
          muted,
          450,
        );
      put(`${i + 1} / ${pages.count}`, 511, 788, 7, "Body", muted, 42);
    }
    pdf.end();
  });
}
