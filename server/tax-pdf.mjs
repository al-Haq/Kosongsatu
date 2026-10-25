// PDFs owned by the tax module: the SST-02 working paper and self-billed e-Invoices.
import PDFDocument from "pdfkit";
import { currency } from "./domain.mjs";
import { registerTextFonts, textFont } from "./documents-fonts.mjs";
import { drawQr } from "./qr.mjs";
import { STATE_CODES, EINVOICE_TYPES } from "./tax-codes.mjs";

import { drawLogoImage } from "./pdf-logo.mjs";
const ink = "#0F172A",
  teal = "#087F7E",
  muted = "#64748B",
  line = "#E2E8F0";

function page(title, subtitle, footer, logo = null) {
  const pdf = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: title } });
  registerTextFonts(pdf);
  const chunks = [];
  pdf.on("data", (c) => chunks.push(c));
  const done = new Promise((ok, fail) => {
    pdf.on("end", () => ok(Buffer.concat(chunks)));
    pdf.on("error", fail);
  });
  const t = {
    pdf,
    y: 42,
    text(value, x, y, size = 10, f = "Body", color = ink, width = 511, align = "left") {
      pdf.font(textFont(f, value)).fontSize(size).fillColor(color).text(String(value ?? ""), x, y, { width, lineGap: 2, align });
      return pdf.y;
    },
    rule(y) {
      pdf.strokeColor(line).lineWidth(0.7).moveTo(42, y).lineTo(553, y).stroke();
    },
    room(h) {
      if (t.y + h > 760) {
        pdf.addPage();
        t.y = 46;
      }
    },
    finish() {
      const pages = pdf.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        pdf.switchToPage(i);
        t.rule(778);
        t.text(footer, 42, 788, 7, "Body", muted, 450);
        t.text(`${i + 1} / ${pages.count}`, 511, 788, 7, "Body", muted, 42);
      }
      pdf.end();
      return done;
    },
  };
  drawLogoImage(pdf, logo, 37, 32, 150);
  t.text(title, 300, 46, 15, "Bold", ink, 253, "right");
  t.text(subtitle, 300, 70, 9, "Body", muted, 253, "right");
  t.y = 112;
  return t;
}
// A two-column table with optional bold total rows.
function table(t, head, rows, widths) {
  const x0 = 42;
  const draw = (cells, f, color, fill) => {
    const heights = cells.map((c, i) => {
      t.pdf.font(textFont(f, c)).fontSize(9);
      // Measured with the same line gap the text is drawn with.
      return t.pdf.heightOfString(String(c ?? ""), { width: widths[i] - 8, lineGap: 2 });
    });
    const h = Math.max(...heights) + 10;
    t.room(h + 4);
    if (fill) t.pdf.rect(x0, t.y, 511, h).fill(fill);
    let x = x0;
    cells.forEach((c, i) => {
      t.text(c, x + 4, t.y + 5, 9, f, color, widths[i] - 8, i > 0 && typeof c === "string" && /^-?RM|^-?[\d,.]+$/.test(c) ? "right" : "left");
      x += widths[i];
    });
    t.y += h;
    t.rule(t.y);
  };
  draw(head, "Bold", muted, "#F4F7FA");
  for (const r of rows) draw(r.cells || r, r.bold ? "Bold" : "Body", r.bold ? ink : ink, r.fill);
  t.y += 10;
}
const rm = (sen) => currency(sen);

