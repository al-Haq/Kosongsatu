import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { currency } from "./domain.mjs";
const font = (name) =>
  fileURLToPath(new URL(`../public/assets/fonts/${name}`, import.meta.url));
const logo = fileURLToPath(
  new URL("../public/assets/nawlogic-logo.png", import.meta.url),
);
const label = (v) =>
  new Date(v + "T00:00:00Z").toLocaleDateString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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
    pdf.registerFont("Body", font("DejaVuSans.ttf"));
    pdf.registerFont("Bold", font("DejaVuSans-Bold.ttf"));
    const ink = "#0F172A",
      muted = "#64748B",
      teal = "#087F7E";
    const put = (v, x, y, size = 9, f = "Body", color = ink, width = 510, align = "left") =>
      pdf.font(f).fontSize(size).fillColor(color).text(String(v ?? ""), x, y, { width, align, lineGap: 2 });
    const rule = (y) =>
      pdf.strokeColor("#E2E8F0").lineWidth(0.7).moveTo(42, y).lineTo(553, y).stroke();
    pdf.image(logo, 37, 32, { width: 150 });
    put("STATEMENT OF ACCOUNT", 330, 46, 14, "Bold", teal, 223, "right");
    put(`${label(s.from)} – ${label(s.to)}`, 330, 68, 9, "Body", muted, 223, "right");
    const b = s.business;
    put(
      [b.company, b.registration ? `Reg: ${b.registration}` : "", b.address, b.email, b.phone]
        .filter(Boolean)
        .join("\n"),
      42,
      92,
      8,
      "Body",
      muted,
      250,
    );
    put("STATEMENT FOR", 330, 92, 7, "Bold", muted, 223);
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
      [42, 70, "Date"],
      [112, 90, "Type"],
      [202, 120, "Reference"],
      [322, 75, "Charges"],
      [397, 75, "Credits"],
      [472, 81, "Balance"],
    ];
    const header = () => {
      for (const [x, w, t] of cols)
        put(t.toUpperCase(), x, y, 7, "Bold", muted, w, x >= 322 ? "right" : "left");
      y += 14;
      rule(y);
      y += 6;
    };
    header();
    const row = (cells, f = "Body") => {
      if (y > 740) {
        pdf.addPage();
        y = 46;
        header();
      }
      cells.forEach((v, i) =>
        put(v, cols[i][0], y, 8.5, f, ink, cols[i][1], i >= 3 ? "right" : "left"),
      );
      y += 16;
    };
    row([label(s.from), "Opening balance", "", "", "", currency(s.opening)], "Bold");
    for (const l of s.lines)
      row([
        label(l.date),
        l.type,
        l.ref,
        l.debit ? currency(l.debit) : "",
        l.credit ? currency(l.credit) : "",
        currency(l.balance),
      ]);
    rule(y);
    y += 6;
    row([label(s.to), "Closing balance", "", "", "", currency(s.closing)], "Bold");
    y += 14;
    if (y > 690) {
      pdf.addPage();
      y = 46;
    }
    put("AGING OF OUTSTANDING INVOICES", 42, y, 7, "Bold", muted);
    y += 14;
    const buckets = [
      ["Current", s.aging.current],
      ["1–30 days", s.aging.d30],
      ["31–60 days", s.aging.d60],
      ["61–90 days", s.aging.d90],
      ["Over 90 days", s.aging.over90],
      ["Total due", s.outstanding],
    ];
    buckets.forEach(([t, v], i) => {
      put(t, 42 + i * 85, y, 7.5, "Body", muted, 82);
      put(currency(v), 42 + i * 85, y + 12, 9, i === 5 ? "Bold" : "Body", ink, 82);
    });
    y += 40;
    if (b.bankAccount) {
      put("PAYMENT DETAILS", 42, y, 7, "Bold", muted);
      put([b.bankName, b.bankHolder, b.bankAccount].filter(Boolean).join("\n"), 42, y + 12, 9);
    }
    const pages = pdf.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      pdf.switchToPage(i);
      put(
        "Statement of invoiced amounts and confirmed payments recorded by the issuer. Not a validated MyInvois e-Invoice.",
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
