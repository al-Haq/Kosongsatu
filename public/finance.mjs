export function financeUI(h) {
  const {
    get,
    api,
    refresh,
    renderRoute,
    navigate,
    showModal,
    modal,
    toast,
    E,
    money,
    dec,
    dateLabel,
    timeLabel,
    button,
    badge,
    input,
    area,
    select,
    formEnd,
    heading,
    empty,
    icon,
  } = h;
  let pendingImport = null;
  const receipt = (rid) => get().finance.receipts.find((r) => r.id === rid);
  const transaction = (tid) =>
    get().finance.bankTransactions.find((t) => t.id === tid);
  const clientOptions = () => [
    ["", "Select a client"],
    ...get().clients.map((c) => [c.id, c.name]),
  ];
  const forms = {
    receive(tid = "") {
      const S = get(),
        t = tid ? transaction(tid) : null;
      if (!S.clients.length) {
        toast("Add a client first.");
        return;
      }
      showModal(
        t ? "Record bank receipt" : "Record money received",
        `<form data-form="cash-receipt" data-id="${E(tid)}">${select("Client", "client_id", clientOptions())}<div class="form-grid">${input("Amount received (MYR)", "amount", t ? dec(t.amount) : "", "number", true, `min="0.01" step="0.01" ${t ? "readonly" : ""}`)}${input("Date received", "paid_date", t?.txn_date || S.today, "date", true, `max="${S.today}" ${t ? "readonly" : ""}`)}${select(
          "Method",
          "method",
          ["Bank transfer", "Cash", "Card", "Other"].map((v) => [v, v]),
          "Bank transfer",
        )}${input("Account label", "account", t?.account || "MAIN", "text", true, `maxlength="80" ${t ? "readonly" : ""}`)}</div>${input("Transaction reference", "reference", t?.reference || "", "text", true, `maxlength="120" ${t ? "readonly" : ""}`)}${area("Internal note", "note", "", 500)}<div class="notice info"><p>This records cash once. Allocate it to invoices afterwards; any remainder stays as available customer funds.</p></div><label class="check-row"><input type="checkbox" required>I have verified this money was received.</label>${formEnd("Record receipt")}</form>`,
      );
    },
    allocate(rid) {
      const S = get(),
        r = receipt(rid),
        docs = S.documents.filter(
          (d) =>
            d.client_id === r.client_id &&
            d.kind === "invoice" &&
            d.state === "issued" &&
            d.balance > 0,
        );
      if (!docs.length) {
        toast(
          "No unpaid issued invoices for this client. Funds remain available.",
        );
        return;
      }
      showModal(
        "Allocate existing receipt",
        `<form data-form="cash-allocate" data-id="${rid}"><div class="notice info"><p>${E(r.number)} / ${E(r.client.name)}<br>Available: ${money(r.available)}. This does not record new cash.</p></div>${select(
          "Invoice",
          "invoice_id",
          docs.map((d) => [d.id, `${d.number} / balance ${money(d.balance)}`]),
        )}${input("Amount to apply (MYR)", "amount", dec(Math.min(r.available, docs[0].balance)), "number", true, `min="0.01" max="${dec(r.available)}" step="0.01"`)}${formEnd("Apply funds")}</form>`,
      );
      modal
        .querySelector("[name=invoice_id]")
        .addEventListener("change", (e) => {
          const d = docs.find((d) => d.id === e.target.value);
          modal.querySelector("[name=amount]").value = dec(
            Math.min(r.available, d.balance),
          );
        });
    },
    refund(rid) {
      const S = get(),
        r = receipt(rid);
      showModal(
        "Record bank refund",
        `<form data-form="cash-refund" data-id="${rid}"><p>${E(r.number)} / available ${money(r.available)}</p><div class="form-grid">${input("Amount returned (MYR)", "amount", "", "number", true, `min="0.01" max="${dec(r.available)}" step="0.01"`)}${input("Date returned", "paid_date", S.today, "date", true, `min="${r.paid_date}" max="${S.today}"`)}</div>${input("Refund transaction reference", "reference", "", "text", true, 'maxlength="120"')}${area("Refund reason", "reason", "", 1000)}<label class="check-row"><input type="checkbox" required>I have already returned this money to the customer.</label>${formEnd("Record refund")}</form>`,
      );
      modal.querySelector("[name=reason]").required = true;
    },
    adjustment(did) {
      const S = get(),
        d = S.documents.find((d) => d.id === did);
      showModal(
        "Issue adjustment note",
        `<form data-form="adjustment" data-id="${did}"><div class="notice info"><p>${E(d.number)} / current invoice value ${money(d.adjusted_total)}<br>The original invoice stays unchanged. Credits release any excess allocation to customer funds.</p></div>${select(
          "Note type",
          "kind",
          [
            ["credit", "Credit note - reduce invoice"],
            ["debit", "Debit note - add charge"],
          ],
        )}<div class="form-grid">${input("Adjustment amount (MYR)", "amount", "", "number", true, 'min="0.01" step="0.01"')}${input("Issue date", "issue_date", S.today, "date", true, `max="${S.today}"`)}</div>${area("Reason shown on the note", "reason", "", 1000)}${formEnd("Issue note")}</form>`,
      );
      modal.querySelector("[name=reason]").required = true;
    },
    reason(title, type, id, help = "") {
      showModal(
        title,
        `<form data-form="${type}" data-id="${id}"><p>${E(help)}</p>${area("Reason", "reason", "", 1000)}${formEnd("Confirm")}</form>`,
      );
      modal.querySelector("[name=reason]").required = true;
    },
    import() {
      showModal(
        "Import bank statement CSV",
        `<form data-form="bank-preview">${input("Account label", "account", "MAIN", "text", true, 'maxlength="80"')}<p class="field-hint">Use normalized columns below. Positive amounts are money in; negative amounts are money out. Dates: YYYY-MM-DD. Amounts: MYR without thousands separators.</p><pre class="csv-example">date,reference,amount,description,transaction_id</pre><label>Choose CSV file<input type="file" id="bank-csv-file" accept=".csv,text/csv"></label>${area("CSV content", "csv", "", 110000)}${formEnd("Preview import")}</form>`,
        true,
      );
      modal.querySelector("[name=csv]").required = true;
      modal
        .querySelector("#bank-csv-file")
        .addEventListener("change", async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          if (file.size > 110000)
            return toast("Import up to 110 KB per batch.", true);
          modal.querySelector("[name=csv]").value = await file.text();
        });
    },
    match(tid) {
      const S = get(),
        t = transaction(tid);
      const opts =
        t.amount > 0
          ? S.finance.receipts
              .filter(
                (r) =>
                  !r.voided &&
                  !r.legacy_review &&
                  r.method === "Bank transfer" &&
                  r.amount === t.amount &&
                  r.account.toUpperCase() === t.account,
              )
              .map((r) => [
                r.id,
                `${r.number} / ${r.client.name} / ${r.reference}`,
              ])
          : S.finance.receipts.flatMap((r) =>
              r.refunds
                .filter(
                  (f) =>
                    f.amount === -t.amount &&
                    r.account.toUpperCase() === t.account,
                )
                .map((f) => [
                  f.id,
                  `${f.number} / ${r.client.name} / ${f.reference}`,
                ]),
            );
      if (!opts.length)
        return toast(
          t.amount > 0
            ? "No receipt with the same account/amount. Record a bank receipt first."
            : "Record the refund before matching this bank debit.",
        );
      showModal(
        "Match bank transaction",
        `<form data-form="bank-match" data-id="${tid}" data-kind="${t.amount > 0 ? "receipt" : "refund"}"><p>${dateLabel(t.txn_date)} / ${E(t.reference)} / ${money(t.amount)}</p><div class="mt22">${select("Receipt / refund", "target_id", opts)}</div><p class="field-hint">Check the customer and transaction date/reference before confirming.</p>${formEnd("Confirm match")}</form>`,
      );
    },
    mfa() {
      const S = get();
      showModal(
        S.security.enabled ? "Disable authenticator" : "Set up authenticator",
        `<form data-form="${S.security.enabled ? "mfa-disable" : "mfa-begin"}">${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : "<p>An authenticator app generates a code every 30 seconds. Recovery codes will be shown once after setup.</p>"}${formEnd(S.security.enabled ? "Disable MFA" : "Begin setup")}</form>`,
      );
    },
  };
  function ledger() {
    const S = get(),
      receipts = S.finance.receipts;
    const total = receipts
        .filter((r) => !r.voided)
        .reduce((s, r) => s + r.amount - r.refunded, 0),
      available = receipts.reduce((s, r) => s + r.available, 0);
    return (
      heading(
        "Cash & customer credits",
        "Record each payment once. Apply it across invoices or retain available customer funds.",
        button("New receipt", "cash-receive", "", true, "plus"),
      ) +
      `${receipts.some((r) => r.legacy_review) ? '<div class="notice"><p>Legacy transactions need review. Cash totals may include duplicate old entries until verified and corrected.</p></div>' : ""}<div class="metrics"><div class="metric"><div class="label">Net cash recorded</div><div class="value">${money(total)}</div><div class="hint">All dates / receipts less refunds</div></div><div class="metric"><div class="label">Available customer funds</div><div class="value teal">${money(available)}</div><div class="hint">Available for allocation or refund</div></div></div><section class="panel">${receipts.length ? `<div class="table-wrap"><table><thead><tr><th>Receipt / client</th><th>Received</th><th class="num">Original</th><th class="num">Allocated</th><th class="num">Available</th><th>Actions</th></tr></thead><tbody>${receipts.map((r) => `<tr><td><strong>${E(r.number)}</strong><small>${E(r.client.name)} / ${E(r.reference)}</small>${r.voided ? badge("Void") : r.legacy_review ? badge("Pending review") : ""}</td><td>${dateLabel(r.paid_date)}</td><td class="num">${money(r.amount)}</td><td class="num">${money(r.allocated)}</td><td class="num">${money(r.available)}${r.refunded ? `<small>Refunded ${money(r.refunded)}</small>` : ""}</td><td><div class="actions">${!r.voided ? `<a class="btn small" href="/api/receipts/${r.id}/pdf">PDF</a>` : ""}${!r.voided && r.legacy_review ? button("Review legacy", "cash-review", r.id) : r.available > 0 ? button("Allocate", "cash-allocate", r.id) + button("Refund", "cash-refund", r.id) : ""}${!r.voided && r.allocated === 0 && r.refunded === 0 ? button("Void entry", "cash-void", r.id) : ""}</div></td></tr>`).join("")}</tbody></table></div>` : empty("No cash receipts yet", "Record verified customer payments, then apply them to invoices.")}</section>${receipts.some((r) => r.refunds.length) ? `<section class="panel mt22"><h2>Refund notes</h2>${receipts.flatMap((r) => r.refunds.map((f) => `<div class="attention"><div><strong>${E(f.number)} / ${money(f.amount)}</strong><small>${E(r.client.name)} / ${E(f.reference)} / ${E(f.reason)}</small></div><a class="btn small" href="/api/refunds/${f.id}/pdf">PDF</a></div>`)).join("")}</section>` : ""}`
    );
  }
  function bank() {
    const S = get(),
      txns = S.finance.bankTransactions;
    return (
      heading(
        "Bank reconciliation",
        "Import normalized statement rows and review each match. Importing does not record income.",
        button("Import CSV", "bank-import", "", true, "plus"),
      ) +
      `<section class="panel">${txns.length ? `<div class="table-wrap"><table><thead><tr><th>Bank date / account</th><th>Reference</th><th class="num">Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${txns.map((t) => `<tr><td>${dateLabel(t.txn_date)}<small>${E(t.account)}</small></td><td>${E(t.reference)}<small>${E(t.description)}</small></td><td class="num">${money(t.amount)}</td><td>${badge(t.receipt_id || t.refund_id ? "Matched" : t.ignored_reason ? "Excluded" : "Unmatched")}</td><td><div class="actions">${t.receipt_id || t.refund_id || t.ignored_reason ? button("Reset match", "bank-reset", t.id) : button("Match existing", "bank-match", t.id) + (t.amount > 0 ? button("Record receipt", "bank-receive", t.id) : "") + button("Exclude", "bank-exclude", t.id)}</div></td></tr>`).join("")}</tbody></table></div>` : empty("No bank transactions", "Preview a normalized CSV before importing. Duplicate rows are skipped.")}</section>`
    );
  }
  function documentExtras(d) {
    if (d.kind !== "invoice" || d.state !== "issued") return "";
    return `<section class="panel"><div class="panel-head"><h2>Invoice adjustments</h2></div><div class="total-row"><span>Original</span><strong>${money(d.total)}</strong></div><div class="total-row"><span>Credits / debits</span><strong>−${money(d.credit)} / +${money(d.debit)}</strong></div><div class="total-row emphasis"><span>Adjusted value</span><span>${money(d.adjusted_total)}</span></div><div class="actions mt22">${button("Credit / debit note", "invoice-adjust", d.id)}</div>${d.adjustments.map((a) => `<div class="payment"><strong>${E(a.number)} / ${money(a.amount)}</strong><p>${E(a.kind)} / ${E(a.reason)}</p><a href="/api/adjustments/${a.id}/pdf">Note PDF</a></div>`).join("")}<div class="mt22"><a href="#/ledger">Manage customer funds →</a></div></section>`;
  }
  // Encrypted backups (local and off-site) are shown by the team module.
  function security() {
    const S = get();
    return `<section class="panel mt22"><div class="panel-head"><h2>Authenticator & recovery</h2>${badge(S.security.enabled ? "Enabled" : "Not enabled")}</div><p>${S.security.enabled ? `${S.security.recoveryRemaining} unused recovery codes.` : "Add an authenticator app and save your recovery codes securely."}</p><div class="actions mt22">${button(S.security.enabled ? "Manage MFA" : "Enable MFA", "mfa-setup")}</div><p class="field-hint">Lost all login factors? Console recovery is available only to the server operator.</p></section>`;
  }
  async function action(type, id) {
    switch (type) {
      case "cash-receive":
        forms.receive();
        break;
      case "bank-receive":
        forms.receive(id);
        break;
      case "cash-allocate":
        forms.allocate(id);
        break;
      case "cash-refund":
        forms.refund(id);
        break;
      case "invoice-adjust":
        forms.adjustment(id);
        break;
      case "cash-void":
        forms.reason(
          "Void an incorrect cash entry",
          "cash-void",
          id,
          "Use only for a recording error. This does not return money to the customer.",
        );
        break;
      case "cash-review":
        forms.reason(
          "Review legacy duplicate",
          "cash-review",
          id,
          "Confirm from bank evidence that this is a distinct legitimate receipt. This action preserves the original data and is audited.",
        );
        break;
      case "bank-import":
        forms.import();
        break;
      case "bank-match":
        forms.match(id);
        break;
      case "bank-exclude":
        forms.reason(
          "Exclude bank transaction",
          "bank-exclude",
          id,
          "For transactions outside customer billing, such as owner capital or an operating expense.",
        );
        break;
      case "bank-reset":
        forms.reason(
          "Reset bank match",
          "bank-reset",
          id,
          "The underlying receipt/refund remains recorded.",
        );
        break;
      case "reject-proof":
        forms.reason("Reject submitted reference", "proof-reject", id);
        break;
      case "mfa-setup":
        forms.mfa();
        break;
      case "backup-now":
        await api("/recovery/backup", "POST", {});
        await refresh();
        renderRoute();
        toast("Encrypted backup created.");
        break;
      default:
        return false;
    }
    return true;
  }
  async function submit(form, b) {
    const type = form.dataset.form,
      id = form.dataset.id;
    let path;
    if (type === "cash-receipt")
      path = id ? `/bank/${id}/receive` : "/receipts";
    else if (type === "cash-allocate") path = `/receipts/${id}/allocate`;
    else if (type === "cash-refund") path = `/receipts/${id}/refund`;
    else if (type === "cash-void") path = `/receipts/${id}/void`;
    else if (type === "cash-review") path = `/receipts/${id}/review`;
    else if (type === "adjustment") path = `/documents/${id}/adjustments`;
    else if (type === "bank-match") {
      path = `/bank/${id}/match`;
      b.kind = form.dataset.kind;
    } else if (type === "bank-reset") path = `/bank/${id}/unmatch`;
    else if (type === "bank-exclude") path = `/bank/${id}/exclude`;
    else if (type === "proof-reject") path = `/proofs/${id}/reject`;
    else if (type === "bank-preview") {
      const rows = await api("/bank/preview", "POST", {
        csv: b.csv,
        account: b.account,
      });
      pendingImport = { csv: b.csv, account: b.account };
      modal.close();
      showModal(
        "Review bank import",
        `<form data-form="bank-confirm"><p>${rows.length} validated rows / ${rows.filter((r) => r.duplicate).length} duplicates will be skipped. No payments are created by import.</p><div class="table-wrap mt22"><table><thead><tr><th>Date</th><th>Reference</th><th class="num">Amount</th><th>Import</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${dateLabel(r.txn_date)}</td><td>${E(r.reference)}</td><td class="num">${money(r.amount)}</td><td>${r.duplicate ? "Skip duplicate" : "New row"}</td></tr>`).join("")}</tbody></table></div>${formEnd("Confirm import")}</form>`,
        true,
      );
      return true;
    } else if (type === "bank-confirm") {
      const result = await api("/bank/import", "POST", pendingImport);
      pendingImport = null;
      modal.close();
      await refresh();
      renderRoute();
      toast(
        `${result.inserted} bank rows imported; ${result.skipped} duplicates skipped.`,
      );
      return true;
    } else if (type === "mfa-begin") {
      const setup = await api("/mfa/begin", "POST", b);
      modal.close();
      showModal(
        "Verify authenticator",
        `<form data-form="mfa-enable"><p>In your authenticator app, add a time-based account using this setup key. Keep it private.</p>${input("Authenticator setup key", "secret", setup.secret, "text", false, "readonly")}${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${input("6-digit authenticator code", "code", "", "text", true, 'inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"')}${formEnd("Enable MFA")}</form>`,
      );
      return true;
    } else if (type === "mfa-enable") {
      const result = await api("/mfa/enable", "POST", {
        password: b.password,
        code: b.code,
      });
      modal.close();
      await refresh();
      renderRoute();
      showModal(
        "Save your recovery codes",
        `<p>These codes are shown once. Store them in your password manager. Each code works once with your password if your authenticator is unavailable.</p><label class="mt22">Recovery codes<textarea readonly rows="10">${E(result.codes.join("\n"))}</textarea></label>${button("Done", "close-modal", "", true)}`,
      );
      return true;
    } else if (type === "mfa-disable") {
      await api("/mfa/disable", "POST", b);
      modal.close();
      await refresh();
      renderRoute();
      toast("MFA disabled. Other sessions were revoked.");
      return true;
    } else return false;
    await api(path, "POST", b);
    modal.close();
    await refresh();
    renderRoute();
    toast(
      type === "adjustment"
        ? "Adjustment note issued. Balances updated."
        : "Record saved.",
    );
    return true;
  }
  return { ledger, bank, documentExtras, security, action, submit };
}
