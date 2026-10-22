export function automationUI(h) {
  const {
    setDateValue,
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
  } = h;
  const clientName = (id) => get().clients.find((c) => c.id === id)?.name || id;
  const quote = (id) => get().documents.find((d) => d.id === id);
  const customerOpts = (selected = "") => [
    ["", "Select a customer"],
    ...get()
      .clients.filter((c) => !c.archived || c.id === selected)
      .map((c) => [c.id, c.name]),
  ];
  let chatKey = crypto.randomUUID();
  function sales() {
    const S = get(),
      a = S.sales,
      stages = ["new", "qualified", "quoted", "won", "lost"];
    return (
      heading("Sales and customer POs", "",
        button("New opportunity", "sales-new", "", true),
      ) +
      `<div class="sales-stages">${stages.map((stage) => `<div class="metric"><div class="label">${E(stage)}</div><div class="value">${a.opportunities.filter((o) => o.stage === stage).length}</div><div class="hint">${money(a.opportunities.filter((o) => o.stage === stage).reduce((n, o) => n + o.expected_amount, 0))} expected</div></div>`).join("")}</div><section class="panel mt22"><div class="panel-head"><h2>Opportunities</h2></div>${a.opportunities.length ? `<div class="table-wrap"><table><thead><tr><th>Opportunity / customer</th><th>Stage</th><th>Expected</th><th>Quotation</th><th>Actions</th></tr></thead><tbody>${a.opportunities.map((o) => `<tr><td><strong>${E(o.title)}</strong><small>${E(clientName(o.client_id))}</small></td><td>${badge(o.stage)}</td><td>${money(o.expected_amount)}</td><td>${o.quote_id ? `<a href="#/document/${o.quote_id}">${E(quote(o.quote_id)?.number || "Draft quote")}</a>` : "—"}</td><td><div class="actions">${button("Edit", "sales-edit", o.id)}${!o.quote_id ? button("Prepare quote", "sales-quote", o.id) + button("Delete", "sales-delete", o.id) : ""}</div></td></tr>`).join("")}</tbody></table></div>` : empty("Start with a customer opportunity", "Add the customer in Clients, then record the scope and expected value.")}</section><section class="panel mt22"><div class="panel-head"><h2>Customer purchase orders</h2>${button("Register customer PO", "po-new")}</div><p class="field-hint">POs issued by your customer to Nawlogic against accepted quotations. A quotation can take several partial POs up to its total; each PO is invoiced once for its own amount. Supplier purchasing is a separate future workflow.</p>${a.purchaseOrders.length ? `<div class="table-wrap mt22"><table><thead><tr><th>Customer PO</th><th>Quotation</th><th>Value</th><th>Invoice</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>${a.purchaseOrders.map((p) => `<tr><td><strong>${E(p.reference)}</strong><small>${E(clientName(p.client_id))} / ${dateLabel(p.po_date)}${p.revision ? ` / revision ${p.revision}` : ""}${p.files ? ` / ${p.files} file${p.files > 1 ? "s" : ""}` : ""}</small></td><td><a href="#/document/${p.quote_id}">${E(quote(p.quote_id)?.number)}</a></td><td>${money(p.amount)}${p.quote_total && p.amount !== p.quote_total ? `<small>Part of ${money(p.quote_total)}</small>` : ""}</td><td>${p.status === "cancelled" ? badge("Cancelled") : p.invoice_id && p.invoice_state !== "void" ? `<a href="#/document/${p.invoice_id}">${E(quote(p.invoice_id)?.number || "Open invoice draft")}</a>` : button("Create invoice draft", "po-invoice", p.id)}</td><td>${button("Details", "po-details", p.id)}</td></tr>`).join("")}</tbody></table></div>` : empty("No customer POs yet", "Record customer acceptance first, then register the PO reference and value.")}</section><section class="panel mt22"><h2>Record customer acceptance</h2><p class="field-hint">For acceptance received outside the client portal, enter the customer name and evidence. This records what you verified; it does not impersonate a portal signature.</p>${
        S.documents
          .filter(
            (d) =>
              d.kind === "quote" &&
              d.state === "issued" &&
              d.due_date >= S.today,
          )
          .map(
            (d) =>
              `<div class="attention"><div><strong>${E(d.number)}</strong><small>${E(d.client.name)} / ${money(d.total)}</small></div>${button("Record acceptance", "quote-accept-offline", d.id)}</div>`,
          )
          .join("") || "<p>No issued quotations awaiting acceptance.</p>"
      }</section>`
    );
  }
  function describe(p) {
    const b = p.payload;
    let content = "";
    if (p.kind === "sales")
      content = `<p><strong>${E(b.title)}</strong> / ${E(clientName(b.client_id))}</p><p>${E(b.description || "")}</p><p>Expected ${money(Math.round(Number(b.expected_amount || 0) * 100))}</p>`;
    if (p.kind === "quotation") {
      const lines = b.items.map((i) => {
        const rate = Math.round(Number(i.rate) * 100),
          qty = Math.round(Number(i.quantity) * 100);
        return { ...i, sen: Math.round((rate * qty) / 100) };
      });
      content = `<p>Customer: <strong>${E(clientName(b.client_id))}</strong></p><p>${dateLabel(b.issue_date)} → ${dateLabel(b.due_date)}</p><div class="table-wrap"><table><thead><tr><th>Scope</th><th>Qty</th><th>Rate MYR</th><th>Total</th></tr></thead><tbody>${lines.map((i) => `<tr><td>${E(i.description)}</td><td>${E(i.quantity)}</td><td>${E(i.rate)}</td><td>${money(i.sen)}</td></tr>`).join("")}</tbody></table></div><p>Discount ${money(Math.round(Number(b.discount || 0) * 100))} / <strong>Total ${money(lines.reduce((n, i) => n + i.sen, 0) - Math.round(Number(b.discount || 0) * 100))}</strong></p><p>Notes: ${E(b.notes || "—")}</p><p>Terms: ${E(b.terms || "Default company terms")}</p>`;
    }
    if (p.kind === "customer_po")
      content = `<p><strong>Customer PO ${E(b.reference)}</strong></p><p>${E(quote(b.quote_id)?.number)} / ${money(Math.round(Number(b.amount) * 100))} / ${dateLabel(b.po_date)}</p><p>${E(b.notes || "")}</p>`;
    if (p.kind === "invoice_from_quote")
      content = `<p>Create/open one <strong>draft invoice</strong> from ${E(quote(b.quote_id)?.number)} / ${E(quote(b.quote_id)?.client.name)} / ${money(quote(b.quote_id)?.total || 0)}</p><p>${b.po_id ? "Customer PO: " + E(get().sales.purchaseOrders.find((po) => po.id === b.po_id)?.reference || b.po_id) : "Any registered customer PO will be linked automatically."}</p>`;
    // Module proposal types describe themselves with a plain-text summary.
    if (!content) content = `<p>${E(p.summary || p.kind.replaceAll("_", " "))}</p>`;
    return content;
  }
  function automation() {
    const S = get(),
      pending = S.automation.proposals.filter((p) => p.state === "pending");
    return (
      heading("Automation", "") +
      `<div class="status-strip"><div><strong>Sales assistant</strong><p>AI reads relevant records and queues proposals. Issuing documents, sending messages and moving money stay separate owner actions.</p></div><div class="strip-facts">${badge(S.assistant.configured ? "Model configured" : "Model not configured")}<span>${S.assistant.configured ? E(S.assistant.model) + " / " + E(S.assistant.providerOrigin) : "No model connected. MCP, proposals and rules still work."}</span></div></div><div class="grid-equal mt22"><section class="panel"><div class="panel-head"><h2>Ask your assistant</h2></div><form data-form="assistant-chat">${area("Your request", "prompt", "", 4000)}<p class="field-hint">Try: “Find my qualified sales opportunities and prepare a quotation using the service catalog.”</p><label class="check-row"><input type="checkbox" name="consent" required>I agree to send this request and the business records it needs to the configured AI provider.</label><div class="form-error" role="alert"></div><div class="form-actions">${S.assistant.configured ? "" : '<span class="actions-hint">Off until AI_BASE_URL and AI_MODEL are set on the server. No AI request is sent.</span>'}<button class="btn primary" type="submit" ${S.assistant.configured ? "" : "disabled"}>Ask assistant</button></div></form><div class="assistant-history">${S.assistantRuns
        .slice(0, 5)
        .map(
          (r) =>
            `<article class="assistant-message"><small>${timeLabel(r.created)} / ${E(r.state)}</small><h3>${E(r.prompt)}</h3><p>${E(r.response || "Request in progress. If interrupted, start a new request after checking proposals.")}</p></article>`,
        )
        .join(
          "",
        )}</div></section><section class="panel"><div class="panel-head"><h2>Review queue</h2><div class="actions">${badge(String(pending.length) + " pending")}${button("Run pending events", "automation-run")}</div></div>${pending.length ? pending.map((p) => `<div class="proposal-card"><div class="payment-top"><strong>${E(p.kind.replaceAll("_", " "))}</strong>${badge(p.expires < Date.now() ? "Expired" : "Pending review")}</div><p>${E(p.source)} / ${timeLabel(p.created)}</p>${button("Review proposal", "proposal-review", p.id)}</div>`).join("") : empty("No pending proposals", "AI and MCP suggestions appear here before changes are applied.")}<details class="mt22"><summary>Recent decisions</summary>${
        S.automation.proposals
          .filter((p) => p.state !== "pending")
          .slice(0, 10)
          .map(
            (p) =>
              `<div class="payment"><strong>${E(p.kind)} / ${E(p.state)}</strong>${p.result?.kind === "document" ? `<p><a href="#/document/${p.result.id}">Open resulting document</a></p>` : ""}</div>`,
          )
          .join("") || "<p>No decisions yet.</p>"
      }</details></section></div><section class="panel mt22"><h2>Deterministic workflow rules</h2><p class="field-hint">Disabled by default. Enabling applies to new events only. The server checks events every 30 seconds while running; Run pending events is available for testing.</p>${S.automation.rules.map((r) => `<div class="setting-line"><div><h3>${E(r.name)}</h3><p>${E(r.description)}</p></div>${button(r.enabled ? "Disable" : "Enable", "rule-toggle", r.id)}</div>`).join("")}</section><section class="panel mt22"><div class="panel-head"><h2>MCP and connector access</h2>${button("Create connector", "connector-new")}</div><p>Connect a stdio MCP host or use the scoped HTTP tools API from n8n. Connector tokens can read permitted records or queue proposals; they cannot approve them.</p><p class="field-hint">Setup guide: docs/AUTOMATION.md in the repository. Access tokens are shown once and stored as hashes.</p>${S.connectors.map((c) => `<div class="setting-line"><div><h3>${E(c.label)}</h3><p>${E(c.scopes.join(", "))}<br>Expires ${timeLabel(c.expires)} / ${c.revoked ? "Revoked" : c.expires < Date.now() ? "Expired" : "Active"}</p></div>${!c.revoked ? button("Revoke", "connector-revoke", c.id) : badge("Revoked")}</div>`).join("") || '<p class="mt22">No connectors created.</p>'}</section><section class="panel mt22"><h2>Automation run log</h2><p>${S.automation.pendingEvents} events waiting for processing.</p>${
        S.automation.runs
          .slice(0, 20)
          .map(
            (r) =>
              `<div class="attention"><div><strong>${E(r.rule_id)} / ${E(r.state)}</strong><small>Event ${r.event_id} / ${timeLabel(r.created)}${r.error ? " / " + E(r.error) : ""}</small></div>${r.state === "failed" ? button("Retry", "automation-retry", r.id) : ""}</div>`,
          )
          .join("") || "<p>No rule executions yet.</p>"
      }</section>`
    );
  }
  function opportunityForm(sid) {
    const S = get(),
      s = S.sales.opportunities.find((o) => o.id === sid);
    if (!S.clients.length) return toast("Add a customer in Clients first.");
    showModal(
      s ? "Edit opportunity" : "New sales opportunity",
      `<form data-form="sales-save" data-id="${E(sid || "")}">${select("Customer", "client_id", customerOpts(s?.client_id), s?.client_id)}${input("Opportunity title", "title", s?.title || "", "text", true, 'maxlength="180"')}${area("Scope / sales notes", "description", s?.description || "", 1000)}<div class="form-grid">${select(
        "Stage",
        "stage",
        ["new", "qualified", "quoted", "won", "lost"].map((v) => [v, v]),
        s?.stage || "new",
      )}${input("Expected value (MYR)", "expected_amount", dec(s?.expected_amount || 0), "number", true, 'min="0" step="0.01"')}</div>${formEnd("Save opportunity")}</form>`,
    );
  }
  function quoteForm(sid) {
    const S = get(),
      s = S.sales.opportunities.find((o) => o.id === sid),
      services = S.services.filter((x) => x.active);
    showModal(
      "Prepare quotation proposal",
      `<form data-form="sales-quote" data-id="${sid}"><p>${E(s.title)} / ${E(clientName(s.client_id))}</p>${select("Catalog service", "service_id", [["", "Custom scope"], ...services.map((v) => [v.id, v.name])])}${input("Line description", "description", s.title, "text", true, 'maxlength="240"')}<div class="form-grid">${input("Quantity", "quantity", 1, "number", true, 'min="0.01" step="0.01"')}${input("Rate (MYR)", "rate", dec(s.expected_amount), "number", true, 'min="0" step="0.01"')}${input("Issue date", "issue_date", S.today, "date", true)}${input("Valid until", "due_date", S.today, "date", true)}</div>${area("Quotation notes", "notes", s.description, 1000)}<p class="field-hint">Creates a review proposal for one line. After approval, edit the draft to add more lines before issuing.</p>${formEnd("Queue quotation proposal")}</form>`,
    );
    modal.querySelector("[name=service_id]").required = false;
    modal.querySelector("[name=service_id]").addEventListener("change", (e) => {
      const v = services.find((v) => v.id === e.target.value);
      if (v) {
        modal.querySelector("[name=description]").value = (
          v.description || v.name
        ).slice(0, 240);
        modal.querySelector("[name=rate]").value = dec(v.rate);
      }
    });
    const until = new Date(S.today + "T00:00:00Z");
    until.setUTCDate(until.getUTCDate() + 14);
    setDateValue(modal.querySelector("[name=due_date]"), until.toISOString().slice(0, 10));
  }
  function poForm() {
    const S = get(),
      qs = S.documents.filter(
        (q) =>
          q.kind === "quote" &&
          q.state === "accepted" &&
          !S.sales.purchaseOrders.some((p) => p.quote_id === q.id),
      );
    if (!qs.length)
      return toast(
        "An accepted quotation without a registered PO is required.",
      );
    showModal(
      "Register customer PO",
      `<form data-form="po-save">${select(
        "Accepted quotation",
        "quote_id",
        qs.map((q) => [q.id, `${q.number} / ${q.client.name}`]),
      )}${input("Customer PO reference", "reference", "", "text", true, 'maxlength="120"')}<div class="form-grid">${input("PO value (MYR)", "amount", dec(qs[0].total), "number", true, 'min="0.01" step="0.01"')}${input("PO date", "po_date", S.today, "date", true, `max="${S.today}"`)}</div>${area("PO notes", "notes", "", 1000)}<label class="check-row"><input type="checkbox" required>I have verified this PO was issued by the customer.</label>${formEnd("Register PO")}</form>`,
    );
    modal.querySelector("[name=quote_id]").addEventListener("change", (e) => {
      modal.querySelector("[name=amount]").value = dec(
        qs.find((q) => q.id === e.target.value).total,
      );
    });
  }
  async function action(type, sid) {
    const S = get();
    switch (type) {
      case "sales-new":
        opportunityForm();
        break;
      case "sales-edit":
        opportunityForm(sid);
        break;
      case "sales-delete":
        if (!confirm("Delete this opportunity? The audit history keeps a record."))
          break;
        await api("/sales/opportunities/" + sid, "DELETE");
        await refresh();
        renderRoute();
        toast("Opportunity deleted.");
        break;
      case "sales-quote":
        quoteForm(sid);
        break;
      case "po-new":
        poForm();
        break;
      case "po-invoice": {
        const d = await api(`/sales/customer-pos/${sid}/invoice`, "POST", {});
        await refresh();
        navigate("document/" + d.id);
        break;
      }
      case "quote-accept-offline":
        showModal(
          "Record verified acceptance",
          `<form data-form="quote-offline" data-id="${sid}"><p>${E(quote(sid).number)} / ${E(quote(sid).client.name)}</p>${input("Customer signatory name", "name", "", "text", true, 'maxlength="120"')}${area("Evidence / communication reference", "evidence", "", 1000)}<label class="check-row"><input type="checkbox" required>I have verified the customer accepted this quotation.</label>${formEnd("Record acceptance")}</form>`,
        );
        modal.querySelector("[name=evidence]").required = true;
        break;
      case "proposal-review": {
        const p = S.automation.proposals.find((p) => p.id === sid);
        showModal(
          "Review " + p.kind.replaceAll("_", " "),
          `<p>Source: ${E(p.source)} / expires ${timeLabel(p.expires)}</p><div class="proposal-preview">${describe(p)}</div><p class="notice">Check the scope, customer, prices and references before approving. Approval creates the described record; it does not issue or send a document.</p><div class="actions mt22">${p.expires > Date.now() ? button("Approve and apply", "proposal-approve", sid, true) : ""}${button("Reject", "proposal-reject", sid)}</div>`,
          true,
        );
        break;
      }
      case "proposal-approve": {
        const r = await api(`/automation/proposals/${sid}/approve`, "POST", {});
        modal.close();
        await refresh();
        if (r.kind === "document") navigate("document/" + r.id);
        else renderRoute();
        toast("Proposal applied.");
        break;
      }
      case "proposal-reject":
        showModal(
          "Reject proposal",
          `<form data-form="proposal-reject" data-id="${sid}">${area("Rejection reason", "reason", "", 1000)}${formEnd("Reject proposal")}</form>`,
        );
        modal.querySelector("[name=reason]").required = true;
        break;
      case "rule-toggle": {
        const r = S.automation.rules.find((r) => r.id === sid);
        showModal(
          r.enabled ? "Disable rule" : "Enable workflow rule",
          `<form data-form="rule-save" data-id="${sid}" data-enabled="${!r.enabled}"><h3>${E(r.name)}</h3><p>${E(r.description)}</p><label class="check-row"><input type="checkbox" required>I understand this applies to new events after enabling.</label>${formEnd(r.enabled ? "Disable rule" : "Enable rule")}</form>`,
        );
        break;
      }
      case "automation-run":
        await api("/automation/run", "POST", {});
        await refresh();
        renderRoute();
        toast("Pending events processed.");
        break;
      case "automation-retry":
        await api(`/automation/runs/${sid}/retry`, "POST", {});
        await refresh();
        renderRoute();
        break;
      case "connector-new":
        showModal(
          "Create scoped connector",
          `<form data-form="connector-save">${input("Connector name", "label", "", "text", true, 'maxlength="80"')}${input("Expires in days", "days", 30, "number", true, 'min="1" max="90"')}<label class="check-row"><input type="checkbox" name="read" checked>Read business records</label><label class="check-row"><input type="checkbox" name="propose">Queue proposals for review</label><label class="check-row"><input type="checkbox" name="events">Read event stream</label>${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${formEnd("Create connector")}</form>`,
        );
        break;
      case "connector-revoke":
        await api(`/automation/connectors/${sid}/revoke`, "POST", {});
        await refresh();
        renderRoute();
        toast("Connector revoked.");
        break;
      default:
        return false;
    }
    return true;
  }
  async function submit(form, b) {
    const type = form.dataset.form,
      sid = form.dataset.id;
    let result;
    if (type === "sales-save")
      result = await api(
        "/sales/opportunities" + (sid ? "/" + sid : ""),
        sid ? "PUT" : "POST",
        b,
      );
    else if (type === "sales-quote") {
      const s = get().sales.opportunities.find((o) => o.id === sid);
      result = await api("/automation/proposals", "POST", {
        kind: "quotation",
        request_key:
          form.dataset.requestKey ||
          (form.dataset.requestKey = crypto.randomUUID()),
        data: {
          client_id: s.client_id,
          opportunity_id: sid,
          issue_date: b.issue_date,
          due_date: b.due_date,
          items: [
            { description: b.description, quantity: b.quantity, rate: b.rate },
          ],
          notes: b.notes,
        },
      });
    } else if (type === "po-save")
      result = await api("/sales/customer-pos", "POST", b);
    else if (type === "quote-offline")
      result = await api(`/sales/quotes/${sid}/accept`, "POST", b);
    else if (type === "proposal-reject")
      result = await api(`/automation/proposals/${sid}/reject`, "POST", b);
    else if (type === "rule-save")
      result = await api("/automation/rules/" + sid, "PUT", {
        enabled: form.dataset.enabled === "true",
      });
    else if (type === "connector-save") {
      const scopes = [];
      if (b.read) scopes.push("business:read");
      if (b.propose) scopes.push("proposals:write");
      if (b.events) scopes.push("events:read");
      result = await api("/automation/connectors", "POST", {
        label: b.label,
        days: b.days,
        scopes,
        password: b.password,
        code: b.code,
      });
      modal.close();
      await refresh();
      renderRoute();
      showModal(
        "Save connector token",
        `<p>Shown once. Save this in the MCP host or n8n credential store. Never paste it into an AI prompt.</p>${input("Connector bearer token", "token", result.token, "text", false, "readonly")}<p>Expires ${timeLabel(result.expires)}</p>${button("Done", "close-modal", "", true)}`,
      );
      return true;
    } else if (type === "assistant-chat") {
      try {
        await api("/assistant/chat", "POST", {
          prompt: b.prompt,
          request_key: chatKey,
          consent: b.consent === "on",
        });
        chatKey = crypto.randomUUID();
        await refresh();
        renderRoute();
      } catch (e) {
        await refresh();
        renderRoute();
        toast(e.message, true);
        chatKey = crypto.randomUUID();
      }
      return true;
    } else return false;
    modal.close();
    await refresh();
    renderRoute();
    if (type === "sales-quote") {
      navigate("automation");
      toast("Quotation proposal queued for review.");
    } else toast("Saved.");
    return true;
  }
  return { sales, automation, action, submit };
}
