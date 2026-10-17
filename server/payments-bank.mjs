// Bank statement CSV import for Malaysian bank exports and any other layout.
// Banks change their export layouts without notice, so nothing here depends on
// one exact file: the header row and columns are found by common names
// (English and Malay), the owner can adjust the mapping, and a mapping can be
// saved as a preset. Parsed rows go through the normal import path
// (store.importBankRows), which skips duplicates and never records income.
import { check, date as isoDate } from "./domain.mjs";
import { bankRowKey } from "./banking.mjs";
export const MAX_CHARS = 400000;
export const MAX_ROWS = 3000;
// Typical layouts seen in exports from each bank's internet banking. They are
// starting points: detection reads the actual header row of your file.
export const BANK_LAYOUTS = [
  { id: "auto", name: "Detect automatically", note: "Finds the header row, date, description, reference and amount columns by name.", dateFormat: "DMY" },
  { id: "maybank", name: "Maybank2u / M2U Biz", note: "Usually: entry date, transaction description, transaction amount with a trailing + (in) or - (out), statement balance.", dateFormat: "DMY" },
  { id: "cimb", name: "CIMB Clicks / BizChannel", note: "Usually: date, description, cheque / ref no, withdrawal (debit), deposit (credit), balance.", dateFormat: "DMY" },
  { id: "publicbank", name: "Public Bank (PBe)", note: "Usually: date, transaction, debit, credit, balance; a few account lines above the header.", dateFormat: "DMY" },
  { id: "rhb", name: "RHB Online Banking", note: "Usually: date, description, reference, debit, credit, balance.", dateFormat: "DMY" },
  { id: "hongleong", name: "Hong Leong Connect", note: "Usually: date, description, withdrawal, deposit, balance; dates may use month names (05-Oct-2026).", dateFormat: "DMONY" },
  { id: "bankislam", name: "Bank Islam (GO / BIMB Biz)", note: "Usually: date, description, reference, debit, credit, balance.", dateFormat: "DMY" },
  { id: "normalized", name: "Kosongsatu normalized CSV", note: "date,reference,amount,description,transaction_id with YYYY-MM-DD dates and signed amounts.", dateFormat: "YMD" },
];
export const DATE_FORMATS = [
  { id: "DMY", label: "DD/MM/YYYY (also DD-MM-YY, DD.MM.YYYY)" },
  { id: "DMONY", label: "DD MMM YYYY (05 Oct 2026, 05-OCT-26)" },
  { id: "YMD", label: "YYYY-MM-DD" },
  { id: "MDY", label: "MM/DD/YYYY (month first)" },
];
const ALIASES = {
  date: ["transaction date", "txn date", "trans date", "trx date", "posting date", "post date", "entry date", "date", "value date", "tarikh", "tarikh transaksi", "tarikh urus niaga"],
  description: ["transaction description", "description", "description 1", "transaction details", "details", "particulars", "narrative", "transaction", "keterangan", "butiran", "remarks", "transaction type"],
  reference: ["reference", "reference no", "reference number", "ref no", "ref", "cheque ref no", "cheque no ref no", "cheque no", "chq no", "chq ref no", "description 2", "reference 1", "reference 2", "other details", "payment details", "recipient reference", "rujukan", "no rujukan"],
  transactionId: ["transaction id", "transaction reference no", "txn id", "trace no", "sequence no", "seq no", "id"],
  amount: ["transaction amount", "amount", "amount rm", "amount myr", "amt", "amaun", "jumlah"],
  debit: ["debit", "debit amount", "debit rm", "debit myr", "withdrawal", "withdrawals", "withdrawal rm", "withdrawal amount", "money out", "dr", "out", "pengeluaran", "keluar"],
  credit: ["credit", "credit amount", "credit rm", "credit myr", "deposit", "deposits", "deposit rm", "deposit amount", "money in", "cr", "in", "simpanan", "masuk"],
  indicator: ["dr cr", "cr dr", "debit credit", "credit debit", "d c", "type dr cr", "indicator"],
};
const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// RFC 4180 CSV with any one-character delimiter. Blank lines are dropped.
export function splitCsv(csv, delimiter = ",") {
  check(typeof csv === "string" && csv.length <= MAX_CHARS, "The statement is too large. Import up to about 3,000 rows (400 KB) at a time.");
  check([",", ";", "\t", "|"].includes(delimiter), "Choose a comma, semicolon, tab or | delimiter.");
  csv = csv.replace(/^﻿/, "");
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted) quoted = false;
      else if (cell.trim() === "") {
        cell = "";
        quoted = true;
      } else cell += c;
    } else if (c === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
      check(rows.length <= MAX_ROWS + 60, "The statement has too many rows. Import up to 3,000 rows at a time.");
    } else cell += c;
  }
  check(!quoted, "A quoted value in the CSV is not closed.");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows.map((r) => r.map((v) => v.trim()));
}
export function detectDelimiter(csv) {
  const head = String(csv || "").slice(0, 20000);
  let best = ",",
    bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    let rows;
    try {
      rows = splitCsv(head.slice(0, head.lastIndexOf("\n") > 0 ? head.lastIndexOf("\n") : head.length), d).slice(0, 40);
    } catch {
      continue;
    }
    const counts = new Map();
    for (const r of rows) if (r.length > 1) counts.set(r.length, (counts.get(r.length) || 0) + 1);
    const [width, n] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [1, 0];
    const score = n * 10 + Math.min(width, 9);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, MAC: 3, APR: 4, MAY: 5, MEI: 5, JUN: 6, JUL: 7, AUG: 8, OGO: 8, SEP: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DIS: 12 };
