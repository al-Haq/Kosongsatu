import { chmodSync } from "node:fs";
import { check, date, TAX_RATES, today, addDays, allocateDiscount } from "./domain.mjs";
export function migrateTax(db, path) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= 6) return;
  if (
    path !== ":memory:" &&
    db.prepare("SELECT count(*) n FROM documents").get().n
  ) {
    const snapshot = path + ".pre-v6-" + Date.now() + ".sqlite";
    db.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 ALTER TABLE documents ADD COLUMN tax INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE services ADD COLUMN tax_rate INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE clients ADD COLUMN tin TEXT NOT NULL DEFAULT '';
 ALTER TABLE clients ADD COLUMN brn TEXT NOT NULL DEFAULT '';
 ALTER TABLE clients ADD COLUMN sst_number TEXT NOT NULL DEFAULT '';
 PRAGMA user_version=6; COMMIT;`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function attachTax(Store) {
  const originalService = Store.prototype.saveService,
    originalIssue = Store.prototype.issue;
  Object.assign(Store.prototype, {
    // Settings can change after a draft is saved, so check again at issue time.
    issue(idv) {
      const d = this.document(idv);
      if (d.state === "draft" && d.items.some((i) => i.tax > 0))
        check(
          this.settings().sstNumber,
          "Add your SST registration number in Settings before issuing a document that charges SST.",
          409,
        );
      return originalIssue.call(this, idv);
    },
    saveService(b, idv) {
      check(
        TAX_RATES.includes(Number(b.tax_rate ?? 0)),
        "Choose an SST rate of 0, 5, 6, 8 or 10%.",
      );
      return originalService.call(this, b, idv);
    },
    // SST summary of issued invoices by issue date, for preparing the SST-02 return.
    // Credit and debit notes are listed separately because they carry no SST breakdown.
    sstReport(b = {}) {
      const to = b.to ? date(b.to) : today();
      const from = b.from ? date(b.from) : addDays(to, -60);
      check(from <= to, "Choose a valid report period.");
      const invoices = this.documents().filter(
        (d) =>
          d.kind === "invoice" &&
          d.state === "issued" &&
          d.issue_date >= from &&
          d.issue_date <= to,
      );
      const rates = new Map();
      const rows = [];
      for (const d of invoices) {
        const shares = new Map();
        // Documents created before SST support have no per-line taxable value,
        // so their discount is spread over the lines the same way.
        const legacy = allocateDiscount(
          d.items.map((i) => i.amount),
          d.discount,
        );
        for (const [n, i] of d.items.entries()) {
          const rate = i.tax_rate || 0;
          const r = shares.get(rate) || { taxable: 0, tax: 0 };
          r.taxable += i.taxable ?? i.amount - legacy[n];
          r.tax += i.tax || 0;
          shares.set(rate, r);
        }
        for (const [rate, r] of shares) {
          const total = rates.get(rate) || { rate, taxable: 0, tax: 0 };
          total.taxable += r.taxable;
          total.tax += r.tax;
          rates.set(rate, total);
          rows.push({
            number: d.number,
            issue_date: d.issue_date,
            client: d.client.name,
            client_tin: d.client.tin || "",
            rate,
            taxable: r.taxable,
            tax: r.tax,
          });
        }
      }
      const notes = this.db
        .prepare(
          "SELECT a.number,a.kind,a.amount,a.issue_date,d.number invoice FROM adjustments a JOIN documents d ON d.id=a.invoice_id WHERE a.issue_date BETWEEN ? AND ? ORDER BY a.issue_date",
        )
        .all(from, to);
      return {
        from,
        to,
        sstNumber: this.settings().sstNumber || "",
        rates: [...rates.values()].sort((a, b) => a.rate - b.rate),
        tax: rows.reduce((s, r) => s + r.tax, 0),
        rows,
        notes,
      };
    },
  });
}