export function renderSst02Pdf(ws, logo = null) {
  const p = ws.period;
  const t = page(
    "SST-02 WORKING PAPER",
    `Taxable period ${p.from} to ${p.to}\nReturn and payment due ${p.due}`,
    "Kosongsatu | SST-02 working paper | Not a submission: file and pay on MySST (mysst.customs.gov.my)",
    logo,
  );
  t.pdf.roundedRect(42, t.y, 511, 46, 6).fill("#FFF4E8");
  t.text(
    "Working aid only. Copy these figures into the SST-02 return on MySST and check them with your adviser. Nothing has been sent to the Royal Malaysian Customs Department.",
    54,
    t.y + 9,
    9,
    "Body",
    "#9A4600",
    487,
  );
  t.y += 60;
  t.text("PART A  Registered person", 42, t.y, 10, "Bold");
  t.y += 18;
  table(t, ["Item", "Value"], [
    ["SST registration number", ws.sstNumber || "Not set"],
    ["Name", ws.business],
    ["Taxable period", `${p.from} to ${p.to} (${p.months} month${p.months > 1 ? "s" : ""})`],
    ["Return and payment due", p.due],
    ["Sales tax counted on", "Invoice date (time of sale)"],
    ["Service tax counted on", ws.basis.service === "payment" ? "Payment received (12-month rule applied)" : "Invoice date (approved accrual basis)"],
  ], [200, 311]);
  t.text("PART B2  Value and tax by rate", 42, t.y, 10, "Bold");
  t.y += 18;
  const box = (k, label) => [k, label, rm(ws.items[k].value), rm(ws.items[k].tax)];
  table(t, ["Item", "Description", "Taxable value", "Tax"], [
    box("11a", "Sales tax 5%"),
    box("11b", "Sales tax 10%"),
    box("11c", "Service tax 6%"),
    box("11d", "Service tax 8%"),
    ["11e", "Credit / charge card services (RM25 per card) - not tracked here", rm(0), rm(0)],
    { cells: ["12", "Total tax", "", rm(ws.item12)], bold: true },
  ], [50, 251, 110, 100]);
  t.text("Deductions and tax payable", 42, t.y, 10, "Bold");
  t.y += 18;
  table(t, ["Item", "Description", "Amount"], [
    ["13(a)", `Tax deduction from credit notes (credit value ${rm(ws.creditValue.sales + ws.creditValue.service)})`, rm(ws.deductions.a)],
    ["13(b)", "Approved sales tax deduction - enter on MySST if any", rm(0)],
    ["13(c)", "Approved service tax deduction - enter on MySST if any", rm(0)],
    ["13(d)", "Bad debt relief - only after approval", rm(0)],
    { cells: ["14", "Total tax payable (12 - 13), before any penalty", rm(ws.item14)], bold: true },
  ], [50, 361, 100]);
  t.text("PART D  Exempt and non-taxable sales", 42, t.y, 10, "Bold");
  t.y += 18;
  table(t, ["Item", "Description", "Value"], [
    ["18", "Sales to customers with an SST exemption", rm(ws.partD.exempt)],
    ["18", "Other sales without SST", rm(ws.partD.other)],
  ], [50, 361, 100]);
  if (ws.warnings.length) {
    t.room(40);
    t.text("Check before filing", 42, t.y, 10, "Bold");
    t.y += 16;
    for (const w of ws.warnings) {
      t.room(28);
      t.y = t.text("• " + w, 42, t.y, 9, "Body", muted) + 4;
    }
    t.y += 8;
  }
  t.room(60);
  t.text("Documents in this period", 42, t.y, 10, "Bold");
  t.y += 18;
  table(
    t,
    ["Item", "Date", "Document", "Client", "Rate", "Value", "Tax"],
    ws.rows.map((r) => [r.item, r.date, `${r.number}\n${r.kind}`, r.client, r.rate ? r.rate + "%" : "0%", rm(r.value), rm(r.tax)]),
    [36, 62, 92, 131, 36, 80, 74],
  );
  t.text(`Prepared ${ws.generated.slice(0, 16).replace("T", " ")} UTC by Kosongsatu.`, 42, t.y, 8, "Body", muted);
  return t.finish();
}

export function renderSelfBilledPdf(sb, business, einvoice, logo = null) {
  const seller = JSON.parse(sb.supplier);
  const lines = JSON.parse(sb.lines);
  const t = page(
    (EINVOICE_TYPES[sb.type_code] || "Self-billed e-Invoice").toUpperCase(),
    `${sb.number}\nIssued ${sb.issue_date}`,
    einvoice?.state === "valid"
      ? `Kosongsatu | Self-billed e-Invoice validated by LHDN MyInvois | UUID ${einvoice.uuid}`
      : "Kosongsatu | Self-billed document | Not yet a validated MyInvois e-Invoice",
    logo,
  );
  const address = (a) => [...a.lines, [a.postcode, a.city].filter(Boolean).join(" "), STATE_CODES[a.state] && a.state !== "17" ? STATE_CODES[a.state] : "", a.country].filter(Boolean).join("\n");
  t.text("SUPPLIER (SELLER)", 42, t.y, 9, "Bold", muted, 250);
  t.text("BUYER (ISSUER OF THIS SELF-BILLED E-INVOICE)", 310, t.y, 9, "Bold", muted, 243);
  t.y += 16;
  const left = t.text(`${seller.name}\nTIN: ${seller.tin}\n${seller.idType}: ${seller.idValue}\n${address(seller.address)}\n${seller.phone}${seller.email ? "\n" + seller.email : ""}`, 42, t.y, 9, "Body", ink, 250);
  const right = t.text(`${business.company}\nTIN: ${business.tin || "-"}\nReg: ${business.registration || "-"}${business.sstNumber ? "\nSST: " + business.sstNumber : ""}\n${business.address || ""}`, 310, t.y, 9, "Body", ink, 243);
  t.y = Math.max(left, right) + 18;
  table(
    t,
    ["Description", "Class", "Qty", "Unit price", "SST", "Amount"],
    lines.map((l) => [l.description, l.class, String(l.quantity), rm(l.rate), l.tax_rate ? `${l.tax_rate}% ${rm(l.tax)}` : "-", rm(l.amount + l.tax)]),
    [190, 45, 40, 80, 76, 80],
  );
  table(t, ["", "Amount"], [
    ["Subtotal", rm(sb.subtotal)],
    ["Tax", rm(sb.tax)],
    { cells: [`Total (${sb.currency})`, rm(sb.total)], bold: true },
  ], [411, 100]);
  if (sb.notes) {
    t.room(40);
    t.text("Notes", 42, t.y, 10, "Bold");
    t.y = t.text(sb.notes, 42, t.y + 16, 9, "Body", muted) + 10;
  }
  if (einvoice?.state === "valid" && einvoice.url) {
    t.room(120);
    drawQr(t.pdf, einvoice.url, 42, t.y, 90);
    t.text(`Validated by LHDN MyInvois\nUUID: ${einvoice.uuid}\nValidated: ${einvoice.validated_at}\n${einvoice.url}`, 148, t.y + 6, 9, "Body", teal, 405);
    t.y += 100;
  }
  return t.finish();
}
