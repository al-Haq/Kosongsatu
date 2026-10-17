// Monthly accountant pack: a PDF summary and CSV files for one calendar month.
// Only invoices affect money; quotations and other kinds are left out.
import PDFDocument from "pdfkit";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { currency, now } from "./domain.mjs";
import { monthRange, daysBetween, dayLabel } from "./recurring-dates.mjs";

const font = (name) => fileURLToPath(new URL(`../public/assets/fonts/${name}`, import.meta.url));
const logo = fileURLToPath(new URL("../public/assets/nawlogic-logo.png", import.meta.url));
const name = (snapshot) => {
  try {
    return JSON.parse(snapshot || "{}").name || "";
  } catch {
    return "";
  }
};
export function packData(store, month) {
  const r = monthRange(month);
  const inMonth = (v) => v >= r.from && v <= r.to;
  const docs = store.documents().filter((d) => d.kind === "invoice" && d.number);
  const invoices = docs
    .filter((d) => inMonth(d.issue_date))
    .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.number.localeCompare(b.number))
    .map((d) => ({
      number: d.number,
      issue_date: d.issue_date,
      due_date: d.due_date,
      client: d.client.name,
      client_tin: d.client.tin || "",
      subtotal: d.subtotal,
      discount: d.discount,
      tax: d.tax || 0,
      total: d.total,
      status: d.state === "void" ? "Void" : "Issued",
    }));
  const notes = store.db
    .prepare(
      "SELECT a.number,a.kind,a.amount,a.reason,a.issue_date,d.number invoice,d.client_snapshot FROM adjustments a JOIN documents d ON d.id=a.invoice_id WHERE a.issue_date BETWEEN ? AND ? ORDER BY a.issue_date,a.number",
    )
    .all(r.from, r.to)
    .map(({ client_snapshot, ...n }) => ({ ...n, client: name(client_snapshot) }));
  const receipts = store.db
    .prepare(
      "SELECT number,paid_date,method,reference,amount,client_snapshot FROM cash_receipts WHERE voided=0 AND paid_date BETWEEN ? AND ? ORDER BY paid_date,number",
    )
    .all(r.from, r.to)
    .map(({ client_snapshot, ...x }) => ({ ...x, client: name(client_snapshot) }));
  const refunds = store.db
    .prepare(
      "SELECT f.number,f.paid_date,f.reference,f.amount,f.reason,r.number receipt,r.client_snapshot FROM refunds f JOIN cash_receipts r ON r.id=f.receipt_id WHERE f.paid_date BETWEEN ? AND ? ORDER BY f.paid_date,f.number",
    )
    .all(r.from, r.to)
    .map(({ client_snapshot, ...x }) => ({ ...x, client: name(client_snapshot) }));
  // Balances as at the last day of the month, with the same rules as the statement of account.
  const aging = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  const open = [];
  for (const d of docs) {
    if (d.state !== "issued" || d.issue_date > r.to) continue;
    let balance = d.total;
    for (const a of d.adjustments || [])
      if (a.issue_date <= r.to) balance += a.kind === "debit" ? a.amount : -a.amount;
    for (const p of d.payments) if (p.paid_date <= r.to) balance -= p.applied ?? (p.reversed ? 0 : p.amount);
    if (balance <= 0) continue;
    const late = daysBetween(d.due_date, r.to);
    const bucket = late <= 0 ? "current" : late <= 30 ? "d30" : late <= 60 ? "d60" : late <= 90 ? "d90" : "over90";
    aging[bucket] += balance;
    open.push({ number: d.number, client: d.client.name, due_date: d.due_date, days_late: Math.max(0, late), balance });
  }
  open.sort((a, b) => a.due_date.localeCompare(b.due_date));
  const sst = store.sstReport({ from: r.from, to: r.to });
  const sum = (list, f = (x) => x.amount) => list.reduce((s, x) => s + f(x), 0);
  const live = invoices.filter((i) => i.status !== "Void");
  const credit = sum(notes.filter((n) => n.kind === "credit")),
    debit = sum(notes.filter((n) => n.kind === "debit"));
  const received = sum(receipts),
    refunded = sum(refunds);
  return {
    ...r,
    business: store.settings(),
    generated: now(),
    invoices,
    notes,
    receipts,
    refunds,
    aging,
    open,
    sst,
    totals: {
      invoices: live.length,
      invoiced: sum(live, (i) => i.total),
      sst: sst.tax,
      credit,
      debit,
      net_invoiced: sum(live, (i) => i.total) + debit - credit,
      received,
      refunded,
      net_cash: received - refunded,
      outstanding: sum(open, (o) => o.balance),
    },
  };
}
// Text that a spreadsheet could run as a formula is prefixed; plain numbers such
// as -100.00 (credit notes, refunds) stay numbers.
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
const myr = (sen) => (sen / 100).toFixed(2);
export function packCsv(p) {
  return {
    invoices: csv([
      ["Type", "Number", "Date", "Due date", "Client", "Client TIN", "Invoice", "Subtotal MYR", "Discount MYR", "SST MYR", "Total MYR", "Status / reason"],
      ...p.invoices.map((i) => [
        "Invoice",
        i.number,
        i.issue_date,
        i.due_date,
        i.client,
        i.client_tin,
        "",
        myr(i.subtotal),
        myr(i.discount),
        myr(i.tax),
        myr(i.total),
        i.status,
      ]),
      ...p.notes.map((n) => [
        n.kind === "credit" ? "Credit note" : "Debit note",
        n.number,
        n.issue_date,
        "",
        n.client,
        "",
        n.invoice,
        "",
        "",
        "",
        myr(n.kind === "credit" ? -n.amount : n.amount),
        n.reason,
      ]),
    ]),
    receipts: csv([
      ["Type", "Number", "Date", "Client", "Method", "Reference", "Amount MYR"],
      ...p.receipts.map((x) => ["Receipt", x.number, x.paid_date, x.client, x.method, x.reference, myr(x.amount)]),
      ...p.refunds.map((x) => ["Refund", x.number, x.paid_date, x.client, `Refund of ${x.receipt}`, x.reference, myr(-x.amount)]),
    ]),
    sst: csv([
      ["Invoice", "Issue date", "Client", "Client TIN", "SST rate %", "Taxable MYR", "SST MYR"],
      ...p.sst.rows.map((x) => [x.number, x.issue_date, x.client, x.client_tin, x.rate, myr(x.taxable), myr(x.tax)]),
      [],
      ["Rate summary"],
      ...p.sst.rates.map((x) => ["", "", "", "", x.rate, myr(x.taxable), myr(x.tax)]),
      [],
      ["Credit/debit notes in period (no SST breakdown; review manually)"],
      ...p.sst.notes.map((n) => [n.number, n.issue_date, n.invoice, "", n.kind, myr(n.amount), ""]),
    ]),
  };
}
export function renderPackPdf(p) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 42,
      bufferPages: true,
      info: { Title: `Accountant pack ${p.label}`, Author: p.business.company },
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
    const put = (v, x, y, size = 9, f = "Body", color = ink, width = 510, align = "left", extra = {}) =>
      pdf.font(f).fontSize(size).fillColor(color).text(String(v ?? ""), x, y, { width, align, lineGap: 2, ...extra });
    // Table cells stay on one line; long text is cut with an ellipsis.
    const cell = { height: 11, ellipsis: true };
    const rule = (y) => pdf.strokeColor("#E2E8F0").lineWidth(0.7).moveTo(42, y).lineTo(553, y).stroke();
    pdf.image(logo, 37, 32, { width: 150 });
    put("ACCOUNTANT PACK", 330, 46, 14, "Bold", teal, 223, "right");
    put(`${dayLabel(p.from)} – ${dayLabel(p.to)}`, 330, 68, 9, "Body", muted, 223, "right");
    const b = p.business;
    put(
      [b.company, b.registration ? `Reg: ${b.registration}` : "", b.tin ? `TIN: ${b.tin}` : "", b.sstNumber ? `SST: ${b.sstNumber}` : "", b.address]
        .filter(Boolean)
        .join("\n"),
      42,
      92,
      8,
      "Body",
      muted,
      280,
    );
    let y = Math.max(pdf.y, 120) + 10;
    const room = (h) => {
      if (y + h > 760) {
        pdf.addPage();
        y = 46;
      }
    };
    const section = (title) => {
      room(60);
      y += 8;
      put(title.toUpperCase(), 42, y, 7, "Bold", muted);
      y += 14;
    };
    const table = (cols, rows, emptyText) => {
      const header = () => {
        for (const [x, w, t, right] of cols) put(t.toUpperCase(), x, y, 7, "Bold", muted, w, right ? "right" : "left", cell);
        y += 13;
        rule(y);
        y += 5;
      };
      header();
      if (!rows.length) {
        put(emptyText, 42, y, 8.5, "Body", muted);
        y += 16;
        return;
      }
      for (const row of rows) {
        if (y > 750) {
          pdf.addPage();
          y = 46;
          header();
        }
        row.forEach((v, i) => put(v, cols[i][0], y, 8, "Body", ink, cols[i][1] - 4, cols[i][3] ? "right" : "left", cell));
        y += 15;
      }
    };
    const t = p.totals;
    section("Summary");
    const summary = [
      ["Invoices issued", `${t.invoices}`, currency(t.invoiced)],
      ["SST on invoices", "", currency(t.sst)],
      ["Credit notes", `${p.notes.filter((n) => n.kind === "credit").length}`, `−${currency(t.credit)}`],
      ["Debit notes", `${p.notes.filter((n) => n.kind === "debit").length}`, currency(t.debit)],
      ["Net invoiced", "", currency(t.net_invoiced)],
      ["Cash received", `${p.receipts.length}`, currency(t.received)],
      ["Refunds paid", `${p.refunds.length}`, `−${currency(t.refunded)}`],
      ["Net cash", "", currency(t.net_cash)],
      [`Outstanding at ${dayLabel(p.to)}`, `${p.open.length}`, currency(t.outstanding)],
    ];
    table([[42, 300, "Item"], [342, 80, "Count", true], [422, 131, "Amount", true]], summary, "");
    section("SST by rate (invoices issued in the month)");
    table(
      [[42, 200, "Rate"], [242, 150, "Taxable", true], [392, 161, "SST", true]],
      p.sst.rates.map((r) => [r.rate ? `${r.rate}%` : "No SST", currency(r.taxable), currency(r.tax)]),
      "No invoices issued in this month.",
    );
    section(`Aging at ${dayLabel(p.to)}`);
    room(40);
    [
      ["Current", p.aging.current],
      ["1–30 days", p.aging.d30],
      ["31–60 days", p.aging.d60],
      ["61–90 days", p.aging.d90],
      ["Over 90 days", p.aging.over90],
      ["Total due", t.outstanding],
    ].forEach(([label, v], i) => {
      put(label, 42 + i * 85, y, 7.5, "Body", muted, 82);
      put(currency(v), 42 + i * 85, y + 12, 9, i === 5 ? "Bold" : "Body", ink, 82);
    });
    y += 40;
    section("Invoices issued");
    table(
      [[42, 95, "Number"], [137, 70, "Date"], [207, 170, "Client"], [377, 70, "SST", true], [447, 106, "Total", true]],
      p.invoices.map((i) => [i.number, dayLabel(i.issue_date), i.client + (i.status === "Void" ? " (void)" : ""), currency(i.tax), currency(i.total)]),
      "No invoices issued in this month.",
    );
    section("Credit and debit notes");
    table(
      [[42, 95, "Number"], [137, 70, "Date"], [207, 95, "Invoice"], [302, 150, "Client"], [452, 101, "Amount", true]],
      p.notes.map((n) => [n.number, dayLabel(n.issue_date), n.invoice, n.client, (n.kind === "credit" ? "−" : "") + currency(n.amount)]),
      "No credit or debit notes in this month.",
    );
    section("Cash received and refunds");
    table(
      [[42, 95, "Number"], [137, 70, "Date"], [207, 150, "Client"], [357, 95, "Method"], [452, 101, "Amount", true]],
      [
        ...p.receipts.map((x) => [x.number, dayLabel(x.paid_date), x.client, x.method, currency(x.amount)]),
        ...p.refunds.map((x) => [x.number, dayLabel(x.paid_date), x.client, "Refund", `−${currency(x.amount)}`]),
      ],
      "No receipts or refunds in this month.",
    );
    if (p.open.length) {
      section(`Open invoices at ${dayLabel(p.to)}`);
      table(
        [[42, 95, "Number"], [137, 190, "Client"], [327, 80, "Due"], [407, 50, "Days late", true], [457, 96, "Balance", true]],
        p.open.map((o) => [o.number, o.client, dayLabel(o.due_date), String(o.days_late), currency(o.balance)]),
        "",
      );
    }
    const pages = pdf.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      pdf.switchToPage(i);
      // One line each, inside the bottom margin, so the footer never adds a page.
      put(
        `Prepared from this workspace on ${p.generated.slice(0, 10)}. Check with your accountant before filing.`,
        42,
        782,
        7,
        "Body",
        muted,
        440,
        "left",
        { lineBreak: false },
      );
      put(`${i + 1} / ${pages.count}`, 511, 782, 7, "Body", muted, 42, "right", { lineBreak: false });
    }
    pdf.end();
  });
}
export async function packFiles(p) {
  const files = packCsv(p);
  return [
    { name: `accountant-pack-${p.month}.pdf`, data: await renderPackPdf(p), type: "application/pdf" },
    { name: `invoices-${p.month}.csv`, data: Buffer.from(files.invoices), type: "text/csv" },
    { name: `receipts-${p.month}.csv`, data: Buffer.from(files.receipts), type: "text/csv" },
    { name: `sst-${p.month}.csv`, data: Buffer.from(files.sst), type: "text/csv" },
  ];
}
// A plain (stored, uncompressed) ZIP archive, so the pack downloads as one file.
export function zip(files, when = new Date()) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const day = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [],
    central = [];
  let offset = 0;
  for (const f of files) {
    const fileName = Buffer.from(f.name, "utf8"),
      data = Buffer.from(f.data),
      crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, fileName, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
