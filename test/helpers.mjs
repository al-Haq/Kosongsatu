// Shared test fixture: an in-memory workspace with a signed-in owner.
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { today, addDays } from "../server/domain.mjs";
export const password = "Test-only-password-28";
export async function fixture(options = {}) {
  const store = options.store || openDatabase(":memory:");
  store.saveSettings({
    registration: "TEST-001",
    address: "Test office",
    email: "billing@example.com",
    ...(options.settings || {}),
  });
  await createOwner(store, "owner@example.com", password);
  const server = createApp({
    store,
    appUrl: "http://localhost",
    mailConfig: null,
    gatewayConfig: null,
    assistantConfig: null,
    ...(options.app || {}),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: { Origin: "http://localhost", ...init.headers },
    });
  const login = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password }),
  });
  const session = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  // Owner request with JSON body (or a Buffer/Uint8Array sent raw).
  const auth = (path, method = "GET", body, headers = {}) =>
    request(path, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": session.csrf,
        ...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
    });
  const json = async (path, method = "GET", body) => {
    const res = await auth(path, method, body);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
    return data;
  };
  const close = async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
  };
  return { store, server, base, request, auth, json, session, cookie, close };
}
// A client and an issued invoice for it.
export function issuedInvoice(store, { rate = "100.00", client = null, days = 14, items = null } = {}) {
  const c = client || store.saveClient({ name: "Test client " + Math.random().toString(36).slice(2, 7), email: "client@example.com" });
  const d = store.saveDocument({
    kind: "invoice",
    client_id: c.id,
    issue_date: today(),
    due_date: addDays(today(), days),
    items: items || [{ description: "Work", quantity: 1, rate }],
  });
  return { client: c, invoice: store.issue(d.id) };
}
// Smallest valid PNG (1x1 transparent).
export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  "base64",
);
