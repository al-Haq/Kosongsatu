import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp, proxyHops } from "../server/app.mjs";
import { today, addDays } from "../server/domain.mjs";
async function start(trustProxy) {
  const s = openDatabase(":memory:");
  await createOwner(s, "owner@example.com", "Test-only-password-28");
  const server = createApp({ store: s, appUrl: "http://localhost", trustProxy });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await new Promise((r) => server.close(r));
    s.db.close();
  };
  return { s, base, stop };
}
const badLogin = (base, xff) =>
  fetch(base + "/api/login", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      "Content-Type": "application/json",
      ...(xff ? { "X-Forwarded-For": xff } : {}),
    },
    body: JSON.stringify({ email: "owner@example.com", password: "wrong-password-123" }),
  }).then((r) => r.status);
test("TRUST_PROXY accepts true, false or a small hop count", () => {
  assert.equal(proxyHops(undefined), 0);
  assert.equal(proxyHops("false"), 0);
  assert.equal(proxyHops("true"), 1);
  assert.equal(proxyHops("2"), 2);
  assert.throws(() => proxyHops("yes"), /TRUST_PROXY/);
  assert.throws(() => proxyHops("9"), /TRUST_PROXY/);
});
test("behind a trusted proxy, rate limits follow the forwarded client address", async () => {
  const { base, stop } = await start(1);
  try {
    for (let i = 0; i < 10; i++) assert.equal(await badLogin(base, "198.51.100.7"), 401);
    assert.equal(await badLogin(base, "198.51.100.7"), 429);
    // A spoofed left-most entry does not escape the limit; the proxy-written entry decides.
    assert.equal(await badLogin(base, "203.0.113.9, 198.51.100.7"), 429);
    assert.equal(await badLogin(base, "198.51.100.8"), 401);
  } finally {
    await stop();
  }
});
test("without TRUST_PROXY, forwarded headers are ignored", async () => {
  const { base, stop } = await start(0);
  try {
    for (let i = 0; i < 10; i++) assert.equal(await badLogin(base, "198.51.100." + i), 401);
    assert.equal(await badLogin(base, "198.51.100.99"), 429);
  } finally {
    await stop();
  }
});
test("documents can be listed page by page with search", async () => {
  const { s, base, stop } = await start(0);
  try {
    s.saveSettings({ registration: "T", address: "A", email: "a@example.com" });
    const a = s.saveClient({ name: "Alpha Sdn Bhd" });
    const b = s.saveClient({ name: "Beta Enterprise" });
    for (let i = 0; i < 7; i++)
      s.saveDocument({
        kind: "invoice",
        client_id: i < 5 ? a.id : b.id,
        issue_date: today(),
        due_date: addDays(today(), 14),
        items: [{ description: "Work", quantity: "1", rate: "10.00" }],
      });
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "Test-only-password-28" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const get = (q) => fetch(base + "/api/documents?" + q, { headers: { Cookie: cookie } }).then((r) => r.json());
    const first = await get("limit=3");
    assert.equal(first.total, 7);
    assert.equal(first.items.length, 3);
    const last = await get("limit=3&offset=6");
    assert.equal(last.items.length, 1);
    assert.notEqual(last.items[0].id, first.items[0].id);
    const beta = await get("q=beta");
    assert.equal(beta.total, 2);
    assert.ok(beta.items.every((d) => d.client.name === "Beta Enterprise"));
    assert.equal((await get("state=issued")).total, 0);
    assert.equal((await fetch(base + "/api/documents")).status, 401);
  } finally {
    await stop();
  }
});
