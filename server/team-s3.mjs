// Minimal S3-compatible client for off-site backups: AWS Signature Version 4
// with node:crypto, no SDK. Works with AWS S3, Cloudflare R2, Backblaze B2,
// Wasabi, DigitalOcean Spaces and MinIO.
import { createHash, createHmac } from "node:crypto";
import { AppError, check } from "./domain.mjs";

export const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as SigV4 requires: only A-Z a-z 0-9 - _ . ~ stay literal.
export function uriEncode(value, keepSlash = false) {
  let out = "";
  for (const byte of Buffer.from(String(value), "utf8")) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

const amzDate = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Signs a request and returns the headers to send (without Host, which fetch
// derives from the URL). `path` is the raw, unencoded path; S3 encodes each
// segment once. `query` is a plain object of raw values.
export function signV4({
  method,
  host,
  path = "/",
  query = {},
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region,
  service = "s3",
  date = new Date(),
}) {
  const stamp = amzDate(date),
    day = stamp.slice(0, 8);
  const all = { ...headers, host, "x-amz-date": stamp };
  if (service === "s3") all["x-amz-content-sha256"] = payloadHash;
  if (sessionToken) all["x-amz-security-token"] = sessionToken;
  const lower = Object.entries(all).map(([k, v]) => [
    k.toLowerCase(),
    String(v).trim().replace(/\s+/g, " "),
  ]);
  lower.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = lower.map(([k]) => k).join(";");
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v ?? "")])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    method,
    uriEncode(path, true),
    canonicalQuery,
    lower.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const out = Object.fromEntries(lower.filter(([k]) => k !== "host"));
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, signature, canonicalRequest, stringToSign };
}

// Validated storage settings. Without an endpoint, AWS S3 is used.
export function storageConfig(get) {
  const bucket = get("BACKUP_S3_BUCKET"),
    accessKeyId = get("BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey = get("BACKUP_S3_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const region = (get("BACKUP_S3_REGION") || "us-east-1").trim();
  check(/^[a-z0-9-]{2,40}$/.test(region), "Off-site backup region is invalid (for example ap-southeast-1, or auto for Cloudflare R2).");
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(bucket.trim()), "Off-site backup bucket name is invalid.");
  let prefix = (get("BACKUP_S3_PREFIX") ?? "nawlogic/").trim().replace(/^\/+/, "");
  check(/^[\w./-]{0,200}$/.test(prefix) && !prefix.includes(".."), "Off-site backup folder (prefix) may use letters, numbers, - _ . and /.");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const keepRaw = get("BACKUP_S3_KEEP");
  const keep = keepRaw ? Number(keepRaw) : 30;
  check(Number.isInteger(keep) && keep >= 1 && keep <= 365, "Off-site copies to keep must be a whole number from 1 to 365.");
  const endpointRaw = (get("BACKUP_S3_ENDPOINT") || "").trim();
  let endpoint = null;
  if (endpointRaw) {
    let u;
    try {
      u = new URL(endpointRaw);
    } catch {
      throw new AppError("Off-site backup endpoint must be a URL such as https://<account>.r2.cloudflarestorage.com.");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    check(u.protocol === "https:" || (u.protocol === "http:" && loopback), "Off-site backup endpoint must use HTTPS.");
    check(!u.username && !u.password && !u.search && !u.hash, "Off-site backup endpoint must not include credentials or a query.");
    endpoint = u.origin + u.pathname.replace(/\/+$/, "");
  }
  return {
    endpoint,
    region,
    bucket: bucket.trim(),
    prefix,
    keep,
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
  };
}

// Where an object lives: path-style on custom endpoints, virtual-hosted on AWS.
export function objectLocation(cfg, key = "") {
  if (cfg.endpoint) {
    const u = new URL(cfg.endpoint);
    const base = u.pathname.replace(/\/+$/, "");
    return { origin: u.origin, host: u.host, path: `${base}/${cfg.bucket}${key ? "/" + key : ""}` };
  }
  const host = cfg.bucket.includes(".")
    ? `s3.${cfg.region}.amazonaws.com`
    : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const path = cfg.bucket.includes(".") ? `/${cfg.bucket}${key ? "/" + key : ""}` : `/${key}`;
  return { origin: `https://${host}`, host, path };
}

const xmlValue = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
const unxml = (s) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

export class S3Client {
  constructor(cfg, { fetch = globalThis.fetch, now = () => new Date() } = {}) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.now = now;
  }
  async request(method, key, { query = {}, body = null, contentType, timeout = 60000 } = {}) {
    const loc = objectLocation(this.cfg, key);
    const payloadHash = body ? sha256(body) : EMPTY_SHA256;
    const { headers } = signV4({
      method,
      host: loc.host,
      path: loc.path,
      query,
      headers: contentType ? { "content-type": contentType } : {},
      payloadHash,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      date: this.now(),
    });
    const qs = Object.entries(query)
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v ?? "")}`)
      .join("&");
    const url = loc.origin + uriEncode(loc.path, true) + (qs ? "?" + qs : "");
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new AppError("Could not reach the off-site storage. Check the endpoint and region.", 502);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const code = xmlValue(text, "Code");
      const message = xmlValue(text, "Message");
      throw new AppError(
        `Off-site storage refused the request (${res.status}${code ? " " + unxml(code) : ""}${message ? ": " + unxml(message).slice(0, 160) : ""}).`,
        502,
      );
    }
    return res;
  }
  async put(key, body, contentType = "application/octet-stream") {
    const res = await this.request("PUT", key, { body, contentType, timeout: 10 * 60000 });
    return { etag: res.headers.get("etag") };
  }
  async get(key) {
    const res = await this.request("GET", key, { timeout: 10 * 60000 });
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key) {
    await this.request("DELETE", key);
  }
  // Lists objects under a prefix (ListObjectsV2), following continuation tokens.
  async list(prefix = this.cfg.prefix) {
    const out = [];
    let token = null;
    for (let page = 0; page < 50; page++) {
      const query = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.request("GET", "", { query })).text();
      for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
        out.push({
          key: unxml(xmlValue(item, "Key") || ""),
          size: Number(xmlValue(item, "Size") || 0),
          modified: xmlValue(item, "LastModified"),
        });
      if (xmlValue(xml, "IsTruncated") !== "true") break;
      token = xmlValue(xml, "NextContinuationToken");
      if (!token) break;
      token = unxml(token);
    }
    return out;
  }
}
