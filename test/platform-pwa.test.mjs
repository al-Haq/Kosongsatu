import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fixture } from "./helpers.mjs";

const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test("the owner app is installable: manifest, icons and head tags", async () => {
  const f = await fixture();
  try {
    const home = await (await f.request("/")).text();
    assert.match(home, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
    assert.match(home, /apple-touch-icon/);
    const client = await (await f.request("/client/" + "a".repeat(43))).text();
    assert.ok(!client.includes("manifest"), "client links are not installable as the owner app");
    const res = await f.request("/manifest.webmanifest");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/manifest\+json/);
    const m = await res.json();
    assert.equal(m.display, "standalone");
    assert.equal(m.scope, "/");
    assert.ok(m.start_url.startsWith("/"));
    for (const need of ["192x192", "512x512"]) assert.ok(m.icons.some((i) => i.sizes === need && i.type === "image/png"), need);
    assert.ok(m.icons.some((i) => i.purpose === "maskable"));
    for (const icon of [...m.icons, { src: "/assets/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]) {
      const r = await f.request(icon.src);
      assert.equal(r.status, 200, icon.src);
      if (icon.type !== "image/png") continue;
      assert.equal(r.headers.get("content-type"), "image/png");
      const [w, h] = pngSize(Buffer.from(await r.arrayBuffer()));
      assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
    const offline = await f.request("/offline.html");
    assert.equal(offline.status, 200);
    const html = await offline.text();
    assert.ok(!/<script|style=|\son\w+=/i.test(html), "no inline script or style (CSP)");
    const sw = await f.request("/sw.mjs");
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get("content-type"), /javascript/);
  } finally {
    await f.close();
  }
});

// Runs the service worker in a sandbox with fake caches and network.
function loadWorker({ online = true } = {}) {
  const handlers = {};
  const store = new Map();
  const fetched = [];
  const cache = {
    addAll: async (list) => list.forEach((u) => store.set(new URL(u, "https://app.example").pathname, "pre:" + u)),
    put: async (req, res) => store.set(new URL(req.url).pathname, res.body),
  };
  const ctx = {
    self: { location: new URL("https://app.example/sw.mjs"), addEventListener: (t, fn) => (handlers[t] = fn), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: {
      open: async () => cache,
      keys: async () => ["nawlogic-shell-v0", "other-app"],
      delete: async (k) => (ctx.deleted = k),
      match: async (r) => store.get(typeof r === "string" ? r : new URL(r.url).pathname) || null,
    },
    fetch: async (req) => {
      fetched.push(req.url);
      if (!online) throw new TypeError("offline");
      return { ok: true, type: "basic", body: "net:" + new URL(req.url).pathname, clone() { return this; } };
    },
    Response: { error: () => "error" },
    URL,
    Promise,
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.mjs", import.meta.url), "utf8"), ctx);
  const dispatch = async (path, { mode = "no-cors", method = "GET" } = {}) => {
    let responded = null;
    const event = { request: { url: "https://app.example" + path, method, mode }, respondWith: (p) => (responded = p) };
    handlers.fetch(event);
    if (!responded) return undefined;
    const r = await responded;
    return typeof r === "object" && r ? r.body : r;
  };
  return { handlers, store, fetched, dispatch, ctx, setOnline: (v) => (online = v) };
}

test("the service worker caches the app shell only, never API data or client documents", async () => {
  const w = loadWorker();
  await new Promise((r) => w.handlers.install({ waitUntil: (p) => p.then(r) }));
  assert.ok(w.store.has("/offline.html") && w.store.has("/app.css"), "offline page and shell precached");
  await new Promise((r) => w.handlers.activate({ waitUntil: (p) => p.then(r) }));
  assert.equal(w.ctx.deleted, "nawlogic-shell-v0", "old shell caches removed, other caches kept");
  for (const path of ["/api/workspace", "/api/public/" + "a".repeat(43), "/api/public/x/pdf", "/api/documents/1/pdf", "/api/files/abc"])
    assert.equal(await w.dispatch(path), undefined, path + " is left to the network");
  assert.equal(await w.dispatch("/app.mjs", { method: "POST" }), undefined);
  assert.equal(await w.dispatch("/app.mjs?v=1"), undefined, "URLs with a query are left alone");
  assert.ok(!w.store.has("/app.mjs"));
  // Pages are fetched, never stored.
  assert.equal(await w.dispatch("/client/" + "b".repeat(43), { mode: "navigate" }), "net:/client/" + "b".repeat(43));
  assert.equal(await w.dispatch("/", { mode: "navigate" }), "net:/");
  assert.ok(![...w.store.keys()].some((k) => k.startsWith("/client") || k === "/"));
  // Shell assets: network first, stored for offline use.
  assert.equal(await w.dispatch("/ext/platform.mjs"), "net:/ext/platform.mjs");
  assert.equal(await w.dispatch("/assets/fonts/DejaVuSans.ttf"), "net:/assets/fonts/DejaVuSans.ttf");
  assert.ok(w.store.has("/ext/platform.mjs") && w.store.has("/assets/fonts/DejaVuSans.ttf"));
  assert.equal(await w.dispatch("/offline.html"), undefined, "other files are not intercepted");
  assert.equal(await w.dispatch("/sw.mjs"), undefined);
  // Offline: pages show the offline page; shell comes from the cache.
  w.setOnline(false);
  assert.equal(await w.dispatch("/client/" + "c".repeat(43), { mode: "navigate" }), "pre:/offline.html");
  assert.equal(await w.dispatch("/ext/platform.mjs"), "net:/ext/platform.mjs");
  assert.equal(await w.dispatch("/ext/missing.mjs"), "error");
  assert.equal(await w.dispatch("/api/workspace"), undefined, "API still untouched offline");
  assert.equal(w.fetched.filter((u) => u.includes("/api/")).length, 0, "the worker never fetched API data itself");
});
