import { id, hash, now, check, text, date, money } from "./domain.mjs";
export function parseBankCsv(csv, account = "MAIN") {
  check(
    typeof csv === "string" && csv.length < 110000,
    "CSV is too large. Import up to 500 rows at a time.",
  );
  account = text(account, 80, true).toUpperCase();
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  csv = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        check(quoted || cell === "", "Malformed CSV quoting.");
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  check(!quoted, "CSV quote is not closed.");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  check(
    rows.length >= 2 && rows.length <= 501,
    "CSV needs a header and 1 to 500 rows.",
  );
  const headers = rows.shift().map((v) => v.trim().toLowerCase());
  for (const h of ["date", "reference", "amount"])
    check(headers.includes(h), `CSV header must include ${h}.`);
  check(new Set(headers).size === headers.length, "Duplicate CSV column.");
  return rows.map((r, index) => {
    check(
      r.length === headers.length,
      `CSV row ${index + 2} has the wrong column count.`,
    );
    const data = Object.fromEntries(headers.map((h, j) => [h, r[j].trim()]));
    const raw = data.amount;
    check(
      /^-?\d{1,8}(\.\d{1,2})?$/.test(raw),
      `CSV row ${index + 2}: amount must be signed MYR with no thousands separator.`,
    );
    const amount =
      money(raw.replace(/^-/, " ").trim()) * (raw.startsWith("-") ? -1 : 1);
    check(amount !== 0, "Zero bank amounts are not supported.");
    const txn_date = date(data.date),
      reference = text(data.reference, 120, true),
      description = text(data.description || "", 500),
      source_id = text(data.transaction_id || "", 160);
    const dedupe_key = bankRowKey(account, { source_id, txn_date, reference, amount, description });
    return { account, txn_date, reference, description, amount, dedupe_key };
  });
}
// Duplicate key for a statement row. The bank's own transaction id wins; else
// date, reference, amount and description. `n` counts identical rows within one
// statement (two equal transfers on one day), so re-imports still dedupe.
export const bankRowKey = (account, r, n = 0) =>
  hash(
    JSON.stringify([
      account,
      r.source_id || [r.txn_date, r.reference, r.amount, r.description],
      ...(n ? [n] : []),
    ]),
  );
export function attachBanking(Store) {
  Object.assign(Store.prototype, {
    previewBank(b) {
      return this.previewBankRows(parseBankCsv(b.csv, b.account || "MAIN"));
    },
    // Marks rows already imported (or repeated in this batch) as duplicates.
    previewBankRows(rows) {
      const seen = new Set();
      return rows.map((r) => {
        const duplicate =
          seen.has(r.dedupe_key) ||
          !!this.db
            .prepare("SELECT id FROM bank_transactions WHERE dedupe_key=?")
            .get(r.dedupe_key);
        seen.add(r.dedupe_key);
        return { ...r, duplicate };
      });
    },
    importBank(b) {
      return this.tx(() => this.importBankRows(this.previewBank(b)));
    },
    // The one import path for parsed statement rows; import never records income.
    importBankRows(parsed, note = "") {
      return this.tx(() => {
        const rows = this.previewBankRows(parsed);
        let inserted = 0;
        for (const r of rows) {
          if (r.duplicate) continue;
          this.db
            .prepare(
              "INSERT INTO bank_transactions(id,account,txn_date,reference,description,amount,dedupe_key,created) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              id(),
              r.account,
              r.txn_date,
              r.reference,
              r.description,
              r.amount,
              r.dedupe_key,
              now(),
            );
          inserted++;
        }
        this.audit(
          "bank.csv.imported",
          null,
          `${inserted} imported, ${rows.length - inserted} duplicates skipped.${note ? " " + note : ""}`,
        );
        return { inserted, skipped: rows.length - inserted };
      });
    },
    recordBankReceipt(tid, b) {
      return this.tx(() => {
        const t = this.db
          .prepare("SELECT * FROM bank_transactions WHERE id=?")
          .get(tid);
        check(
          t &&
            t.amount > 0 &&
            !t.receipt_id &&
            !t.refund_id &&
            !t.ignored_reason,
          "Choose an unmatched bank credit.",
        );
        const r = this.receive({
          ...b,
          account: t.account,
          amount: (t.amount / 100).toFixed(2),
          paid_date: t.txn_date,
          method: "Bank transfer",
          reference: t.reference,
        });
        this.matchBank(tid, { kind: "receipt", target_id: r.id });
        return r;
      });
    },
    matchBank(tid, b) {
      return this.tx(() => {
        const t = this.db
          .prepare("SELECT * FROM bank_transactions WHERE id=?")
          .get(tid);
        check(t, "Bank transaction not found.", 404);
        check(
          !t.receipt_id && !t.refund_id && !t.ignored_reason,
          "Unmatch/reset this transaction before changing its match.",
        );
        const type = b.kind || "receipt";
        let target;
        if (type === "receipt") {
          target = this.receipt(b.target_id);
          check(
            !target.voided &&
              !target.legacy_review &&
              target.method === "Bank transfer",
            "Choose a verified bank-transfer receipt.",
          );
          check(
            t.amount === target.amount,
            "Bank and receipt amounts do not match.",
          );
        } else {
          check(type === "refund", "Invalid match type.");
          target = this.db
            .prepare("SELECT * FROM refunds WHERE id=?")
            .get(b.target_id);
          check(target, "Refund not found.", 404);
          check(
            t.amount === -target.amount,
            "Bank debit and refund amounts do not match.",
          );
          target = {
            ...target,
            account: this.receipt(target.receipt_id).account,
          };
        }
        check(
          t.account === target.account.toUpperCase(),
          "Bank account does not match.",
        );
        const col = type === "receipt" ? "receipt_id" : "refund_id";
        check(
          !this.db
            .prepare(`SELECT id FROM bank_transactions WHERE ${col}=?`)
            .get(b.target_id),
          "This receipt/refund is already matched.",
        );
        this.db
          .prepare(`UPDATE bank_transactions SET ${col}=? WHERE id=?`)
          .run(b.target_id, tid);
        this.audit("bank.transaction.matched", tid, type, null, {
          target_id: b.target_id,
          amount: t.amount,
        });
        return { ok: true };
      });
    },
    resetBank(tid, reason) {
      reason = text(reason, 500, true);
      check(
        this.db.prepare("SELECT id FROM bank_transactions WHERE id=?").get(tid),
        "Bank transaction not found.",
        404,
      );
      this.db
        .prepare(
          "UPDATE bank_transactions SET receipt_id=NULL,refund_id=NULL,ignored_reason=NULL WHERE id=?",
        )
        .run(tid);
      this.audit("bank.transaction.unmatched", tid, reason);
    },
    ignoreBank(tid, reason) {
      const t = this.db
        .prepare("SELECT * FROM bank_transactions WHERE id=?")
        .get(tid);
      check(
        t && !t.receipt_id && !t.refund_id,
        "Only unmatched transactions can be excluded.",
      );
      reason = text(reason, 500, true);
      this.db
        .prepare("UPDATE bank_transactions SET ignored_reason=? WHERE id=?")
        .run(reason, tid);
      this.audit("bank.transaction.excluded", tid, reason);
    },
  });
}
