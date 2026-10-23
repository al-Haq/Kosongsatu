// Test helpers for the tax module: a self-signed certificate built with
// node:crypto only, a fake MyInvois API, and a business/client ready for e-Invoice.
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { TAX_DEFAULTS } from "../server/tax-sst.mjs";
import { today, addDays } from "../server/domain.mjs";

const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
function oid(s) {
  const p = s.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [];
    let x = v;
    b.unshift(x & 127);
    while ((x >>= 7)) b.unshift((x & 127) | 128);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const dn = (rdns) =>
  seq(...rdns.map(([o, v]) => set(seq(oid(o), tlv(o === "2.5.4.6" ? 0x13 : 0x0c, Buffer.from(v, "utf8"))))));

// A self-signed RSA-2048 X.509 v3 certificate (no extensions).
export function selfSignedCert({ cn = "Test Signer", org = "Test Sdn Bhd", issuerCn = cn, serial = Buffer.from([0x0a, 0x1b, 0x2c, 0x3d, 0x4e]) } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algo = seq(oid("1.2.840.113549.1.1.11"), tlv(0x05, Buffer.alloc(0)));
  const subject = dn([["2.5.4.6", "MY"], ["2.5.4.10", org], ["2.5.4.3", cn]]);
  const issuer = dn([["2.5.4.6", "MY"], ["2.5.4.10", org], ["2.5.4.3", issuerCn]]);
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    algo,
    issuer,
    seq(utc(new Date(Date.now() - 86400000)), utc(new Date(Date.now() + 365 * 86400000))),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = createSign("SHA256").update(tbs).sign(privateKey);
  const der = seq(tbs, algo, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    privateKey,
    publicKey,
  };
}

// A fake MyInvois API. Records every call; refuses any host but the official ones.
export function fakeMyInvois(options = {}) {
  const calls = [];
  const docs = new Map();
  const state = { mode: "valid", tokenStatus: 200, submitStatus: 202, logins: 0, ...options };
  const reply = (status, body) =>
    new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (!/^(preprod-api|api)\.myinvois\.hasil\.gov\.my$/.test(u.hostname)) throw new Error("Unexpected host " + u.hostname);
    const call = { host: u.hostname, path: u.pathname, search: u.search, method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (u.pathname === "/connect/token") {
      state.logins++;
      if (state.tokenStatus !== 200) return reply(state.tokenStatus, { error: "invalid_client" });
      return reply(200, { access_token: "token-" + state.logins, expires_in: 3600, token_type: "Bearer", scope: "InvoicingAPI" });
    }
    if (!String(init.headers?.Authorization || "").startsWith("Bearer token-")) return reply(401, { error: "unauthorised" });
    if (u.pathname === "/api/v1.0/documentsubmissions/" && call.method === "POST") {
      if (state.mode === "network") throw new TypeError("fetch failed");
      if (state.mode === "error500") return reply(500, { error: { code: "SystemError", message: "Technical difficulties" } });
      if (state.mode === "badstructure") return reply(400, { error: { code: "BadStructure", message: "Bad structure", details: [{ code: "BadStructure", message: "Invoice line missing", target: "InvoiceLine" }] } });
      const body = JSON.parse(init.body);
      call.documents = body.documents.map((x) => ({ ...x, json: JSON.parse(Buffer.from(x.document, "base64").toString("utf8")) }));
      const submissionUid = "SUB" + randomBytes(6).toString("hex").toUpperCase();
      if (state.mode === "reject")
        return reply(202, { submissionUid, acceptedDocuments: [], rejectedDocuments: body.documents.map((x) => ({ invoiceCodeNumber: x.codeNumber, error: { code: "ValidationError", message: "Buyer TIN is not valid", details: [{ code: "CF321", message: "Buyer TIN is not valid", target: "BuyerTIN" }] } })) });
      const accepted = body.documents.map((x) => {
        const uuid = randomBytes(13).toString("hex").toUpperCase().slice(0, 26);
        docs.set(uuid, { uuid, submissionUid, internalId: x.codeNumber, status: state.mode === "invalid" ? "Invalid" : state.mode === "pending" ? "Submitted" : "Valid", longId: state.mode === "valid" ? "LONG" + randomBytes(8).toString("hex").toUpperCase() : "" });
        return { uuid, invoiceCodeNumber: x.codeNumber };
      });
      if (state.mode === "lost") throw new TypeError("socket hang up");
      return reply(202, { submissionUid, acceptedDocuments: accepted, rejectedDocuments: [] });
    }
    const sub = u.pathname.match(/^\/api\/v1\.0\/documentsubmissions\/(\w+)$/);
    if (sub) {
      const list = [...docs.values()].filter((d) => d.submissionUid === sub[1]);
      return reply(200, { submissionUid: sub[1], documentCount: list.length, overallStatus: list[0]?.status, documentSummary: list.map((d) => ({ ...d, dateTimeValidated: d.status === "Valid" ? new Date().toISOString() : null })) });
    }
    const det = u.pathname.match(/^\/api\/v1\.0\/documents\/(\w+)\/details$/);
    if (det) {
      const d = docs.get(det[1]);
      if (!d) return reply(404, { error: { code: "NotFound", message: "Not found" } });
      return reply(200, {
        ...d,
        dateTimeValidated: d.status === "Valid" ? new Date().toISOString() : null,
        validationResults: d.status === "Invalid" ? { status: "Invalid", validationSteps: [{ status: "Invalid", name: "Step03-Taxpayer Validator", error: { propertyName: "BuyerTIN", errorCode: "CF404", error: "Buyer TIN not found", innerError: [] } }] } : { status: "Valid", validationSteps: [] },
      });
    }
    const st = u.pathname.match(/^\/api\/v1\.0\/documents\/state\/(\w+)\/state$/);
    if (st && call.method === "PUT") {
      const d = docs.get(st[1]);
      if (!d) return reply(404, { error: { code: "NotFound", message: "Not found" } });
      d.status = "Cancelled";
      call.json = JSON.parse(init.body);
      return reply(200, { uuid: d.uuid, status: "Cancelled" });
    }
    if (u.pathname === "/api/v1.0/documents/recent")
      return reply(200, { result: [...docs.values()].map((d) => ({ ...d, submissionUID: d.submissionUid })), metadata: { totalCount: docs.size } });
    const tin = u.pathname.match(/^\/api\/v1\.0\/taxpayer\/validate\/(\w+)$/);
    if (tin) return tin[1] === "C25845632020" ? reply(200) : reply(404, { error: { code: "NotFound" } });
    return reply(404, { error: { code: "NotFound", message: "No route " + u.pathname } });
  };
  return { fetch, calls, docs, state };
}

// Business details and module settings complete enough for an e-Invoice.
export function readyBusiness(store, extra = {}) {
  store.saveSettings({
    registration: "202001012345",
    address: "Level 1, Kuala Lumpur",
    email: "billing@example.com",
    phone: "+60312345678",
    tin: "C25845632020",
    sstNumber: "W10-1808-32000001",
    ...extra,
  });
  store.db
    .prepare("INSERT INTO tax_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
    .run(
      JSON.stringify({
        ...TAX_DEFAULTS,
        msic: "62010",
        activity: "Computer programming activities",
        addressLines: "Level 1\nJalan Test",
        city: "Kuala Lumpur",
        postcode: "50450",
        state: "14",
      }),
    );
}
export function readyClient(store, extra = {}) {
  return store.saveClient({
    name: "Buyer Sdn Bhd " + randomBytes(3).toString("hex"),
    email: "ap@buyer.example",
    phone: "012-345 6789",
    tin: "C1234567890",
    brn: "201901234567",
    tax_fields: "1",
    tax_id_type: "BRN",
    tax_addr_lines: "No. 1, Jalan Buyer",
    tax_city: "Petaling Jaya",
    tax_postcode: "46000",
    tax_state: "10",
    tax_country: "MYS",
    ...extra,
  });
}
export const MIXED = [
  { description: "Service", quantity: "1", rate: "1000.00", tax_rate: 8 },
  { description: "Goods", quantity: "1", rate: "500.00", tax_rate: 10 },
  { description: "Exempt", quantity: "1", rate: "250.00", tax_rate: 0 },
];
export function invoice(store, client, { items = MIXED, discount = "0", issue_date = today(), ...more } = {}) {
  return store.issue(
    store.saveDocument({ kind: "invoice", client_id: client.id, issue_date, due_date: addDays(issue_date, 14), items, discount, ...more }).id,
  );
}
export function configure(store, { signing = null, env = "sandbox" } = {}) {
  store.setSecret("MYINVOIS_CLIENT_ID", "client-id");
  store.setSecret("MYINVOIS_CLIENT_SECRET", "client-secret");
  store.setSecret("MYINVOIS_ENV", env);
  if (signing) {
    store.setSecret("MYINVOIS_SIGNING_KEY", signing.keyPem);
    store.setSecret("MYINVOIS_SIGNING_CERT", signing.certPem);
  }
}
