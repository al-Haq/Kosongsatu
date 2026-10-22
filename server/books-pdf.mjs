// Branded PDFs for books: report tables (profit and loss, tax summary) and
// purchase orders. Same fonts and look as statements.
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { currency } from "./domain.mjs";
const font = (name) => fileURLToPath(new URL(`../public/assets/fonts/${name}`, import.meta.url));
const logo = fileURLToPath(new URL("../public/assets/nawlogic-logo.png", import.meta.url));
const ink = "#0F172A",
  muted = "#64748B",
  teal = "#087F7E",
  red = "#B42318";
export const dateLabel = (v) =>
  v
    ? new Date(v + "T00:00:00Z").toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : "";
function start(title, author) {
  const pdf = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: title, Author: author || "" } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  pdf.registerFont("Body", font("Archivo-Regular.ttf"));
  pdf.registerFont("Bold", font("Archivo-Bold.ttf"));
  const put = (v, x, y, size = 9, f = "Body", color = ink, width = 510, align = "left") =>
    pdf.font(f).fontSize(size).fillColor(color).text(String(v ?? ""), x, y, { width, align, lineGap: 2 });
  const rule = (y) => pdf.strokeColor("#E2E8F0").lineWidth(0.7).moveTo(42, y).lineTo(553, y).stroke();
  return { pdf, done, put, rule };
}
function footer(pdf, put, text) {
  const pages = pdf.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    pdf.switchToPage(i);
    put(text, 42, 784, 7, "Body", muted, 450);
    put(`${i + 1} / ${pages.count}`, 511, 784, 7, "Body", muted, 42, "right");
  }
}
// sections: [{ heading, text, notice, table: { columns: [{ label, width, align }], rows: [{ cells, bold, rule }] } }]
export async function renderReportPdf({ title, subtitle, business, sections, footerText }) {
  const { pdf, done, put, rule } = start(title, business?.company);
  pdf.image(logo, 37, 32, { width: 150 });
  put(title.toUpperCase(), 300, 46, 13, "Bold", teal, 253, "right");
  put(subtitle || "", 300, 66, 9, "Body", muted, 253, "right");
  put([business?.company, business?.registration ? `Reg: ${business.registration}` : "", business?.tin ? `TIN: ${business.tin}` : ""].filter(Boolean).join("\n"), 42, 92, 8, "Body", muted, 300);
  let y = Math.max(pdf.y, 130) + 12;
  const room = (h) => {
    if (y + h > 760) {
      pdf.addPage();
      y = 46;
    }
  };
  for (const s of sections) {
    if (s.heading) {
      room(40);
      put(s.heading.toUpperCase(), 42, y, 8, "Bold", teal);
      y += 16;
    }
    if (s.notice) {
      room(30);
      put(s.notice, 42, y, 8, "Body", red, 511);
      y = pdf.y + 8;
    }
    if (s.text) {
      room(30);
      put(s.text, 42, y, 8.5, "Body", muted, 511);
      y = pdf.y + 8;
    }
    if (s.table) {
      const cols = [];
      let x = 42;
      for (const c of s.table.columns) {
        cols.push({ ...c, x });
        x += c.width;
      }
      const head = () => {
        for (const c of cols) put(c.label.toUpperCase(), c.x, y, 6.5, "Bold", muted, c.width - 4, c.align || "left");
        y += 13;
        rule(y);
        y += 5;
      };
      room(40);
      head();
      for (const r of s.table.rows) {
        if (y > 745) {
          pdf.addPage();
          y = 46;
          head();
        }
        if (r.rule) {
          rule(y - 2);
          y += 3;
        }
        let h = 0;
        r.cells.forEach((v, i) => {
          const c = cols[i];
          if (!c) return;
          put(v, c.x, y, 8, r.bold ? "Bold" : "Body", r.color === "red" ? red : ink, c.width - 4, c.align || "left");
          h = Math.max(h, pdf.y - y);
        });
        y += Math.max(13, h + 3);
      }
      y += 10;
    }
  }
  footer(pdf, put, footerText || "Management report prepared from the records in this app. Not audited accounts.");
  pdf.end();
  return done;
}
export async function renderPurchaseOrderPdf(po) {
  const draft = po.state === "draft";
  const { pdf, done, put, rule } = start(`Purchase order ${po.number || "DRAFT"}`, po.business?.company);
  const b = po.business || {},
    v = po.vendor || {};
  pdf.image(logo, 37, 32, { width: 160 });
  put("PURCHASE ORDER", 320, 48, 16, "Bold", ink, 233, "right");
  put(po.number || "DRAFT - NOT ISSUED", 320, 74, 10, "Body", draft ? red : muted, 233, "right");
  put(b.company || "", 42, 110, 11, "Bold");
  put(
    [b.registration ? `Registration: ${b.registration}` : "", [b.tin ? `TIN: ${b.tin}` : "", b.sstNumber ? `SST No: ${b.sstNumber}` : ""].filter(Boolean).join("  |  "), b.address, b.email, b.phone]
      .filter(Boolean)
      .join("\n"),
    42,
    pdf.y + 4,
    8.5,
    "Body",
    muted,
    300,
  );
  const top = Math.max(pdf.y + 18, 200);
  put("SUPPLIER", 42, top, 7, "Bold", muted);
  put([v.name, v.contact ? `Attn: ${v.contact}` : "", v.address, v.email, v.phone, v.registration ? `Reg: ${v.registration}` : "", v.tin ? `TIN: ${v.tin}` : ""].filter(Boolean).join("\n"), 42, top + 12, 9, "Body", ink, 280);
  const left = pdf.y;
  put("ORDER DETAILS", 360, top, 7, "Bold", muted);
  put([`Order date: ${dateLabel(po.po_date)}`, po.expected_date ? `Needed by: ${dateLabel(po.expected_date)}` : "", "Currency: MYR"].filter(Boolean).join("\n"), 360, top + 12, 9, "Body", ink, 193);
  let y = Math.max(left, pdf.y) + 22;
  const cols = [
    [42, 265, "Description", "left"],
    [307, 55, "Qty", "right"],
    [362, 80, "Rate", "right"],
    [442, 45, "SST", "right"],
    [487, 66, "Amount", "right"],
  ];
  const head = () => {
    for (const [x, w, t, a] of cols) put(t.toUpperCase(), x, y, 7, "Bold", muted, w, a);
    y += 14;
    rule(y);
    y += 6;
  };
  head();
  for (const l of po.items) {
    if (y > 700) {
      pdf.addPage();
      y = 46;
      head();
    }
    const cells = [l.description, String(l.quantity), currency(l.rate), l.tax_rate ? `${l.tax_rate}%` : "-", currency(l.amount)];
    let h = 0;
    cells.forEach((c, i) => {
      put(c, cols[i][0], y, 9, "Body", ink, cols[i][1], cols[i][3]);
      h = Math.max(h, pdf.y - y);
    });
    y += Math.max(16, h + 4);
  }
  rule(y);
  y += 8;
  for (const [label, value, bold] of [
    ["Subtotal", po.subtotal],
    ...(po.tax ? [["SST", po.tax]] : []),
    ["Total", po.total, true],
  ]) {
    put(label, 362, y, 9.5, bold ? "Bold" : "Body", bold ? ink : muted, 120, "right");
    put(currency(value), 482, y, 9.5, bold ? "Bold" : "Body", ink, 71, "right");
    y += 16;
  }
  y += 10;
  for (const [h, t] of [
    ["Terms", po.terms],
    ["Notes", po.notes],
  ])
    if (t) {
      if (y > 700) {
        pdf.addPage();
        y = 46;
      }
      put(h.toUpperCase(), 42, y, 7, "Bold", muted);
      put(t, 42, y + 12, 9, "Body", ink, 511);
      y = pdf.y + 12;
    }
  footer(pdf, put, draft ? "Draft purchase order. Not an order until issued." : `Purchase order ${po.number} issued by ${b.company || ""}.`);
  pdf.end();
  return done;
}
