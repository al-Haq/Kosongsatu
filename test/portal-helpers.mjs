// Helpers shared by the portal tests (not a test file itself).
import { deflateSync, crc32 } from "node:zlib";
import { fixture } from "./helpers.mjs";
import { today, addDays } from "../server/domain.mjs";

export const mailConfig = { from: "billing@example.com" };
export function fakeTransport({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      if (fail) throw new Error("550 rejected");
      sent.push(m);
      return { messageId: "<" + sent.length + "@test>" };
    },
  };
}
// A signed-in owner with email working through a fake transport.
export async function mailFixture(options = {}) {
  const transport = fakeTransport();
  const f = await fixture({ ...options, app: { mailConfig, mailTransport: transport, ...(options.app || {}) } });
  return { ...f, transport };
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};
// Builds a PNG. ink(x, y) decides which pixels are dark; the rest is transparent
// (RGBA) or white (RGB/grey). extra: chunks inserted before IDAT.
export function makePng(width = 600, height = 200, { ink = signatureInk, color = 6, depth = 8, interlace = 0, extra = [], idat = null, filter = 0 } = {}) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color] || 1;
  const rows = [];
  let prev = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width; x++) {
      const dark = ink(x, y);
      const o = 1 + x * channels;
      if (color === 6) [row[o], row[o + 1], row[o + 2], row[o + 3]] = dark ? [15, 23, 42, 255] : [0, 0, 0, 0];
      else if (color === 2) [row[o], row[o + 1], row[o + 2]] = dark ? [15, 23, 42] : [255, 255, 255];
      else if (color === 4) [row[o], row[o + 1]] = dark ? [20, 255] : [0, 0];
      else row[o] = dark ? 20 : 255;
    }
    // Encode the row with the requested PNG filter (0 none, 1 sub, 2 up, 3 average, 4 paeth).
    const raw = row.subarray(1),
      out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const a = i >= channels ? raw[i - channels] : 0,
        b = prev[i],
        c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      out[i] = (raw[i] - predict) & 0xff;
    }
    prev = Buffer.from(raw);
    rows.push(Buffer.concat([Buffer.from([filter]), out]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra.map(([t, d]) => chunk(t, Buffer.from(d))),
    chunk("IDAT", idat || deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// A wavy stroke across the pad, like a quick signature.
export const signatureInk = (x, y) => x > 40 && x < 560 && Math.abs(y - (100 + 40 * Math.sin(x / 30))) < 2.5;
export const signatureData = (png = makePng()) => "data:image/png;base64," + png.toString("base64");

// A client with the portal on and one contact allowed to sign in.
export async function portalClient(f, { name = "Portal client " + Math.random().toString(36).slice(2, 7), email } = {}) {
  email ||= `siti.${Math.random().toString(36).slice(2, 7)}@client.example`;
  const client = f.store.saveClient({ name, contact: "Siti", email });
  const primary = f.store.contacts(client.id)[0];
  await f.json(`/api/portal/contacts/${primary.id}`, "PUT", { portal_access: true });
  await f.json(`/api/portal/clients/${client.id}/portal`, "PUT", { enabled: true });
  return { client, contact: f.store.contact(primary.id), email };
}
// Guest requests with the portal cookie and CSRF token once signed in.
export function guest(f) {
  const g = {
    cookie: "",
    csrf: "",
    async call(path, method = "GET", body, headers = {}) {
      return f.request("/api/guest/portal" + path, {
        method,
        headers: {
          ...(g.cookie ? { Cookie: g.cookie } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(g.csrf && method !== "GET" ? { "X-Portal-CSRF": g.csrf } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
    async json(path, method = "GET", body) {
      const res = await g.call(path, method, body);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
      return data;
    },
    // Exchanges a sign-in or access token for a session.
    async exchange(token, kind = "verify") {
      const res = await g.call("/" + kind, "POST", { token });
      if (res.ok) {
        g.cookie = res.headers.get("set-cookie").split(";")[0];
        g.csrf = (await res.json()).csrf;
      }
      return res;
    },
  };
  return g;
}
// Requests a sign-in link by email and returns the token from the message.
export async function emailedToken(f, email) {
  const before = f.transport.sent.length;
  const res = await f.request("/api/guest/portal/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await f.server.ctx.services.portal.idle();
  const mail = f.transport.sent.slice(before).at(-1);
  return { res, mail, token: mail?.text.match(/\/portal\/login\/([\w-]{43})/)?.[1] };
}
export async function signedIn(f, email) {
  const g = guest(f);
  const { token } = await emailedToken(f, email);
  await g.exchange(token);
  return g;
}
// Issued documents of each kind for one client.
export function issued(store, client, { kind = "invoice", rate = "100.00", issue = today(), due = addDays(today(), 14) } = {}) {
  const d = store.saveDocument({
    kind,
    client_id: client.id,
    issue_date: issue,
    due_date: due,
    items: [{ description: "Work", quantity: 1, rate }],
  });
  return store.issue(d.id);
}
export const pay = (store, d, amount = (d.balance / 100).toFixed(2), reference = "PAY-" + Math.random().toString(36).slice(2, 8)) =>
  store.recordPayment(d.id, { amount, paid_date: today(), method: "Bank transfer", reference });
