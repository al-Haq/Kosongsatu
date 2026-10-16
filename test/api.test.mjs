import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { today, addDays } from "../server/domain.mjs";
const password = "Test-only-password-28";
async function fixture() {
  const store = openDatabase(":memory:");
  store.saveSettings({
    registration: "TEST-001",
    address: "Test office",
    email: "billing@example.com",
  });
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

test("financial HTTP retries return the same receipt, reject conflicts and expose owner-only notes", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "HTTP customer" });
    const d = f.store.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Support", quantity: 1, rate: 100 }],
    });
    f.store.issue(d.id);
    const send = (payload) =>
      f.request("/api/receipts", {
        method: "POST",
        headers: {
          Cookie: f.cookie,
          "X-CSRF-Token": f.session.csrf,
          "Content-Type": "application/json",
          "Idempotency-Key": "http-receipt-test-000001",
        },
        body: JSON.stringify(payload),
      });
    const payload = {
      client_id: c.id,
      amount: 100,
      paid_date: today(),
      method: "Bank transfer",
      reference: "HTTP-1",
    };
    const first = await send(payload);
    assert.equal(first.status, 201);
    const r = await first.json();
    assert.equal((await (await send(payload)).json()).id, r.id);
    assert.equal((await send({ ...payload, amount: 90 })).status, 409);
    assert.equal(f.store.receipts().length, 1);
    await f.auth(`/api/receipts/${r.id}/allocate`, "POST", {
      invoice_id: d.id,
      amount: 100,
    });
    const note = await (
      await f.auth(`/api/documents/${d.id}/adjustments`, "POST", {
        kind: "credit",
        amount: 20,
        reason: "Reduced scope",
      })
    ).json();
    assert.equal(
      (await f.auth(`/api/adjustments/${note.id}/pdf`)).headers.get(
        "content-type",
      ),
      "application/pdf",
    );
    assert.equal(
      (await f.request(`/api/adjustments/${note.id}/pdf`)).status,
      401,
    );
    assert.equal(f.store.receipt(r.id).available, 2000);
    const link = f.store.share(d.id, 1);
    const pub = await (await f.request("/api/public/" + link.token)).json();
    assert.equal(pub.adjusted_total, 8000);
    assert.equal(pub.balance, 0);
    assert.equal(pub.adjustments.length, 1);
    assert.equal(pub.finance, undefined);
    assert.equal(pub.payments, undefined);
    const exported = await (await f.auth("/api/backup")).json();
    assert.equal(exported.schemaVersion, 6);
    assert.equal(exported.security, undefined);
    assert.equal(exported.finance.receipts.length, 1);
    assert.ok(!JSON.stringify(exported).includes("mfa_secret"));
  } finally {
    await f.close();
  }
});
test("HTTP MFA requires password and a second factor; recovery codes are one-use and password changes respect MFA", async () => {
  const { totp } = await import("../server/mfa.mjs");
  const f = await fixture();
  try {
    assert.equal(
      (await f.auth("/api/mfa/begin", "POST", { password: "incorrect" }))
        .status,
      403,
    );
    const setup = await (
      await f.auth("/api/mfa/begin", "POST", { password })
    ).json();
    const response = await f.auth("/api/mfa/enable", "POST", {
      password,
      code: totp(setup.secret),
    });
    assert.equal(response.status, 200);
    const { codes } = await response.json();
    assert.equal((await f.auth("/api/mfa/status")).status, 200);
    const login = (code) =>
      f.request("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password, code }),
      });
    assert.equal((await login()).status, 401);
    assert.equal((await login(codes[0])).status, 200);
    assert.equal((await login(codes[0])).status, 401);
    assert.equal(
      (
        await f.auth("/api/password", "POST", {
          current: password,
          password: "Updated-test-password-123",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.auth("/api/mfa/disable", "POST", { password, code: "wrong" }))
        .status,
      403,
    );
    assert.equal(
      (await f.auth("/api/mfa/disable", "POST", { password, code: codes[1] }))
        .status,
      200,
    );
    assert.equal((await login()).status, 200);
  } finally {
    await f.close();
  }
});
test("malformed static URLs return 404, not a server error", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/%")).status, 404);
    assert.equal((await f.request("/assets/%E0%A4%A")).status, 404);
  } finally {
    await f.close();
  }
});
