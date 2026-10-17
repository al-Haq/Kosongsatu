// Example records for the demo workspace (npm run demo): a proforma, a quotation
// with a deposit, a sales order with its delivery order, a USD invoice with line
// discounts and an invoice paid in instalments.
export function seedDocumentsDemo(store, { today, addDays }) {
  const clients = store.db.prepare("SELECT * FROM clients ORDER BY created,name").all();
  if (clients.length < 3 || store.db.prepare("SELECT 1 FROM documents WHERE kind!='invoice' AND kind!='quote'").get()) return;
  const [a, b, c] = clients;
  store.saveSettings({ customFields: [{ label: "Project code", applies: "all", show: "pdf" }] });
  const project = store.settings().customFields[0].id;
  const ap = store.saveService({ name: "Wi-Fi access point", rate: "650.00", unit: "Unit", sku: "AP-AX1800" });
  const notes = "Demonstration document. No real work or payment is represented.";
  const doc = (client, kind, items, extra = {}) =>
    store.saveDocument({
      kind,
      client_id: client.id,
      issue_date: today(),
      due_date: addDays(today(), kind === "delivery_order" ? 0 : 14),
      items,
      notes,
      ...extra,
    });
  const network = [
    { description: "Wi-Fi access point", quantity: 4, rate: "650.00", service_id: ap.id, discount_percent: "5" },
    { description: "Network installation", quantity: 8, rate: "120.00", unit: "Hour" },
  ];
  store.issue(doc(b, "proforma", network, { custom: { [project]: "RIMBA-NET" } }).id);
  const q = store.issue(
    doc(a, "quote", [{ description: "Customer portal build", quantity: 1, rate: "9000.00" }], {
      deposit: { type: "percent", value: "30" },
      custom: { [project]: "MERANTI-PORTAL" },
    }).id,
  );
  store.acceptOffline(q.id, { name: "Aina (Demo)", evidence: "Signed quotation (demo)" });
  store.issue(store.createDepositInvoice(q.id).id);
  const so = store.issue(doc(c, "sales_order", network).id);
  store.deriveDocument(so.id, "delivery_order");
  store.issue(
    doc(c, "invoice", [{ description: "Design system licence", quantity: 2, rate: "800.00", discount_amount: "100.00" }], {
      currency: "USD",
      fx_rate: "4.45",
    }).id,
  );
  const plan = store.issue(doc(b, "invoice", [{ description: "Annual support plan", quantity: 1, rate: "3600.00" }]).id);
  store.setInstalments(plan.id, [
    { due_date: addDays(today(), 14), amount: "1200.00" },
    { due_date: addDays(today(), 44), amount: "1200.00" },
    { due_date: addDays(today(), 74), amount: "1200.00" },
  ]);
}
