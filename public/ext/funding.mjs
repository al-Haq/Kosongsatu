// Funding: money put into the business by its owner, directors or investors
// (capital or loans) and loan repayments, kept apart from customer receipts.
// Browser module contract: see docs/PLUGINS.md. Owner guide: docs/features/funding.md.
export default function fundingUI(h) {
  const {
    E,
    button,
    badge,
    empty,
    heading,
    input,
    area,
    select,
    formEnd,
    dateLabel,
    money,
    modal,
    showModal,
    icon,
  } = h;
  const F = () => h.get().ext?.funding || null;
  const KINDS = [
    [
      "capital",
      "Capital",
      "Money the owner or an investor puts in to stay. It is not paid back.",
    ],
    [
      "loan",
      "Loan to the business",
      "Money lent to the business, to be paid back later.",
    ],
    [
      "repayment",
      "Loan repayment",
      "The business pays part of a loan back to the lender.",
    ],
  ];
  const ROLES = [
    ["owner", "Owner"],
    ["director", "Director"],
    ["investor", "Investor"],
    ["other", "Other"],
  ];
  const label = (list, key) => list.find((x) => x[0] === key)?.[1] || key;
  const entries = () => F()?.entries || [];
  const openLoans = () =>
    entries().filter((e) => e.kind === "loan" && !e.voided && e.balance > 0);
  const people = () => [...new Set(entries().map((e) => e.party))];

  // One form for the three kinds; the fields follow the kind chosen at the top.
  function form(preset = {}) {
    const S = h.get();
    const kind = KINDS.some((k) => k[0] === preset.kind)
      ? preset.kind
      : "capital";
    const loans = openLoans();
    const option = ([value, name, hint]) =>
      `<label class="kind-option"><input type="radio" name="kind" value="${value}" ${kind === value ? "checked" : ""}><span><strong>${E(name)}</strong><small>${E(hint)}</small></span></label>`;
    showModal(
      "Record funding",
      `<form data-form="funding-record" data-funding-kind="${kind}" class="funding-form"><fieldset class="kind-choice funding-kind"><legend>What is this money?</legend>${KINDS.map(option).join("")}</fieldset><div class="repayment-only">${select("Which loan is being repaid", "loan_id", loans.length ? loans.map((l) => [l.id, `${l.number} · ${l.party} · still owed ${money(l.balance)}`]) : [["", "No loan is still owed"]], preset.loan_id || "", false)}</div><div class="form-grid"><div class="not-repayment">${input("From whom (name)", "party", preset.party || "", "text", false, 'maxlength="120" list="funding-people" autocomplete="off"')}<datalist id="funding-people">${people()
        .map((p) => `<option value="${E(p)}"></option>`)
        .join(
          "",
        )}</datalist></div><div class="not-repayment">${select("Their role", "role", ROLES, preset.role || "owner")}</div>${input("Amount (MYR)", "amount", "", "number", true, 'min="0.01" step="0.01"')}${input("Date", "txn_date", S.today, "date", true, `max="${S.today}"`)}${select(
        "How the money moved",
        "method",
        ["Bank transfer", "Cash", "Cheque", "Other"].map((v) => [v, v]),
        "Bank transfer",
      )}${input("Account label", "account", "MAIN", "text", true, 'maxlength="80"')}</div>${input("Reference (bank transaction or cheque number)", "reference", "", "text", false, 'maxlength="120"')}${area("Note", "note", "", 500)}<div class="notice info"><p>This is not sales income: it never appears on invoices, receipts or profit. It counts as cash in the cash flow forecast.</p></div>${formEnd("Record funding")}</form>`,
    );
    const f = modal.querySelector('form[data-form="funding-record"]');
    f.addEventListener("change", (e) => {
      if (e.target.name === "kind") f.dataset.fundingKind = e.target.value;
    });
  }

  function page() {
    const f = F();
    if (!f)
      return (
        heading("Funding", "") +
        `<section class="panel">${empty("Not available for your role")}</section>`
      );
    const { summary } = f;
    const list = f.entries;
    const metrics = `<div class="metrics"><div class="metric"><div class="label">Capital in</div><div class="value">${money(summary.capital)}</div><div class="hint">Stays in the business</div></div><div class="metric"><div class="label">Loans received</div><div class="value">${money(summary.loans)}</div><div class="hint">To be paid back</div></div><div class="metric"><div class="label">Repaid so far</div><div class="value">${money(summary.repaid)}</div><div class="hint">Paid back to lenders</div></div><div class="metric"><div class="label">Still owed</div><div class="value ${summary.outstanding ? "red-text" : "teal"}">${money(summary.outstanding)}</div><div class="hint">Loans not yet repaid</div></div></div>`;
    const byPerson = summary.people.length
      ? `<section class="panel"><div class="panel-head"><h2>By person</h2></div><div class="table-wrap"><table class="table-cards"><caption class="sr-only">Funding by person</caption><thead><tr><th>Person</th><th>Role</th><th class="num">Capital</th><th class="num">Loans</th><th class="num">Repaid</th><th class="num">Still owed</th></tr></thead><tbody>${summary.people
          .map(
            (p) =>
              `<tr><td class="card-title"><strong>${E(p.party)}</strong></td><td data-label="Role">${E(label(ROLES, p.role))}</td><td class="num" data-label="Capital">${money(p.capital)}</td><td class="num" data-label="Loans">${money(p.loans)}</td><td class="num" data-label="Repaid">${money(p.repaid)}</td><td class="num" data-label="Still owed"><strong>${money(p.outstanding)}</strong></td></tr>`,
          )
          .join("")}</tbody></table></div></section>`
      : "";
    const row = (e) => {
      const out = e.kind === "repayment";
      return `<tr class="${e.voided ? "funding-void" : ""}"><td class="card-title"><strong>${E(e.number)}</strong><small>${E(label(KINDS, e.kind))}${e.loan_number ? " of " + E(e.loan_number) : ""}${e.reference ? " · " + E(e.reference) : ""}</small>${e.voided ? " " + badge("Void") : ""}</td><td data-label="Date">${dateLabel(e.txn_date)}</td><td data-label="Person">${E(e.party)}<small>${E(label(ROLES, e.role))}</small></td><td class="num" data-label="In">${out ? "—" : money(e.amount)}</td><td class="num" data-label="Out">${out ? money(e.amount) : "—"}</td><td class="num" data-label="Still owed">${e.kind === "loan" && !e.voided ? money(e.balance) : "—"}</td><td><div class="actions">${e.kind === "loan" && !e.voided && e.balance > 0 ? button("Repay", "funding-repay", e.id) : ""}${!e.voided && !(e.kind === "loan" && e.repaid) ? button("Void", "funding-void", e.id) : ""}</div></td></tr>`;
    };
    const table = list.length
      ? `<section class="panel mt22"><div class="panel-head"><h2>Entries</h2><a class="btn" href="/api/funding.csv">${icon("download")} CSV</a></div><div class="table-wrap"><table class="table-cards"><caption class="sr-only">Funding entries</caption><thead><tr><th>Entry</th><th>Date</th><th>Person</th><th class="num">In</th><th class="num">Out</th><th class="num">Still owed</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map(row).join("")}</tbody></table></div></section>`
      : `<section class="panel mt22">${empty("No funding recorded yet", "Record the money the owner, a director or an investor put into the business, as capital or as a loan, and each loan repayment.", button("Record funding", "funding-new", "", true))}</section>`;
    return (
      heading(
        "Owner and investor funding",
        "Money put into the business by its owner, directors or investors, and loan repayments. Not sales income: it stays out of invoices, receipts and profit.",
        button("Record funding", "funding-new", "", true, "plus"),
      ) +
      metrics +
      byPerson +
      table
    );
  }

  return {
    nav: [
      { key: "funding", label: "Funding", icon: "wallet", group: "Get paid" },
    ],
    pages: { funding: page },
    async action(type, id) {
      switch (type) {
        case "funding-new":
          form();
          return true;
        case "funding-repay": {
          const loan = openLoans().find((x) => x.id === id);
          form({
            kind: "repayment",
            loan_id: id,
            party: loan?.party,
            role: loan?.role,
          });
          return true;
        }
        case "funding-void":
          h.reasonForm("Void a funding entry", "funding-void", id);
          return true;
      }
      return false;
    },
    async submit(form, b) {
      const type = form.dataset.form;
      if (type === "funding-record") {
        await h.api("/funding", "POST", b);
        modal.close();
        await h.refresh();
        h.renderRoute();
        h.toast(
          b.kind === "repayment" ? "Repayment recorded." : "Funding recorded.",
        );
        return true;
      }
      if (type === "funding-void") {
        await h.api(`/funding/${form.dataset.id}/void`, "POST", b);
        modal.close();
        await h.refresh();
        h.renderRoute();
        h.toast("Entry voided.");
        return true;
      }
      return false;
    },
  };
}