const year = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
// Returns YYYY-MM-DD or null. Times after the date are ignored.
export function parseDate(value, format) {
  let s = String(value ?? "").trim().replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?.*$/i, "").trim();
  if (!s) return null;
  let d, m, y, x;
  if (format === "DMY" && (x = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4}|\d{2})$/))) [d, m, y] = [x[1], x[2], year(x[3])];
  else if (format === "MDY" && (x = s.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4}|\d{2})$/))) [m, d, y] = [x[1], x[2], year(x[3])];
  else if (format === "YMD" && (x = s.match(/^(\d{4})[/\-. ]?(\d{1,2})[/\-. ]?(\d{1,2})$/))) [y, m, d] = [Number(x[1]), x[2], x[3]];
  else if (format === "DMONY" && (x = s.match(/^(\d{1,2})[/\-. ]?([A-Za-z]{3,9})[/\-., ]*(\d{4}|\d{2})$/))) {
    m = MONTHS[x[2].slice(0, 3).toUpperCase()];
    if (!m) return null;
    [d, y] = [x[1], year(x[3])];
  } else return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  try {
    return isoDate(iso);
  } catch {
    return null;
  }
}
export function detectDateFormat(values, preferred = "DMY") {
  const order = [...new Set([preferred, "DMY", "YMD", "DMONY", "MDY"])];
  const sample = values.filter((v) => String(v || "").trim()).slice(0, 60);
  let best = preferred,
    bestCount = 0;
  for (const f of order) {
    const n = sample.filter((v) => parseDate(v, f)).length;
    if (n > bestCount) [best, bestCount] = [f, n];
  }
  return best;
}
// Parses one money cell. Understands 1,234.56 / 1.234,56 / RM / MYR /
// (1,234.56) / -1,234.56 / 1,234.56- / 1,234.56+ / 1,234.56 CR / DR 50.00.
// Returns null for an empty cell, else { sen, sign } where sign is -1, 0 or 1.
export function parseAmount(raw, { thousands = ",", decimal = "." } = {}) {
  let s = String(raw ?? "").trim();
  if (!s || s === "-" || s === "–") return null;
  let sign = 0;
  const flag = s.match(/^(CR|DR)\.?\s*(?=[\d(+-]|RM|MYR)|\s*(CR|DR)\.?$/i);
  if (flag) {
    sign = (flag[1] || flag[2]).toUpperCase() === "CR" ? 1 : -1;
    s = s.replace(flag[0], "").trim();
  }
  s = s.replace(/^(RM|MYR)\s*/i, "").replace(/\s*(RM|MYR)$/i, "").trim();
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  if (/[+-]$/.test(s)) {
    sign = s.endsWith("-") ? -1 : 1;
    s = s.slice(0, -1).trim();
  }
  if (/^[+-]/.test(s)) {
    sign = s[0] === "-" ? -1 : 1;
    s = s.slice(1).trim();
  }
  s = s.replace(/^(RM|MYR)\s*/i, "").replace(/\s/g, "");
  if (thousands) s = s.split(thousands).join("");
  if (decimal !== ".") s = s.replace(decimal, ".");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) throw new Error(`"${String(raw).slice(0, 30)}" is not an amount`);
  const [a, b = ""] = s.split(".");
  return { sen: Number(a) * 100 + Number(b.padEnd(2, "0")), sign };
}
function findHeader(rows) {
  const has = (cells, key) => cells.some((c) => ALIASES[key].includes(c));
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map(norm);
    if (has(cells, "date") && (has(cells, "amount") || has(cells, "debit") || has(cells, "credit"))) return i;
  }
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map(norm);
    if (cells.some((c) => /\b(date|tarikh)\b/.test(c)) && cells.some((c) => /\b(amount|debit|credit|withdrawal|deposit|amaun)\b/.test(c))) return i;
  }
  return -1;
}
// A best guess at the column mapping for this file; the owner can change it.
export function autoMapping(rows, { layout = "auto", delimiter = "," } = {}) {
  const preset = BANK_LAYOUTS.find((l) => l.id === layout) || BANK_LAYOUTS[0];
  const headerRow = findHeader(rows);
  const h = headerRow >= 0 ? rows[headerRow].map(norm) : [];
  const used = new Set();
  const find = (key, loose) => {
    for (const a of ALIASES[key]) {
      const i = h.findIndex((c, idx) => c === a && !used.has(idx));
      if (i >= 0) return used.add(i), i;
    }
    if (loose) {
      const i = h.findIndex((c, idx) => !used.has(idx) && new RegExp(`\\b(${loose})\\b`).test(c));
      if (i >= 0) return used.add(i), i;
    }
    return -1;
  };
  const date = find("date", "date|tarikh");
  const indicator = find("indicator");
  const debit = find("debit", "debit|withdrawal|withdrawals");
  const credit = find("credit", "credit|deposit|deposits");
  const amount = find("amount", "amount|amaun");
  const transactionId = find("transactionId");
  const all = (key, loose) => {
    const out = [];
    for (let i; (i = find(key, loose)) >= 0; ) out.push(i);
    return out.sort((a, b) => a - b);
  };
  const reference = all("reference", "reference|ref|cheque|rujukan");
  const description = all("description", "description|details|particulars|keterangan");
  const amountMode = debit >= 0 && credit >= 0 ? "split" : amount >= 0 && indicator >= 0 ? "indicator" : "signed";
  const body = rows.slice(headerRow + 1);
  const dateFormat = date >= 0 ? detectDateFormat(body.map((r) => r[date]), preset.dateFormat) : preset.dateFormat;
  // 1.234,56 style amounts use a decimal comma.
  const money = body.slice(0, 60).flatMap((r) => [r[amount], r[debit], r[credit]]).filter((v) => v && /\d/.test(v));
  const comma = money.length && money.every((v) => /^[^,]*\d,\d{2}\b/.test(v) && !/\.\d{2}\b/.test(v.replace(/\.\d{3}/g, "")));
  return {
    delimiter,
    headerRow,
    date,
    dateFormat,
    description,
    reference,
    transactionId: transactionId >= 0 ? transactionId : null,
    amountMode,
    amount: amount >= 0 ? amount : null,
    debit: debit >= 0 ? debit : null,
    credit: credit >= 0 ? credit : null,
    indicator: indicator >= 0 ? indicator : null,
    thousands: comma ? "." : ",",
    decimal: comma ? "," : ".",
  };
}
// Checks a mapping that came from the browser against the file's width.
export function cleanMapping(m, width) {
  check(m && typeof m === "object", "Choose how the columns are mapped.");
  const col = (v, name, required = false) => {
    if (v === null || v === undefined || v === "" || v === -1) {
      check(!required, `Choose the ${name} column.`);
      return null;
    }
    const n = Number(v);
    check(Number.isInteger(n) && n >= 0 && n < width, `The ${name} column is not in this file.`);
    return n;
  };
  const cols = (v, name) => (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]).slice(0, 6).map((x) => col(x, name)).filter((x) => x !== null);
  const amountMode = ["signed", "split", "indicator"].includes(m.amountMode) ? m.amountMode : "signed";
  const out = {
    delimiter: [",", ";", "\t", "|"].includes(m.delimiter) ? m.delimiter : ",",
    headerRow: Number.isInteger(Number(m.headerRow)) && Number(m.headerRow) >= -1 && Number(m.headerRow) < 60 ? Number(m.headerRow) : -1,
    date: col(m.date, "date", true),
    dateFormat: DATE_FORMATS.some((f) => f.id === m.dateFormat) ? m.dateFormat : "DMY",
    description: cols(m.description, "description"),
    reference: cols(m.reference, "reference"),
    transactionId: col(m.transactionId, "transaction ID"),
    amountMode,
    amount: col(m.amount, "amount", amountMode !== "split"),
    debit: col(m.debit, "debit", amountMode === "split"),
    credit: col(m.credit, "credit", amountMode === "split"),
    indicator: col(m.indicator, "DR/CR", amountMode === "indicator"),
    thousands: [",", ".", " ", "'", ""].includes(m.thousands) ? m.thousands : ",",
    decimal: [".", ","].includes(m.decimal) ? m.decimal : ".",
  };
  check(out.thousands !== out.decimal, "The thousands separator and decimal mark must differ.");
  check(out.description.length || out.reference.length, "Choose a description or reference column.");
  return out;
}
const SUMMARY = /\b(opening|closing|balance|baki|total|jumlah|b\/f|c\/f|brought forward|carried forward|beginning|ending)\b/i;
// Turns statement text into rows for store.importBankRows.
// Returns { rows, errors: [{ row, message, text }], skipped }.
export function parseStatement(csv, mapping, account = "MAIN") {
  check(typeof account === "string" && account.trim().length > 0 && account.length <= 80, "Enter an account label.");
  account = account.trim().toUpperCase();
  const all = splitCsv(csv, mapping.delimiter);
  const width = Math.max(0, ...all.map((r) => r.length));
  const m = cleanMapping(mapping, width);
  const money = { thousands: m.thousands, decimal: m.decimal };
  const rows = [],
    errors = [];
  let skipped = 0,
    last = null;
  const cell = (r, i) => (i === null || i === undefined ? "" : r[i] || "");
  const join = (r, list) =>
    list
      .map((i) => cell(r, i).replace(/\s+/g, " "))
      .filter(Boolean)
      .join(" / ");
  for (let i = m.headerRow + 1; i < all.length; i++) {
    const r = all[i];
    const fail = (message) => errors.push({ row: i + 1, message, text: r.join(" | ").slice(0, 160) });
    const rawDate = cell(r, m.date);
    const desc = join(r, m.description),
      ref = join(r, m.reference);
    let amount;
    try {
      if (m.amountMode === "split") {
        const dr = parseAmount(cell(r, m.debit), money),
          cr = parseAmount(cell(r, m.credit), money);
        if (dr?.sen && cr?.sen) {
          fail("Both debit and credit have an amount.");
          continue;
        }
        amount = cr?.sen ? cr.sen : dr?.sen ? -dr.sen : dr || cr ? 0 : null;
      } else {
        const a = parseAmount(cell(r, m.amount), money);
        if (a === null) amount = null;
        else if (m.amountMode === "indicator") {
          const ind = cell(r, m.indicator).toUpperCase();
          const sign = /^(CR|C|CREDIT|K|IN|\+)/.test(ind) ? 1 : /^(DR|D|DEBIT|OUT|-)/.test(ind) ? -1 : a.sign;
          if (!sign) {
            fail(`Unknown DR/CR value "${ind.slice(0, 10)}".`);
            continue;
          }
          amount = sign * a.sen;
        } else amount = a.sign < 0 ? -a.sen : a.sen;
      }
    } catch (e) {
      fail(e.message + ".");
      continue;
    }
    // Opening/closing balance and total lines carry no transaction.
    if (!rawDate && amount === null && SUMMARY.test(desc + " " + ref)) {
      skipped++;
      last = null;
      continue;
    }
    // A wrapped description line belongs to the transaction above it.
    if (!rawDate && amount === null && (desc || ref) && last) {
      last.description = [last.description, desc, ref].filter(Boolean).join(" ").slice(0, 500);
      continue;
    }
    const txn_date = parseDate(rawDate, m.dateFormat);
    if (!txn_date) {
      if (!rawDate || SUMMARY.test(r.join(" "))) skipped++;
      else fail(`"${rawDate.slice(0, 20)}" is not a date in the chosen format.`);
      last = null;
      continue;
    }
    if (!amount) {
      // Balance lines and zero rows carry no money.
      skipped++;
      last = null;
      continue;
    }
    const reference = (ref || desc).slice(0, 120);
    if (!reference) {
      fail("The row has no description or reference.");
      continue;
    }
    last = {
      row: i + 1,
      account,
      txn_date,
      reference,
      description: (ref ? desc : desc.length > 120 ? desc : "").slice(0, 500),
      amount,
      source_id: cell(r, m.transactionId).slice(0, 160),
    };
    rows.push(last);
  }
  check(rows.length + errors.length <= MAX_ROWS, "The statement has too many rows. Import up to 3,000 rows at a time.");
  // Identical rows within one statement are distinct transfers; number them so
  // both import, while importing the same file again still finds duplicates.
  const seen = new Map();
  for (const row of rows) {
    const base = bankRowKey(account, row);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    row.dedupe_key = bankRowKey(account, row, n);
  }
  return { rows, errors, skipped, width, mapping: m };
}
// Saved presets keep column names, so a re-ordered export still maps.
export function presetToMapping(preset, rows) {
  const p = preset.mapping;
  const names = p.names || {};
  const wanted = Object.values(names).flat().filter(Boolean).map(norm);
  let headerRow = p.headerRow ?? -1;
  if (wanted.length) {
    const found = rows.slice(0, 60).findIndex((r) => wanted.every((w) => r.map(norm).includes(w)));
    check(found >= 0, `This file does not match the "${preset.name}" layout. Check the columns below.`);
    headerRow = found;
  }
  const header = headerRow >= 0 ? rows[headerRow].map(norm) : [];
  const at = (n, fallback) => (n ? header.indexOf(norm(n)) : fallback ?? null);
  const many = (list, fallback) => (list?.length ? list.map((n) => header.indexOf(norm(n))).filter((i) => i >= 0) : fallback || []);
  return {
    ...p,
    headerRow,
    date: at(names.date, p.date),
    description: many(names.description, p.description),
    reference: many(names.reference, p.reference),
    transactionId: names.transactionId ? at(names.transactionId) : p.transactionId ?? null,
    amount: names.amount ? at(names.amount) : p.amount ?? null,
    debit: names.debit ? at(names.debit) : p.debit ?? null,
    credit: names.credit ? at(names.credit) : p.credit ?? null,
    indicator: names.indicator ? at(names.indicator) : p.indicator ?? null,
  };
}
// The column names behind a mapping, for saving it as a preset.
export function mappingNames(m, rows) {
  const header = m.headerRow >= 0 ? rows[m.headerRow] || [] : [];
  const name = (i) => (i === null || i === undefined || !header[i] ? null : header[i]);
  if (!header.length) return {};
  return {
    date: name(m.date),
    description: m.description.map(name).filter(Boolean),
    reference: m.reference.map(name).filter(Boolean),
    transactionId: name(m.transactionId),
    amount: name(m.amount),
    debit: name(m.debit),
    credit: name(m.credit),
    indicator: name(m.indicator),
  };
}
