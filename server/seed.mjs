import { today, addDays } from "./domain.mjs";
export function seedDemo(store) {
  if (store.db.prepare("SELECT id FROM clients LIMIT 1").get()) return;
  const settings = store.settings();
  settings.demo = true;
  store.db
    .prepare("UPDATE settings SET data=? WHERE id=1")
    .run(JSON.stringify(settings));
  const a = store.saveClient({
    name: "Meranti Digital (Demo)",
    contact: "Aina",
    email: "billing@meranti.example",
    terms: 14,
  });
  const b = store.saveClient({
    name: "Rimba Retail (Demo)",
    email: "hello@rimba.example",
    terms: 14,
  });
  const c = store.saveClient({
    name: "Bayu Design (Demo)",
    email: "finance@bayu.example",
    terms: 14,
  });
  const services = [
    ["Systems integration", 3000, "Project"],
    ["Workflow automation", 1200, "Project"],
    ["Cloud setup", 800, "Project"],
    ["Managed maintenance", 750, "Month"],
    ["Technical consulting", 200, "Hour"],
  ].map(([name, rate, unit]) => store.saveService({ name, rate, unit }));
  const draft = (client, items, due = 14, kind = "invoice") =>
    store.saveDocument({
      kind,
      client_id: client.id,
      issue_date: addDays(today(), Math.min(0, due - 14)),
      due_date: addDays(today(), due),
      items,
      notes: "Demonstration document. No real work or payment is represented.",
    });
  const d = draft(
    a,
    services
      .slice(0, 3)
      .map((s) => ({
        description: s.name,
        quantity: 1,
        rate: (s.rate / 100).toFixed(2),
      })),
  );
  store.issue(d.id);
  store.recordPayment(d.id, {
    amount: 2000,
    paid_date: today(),
    method: "Bank transfer",
    reference: "DEMO-PAY-015",
  });
  const overdue = draft(
    b,
    [{ description: "Workflow automation", quantity: 1, rate: 1200 }],
    -3,
  );
  store.issue(overdue.id);
  const paid = draft(
    c,
    [{ description: "Technical consulting", quantity: 5, rate: 200 }],
    7,
  );
  store.issue(paid.id);
  store.recordPayment(paid.id, {
    amount: 1000,
    paid_date: today(),
    method: "Bank transfer",
    reference: "DEMO-PAID-001",
  });
  draft(a, [{ description: "Managed maintenance", quantity: 1, rate: 750 }]);
  const q = draft(
    a,
    [{ description: "Workflow automation project", quantity: 1, rate: 1200 }],
    14,
    "quote",
  );
  store.issue(q.id);
  store.saveSchedule({
    client_id: b.id,
    service_id: services[3].id,
    next_date: today(),
    terms: 14,
  });
}
