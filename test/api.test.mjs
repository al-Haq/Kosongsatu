import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { today, addDays } from "../server/domain.mjs";
const password = "Test-only-password-28";
async function fixture() {
  const store = openDatabase(":memory:");
  await createOwner(store, "owner@example.com", password);
  const server = createApp({ store, appUrl: "http://localhost" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: { Origin: "http://localhost", ...options.headers },
    });
  const login = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password }),
  });
  const session = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const auth = (path, method = "GET", body) =>
    request(path, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": session.csrf,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const close = async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
  };
  return { store, request, auth, session, cookie, close };
}
test("owner routes require authentication; CSRF and origin are enforced", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/workspace")).status, 401);
    assert.equal((await f.auth("/api/workspace")).status, 200);
    assert.equal(
      (
        await f.request("/api/settings", {
          method: "PUT",
          headers: { Cookie: f.cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/settings", {
          method: "PUT",
          headers: {
            Origin: "https://evil.example",
            Cookie: f.cookie,
            "X-CSRF-Token": f.session.csrf,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await f.request("/server/db.mjs")).status, 404);
    assert.equal((await f.request("/api/nope")).status, 401);
  } finally {
    await f.close();
  }
});
test("complete client to invoice to receipt; public view is scoped and revocable", async () => {
  const f = await fixture();
  try {
    const c = await (
      await f.auth("/api/clients", "POST", {
        name: "Client A",
        email: "a@example.com",
      })
    ).json();
    const saved = await f.auth("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Integration", quantity: 1, rate: "5000.00" }],
    });
    assert.equal(saved.status, 201);
    const d = await saved.json();
    assert.equal(
      (await f.auth(`/api/documents/${d.id}/issue`, "POST", {})).status,
      200,
    );
    const link = await (
      await f.auth(`/api/documents/${d.id}/share`, "POST", {})
    ).json();
    const token = link.url.split("/").pop();
    const response = await f.request("/api/public/" + token);
    assert.equal(response.status, 200);
    const pub = await response.json();
    assert.equal(pub.total, 500000);
    assert.equal(pub.token_hash, undefined);
    assert.equal(pub.payments, undefined);
    assert.equal(pub.audit, undefined);
    const proof = await f.request(
      "/api/public/" + token + "/payment-reference",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: "P-1" }),
      },
    );
    assert.equal(proof.status, 201);
    const payment = await f.auth(`/api/documents/${d.id}/payments`, "POST", {
      amount: 2000,
      paid_date: today(),
      method: "Bank transfer",
      reference: "P-1",
    });
    assert.equal(payment.status, 201);
    const p = await payment.json();
    assert.equal(
      (await (await f.auth(`/api/documents/${d.id}`)).json()).balance,
      300000,
    );
    const pdf = await f.request("/api/public/" + token + "/pdf");
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    const receipt = await f.auth(`/api/payments/${p.id}/receipt`);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.headers.get("content-type"), "application/pdf");
    await f.auth(`/api/documents/${d.id}/revoke`, "POST", {});
    assert.equal((await f.request("/api/public/" + token)).status, 404);
  } finally {
    await f.close();
  }
});
test("XSS remains data and CSV formula cells are neutralized", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: '=HYPERLINK("evil")', email: "" });
    const d = f.store.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [
        { description: "<script>alert(1)</script>", quantity: 1, rate: 10 },
      ],
    });
    f.store.issue(d.id);
    const csv = await (await f.auth("/api/invoices.csv")).text();
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.equal(
      (await f.auth("/api/workspace")).headers
        .get("content-security-policy")
        .includes("script-src 'self'"),
      true,
    );
  } finally {
    await f.close();
  }
});
test("logout invalidates session", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.auth("/api/logout", "POST", {})).status, 200);
    assert.equal((await f.auth("/api/workspace")).status, 401);
  } finally {
    await f.close();
  }
});
test("password change revokes sessions and old password", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.auth("/api/password", "POST", {
          current: password,
          password: "New-test-only-password-29",
        })
      ).status,
      200,
    );
    assert.equal((await f.auth("/api/workspace")).status, 401);
    const r = await f.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password }),
    });
    assert.equal(r.status, 401);
  } finally {
    await f.close();
  }
});
