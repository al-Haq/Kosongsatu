import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { signV4, storageConfig, objectLocation } from "../server/team-s3.mjs";
import { restoreBackup } from "../server/recovery.mjs";
import { fixture, password } from "./helpers.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");

test("SigV4 matches AWS's published test suite and S3 examples", () => {
  // aws-sig-v4-test-suite (get-vanilla, get-vanilla-query-order-key-case, post-x-www-form-urlencoded).
  const suite = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    host: "example.amazonaws.com",
    date: new Date("2015-08-30T12:36:00Z"),
  };
  const vanilla = signV4({ ...suite, method: "GET" });
  assert.equal(vanilla.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(
    vanilla.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
  assert.equal(
    signV4({ ...suite, method: "GET", query: { Param2: "value2", Param1: "value1" } }).signature,
    "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  );
  const form = signV4({
    ...suite,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    payloadHash: sha("Param1=value1"),
  });
  assert.equal(form.signature, "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
  // Amazon S3 "Signature Calculations for the Authorization Header" examples.
  const s3 = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    host: "examplebucket.s3.amazonaws.com",
    date: new Date("2013-05-24T00:00:00Z"),
  };
  assert.equal(
    signV4({ ...s3, method: "GET", path: "/test.txt", headers: { Range: "bytes=0-9" } }).signature,
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  const put = signV4({
    ...s3,
    method: "PUT",
    path: "/test$file.text",
    headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash: sha("Welcome to Amazon S3."),
  });
  assert.equal(put.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  assert.match(put.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
  assert.equal(
    signV4({ ...s3, method: "GET", query: { lifecycle: "" } }).signature,
    "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  );
  assert.equal(
    signV4({ ...s3, method: "GET", query: { "max-keys": "2", prefix: "J" } }).signature,
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

test("storage settings are validated and addressed per provider", () => {
  const cfg = (o) => storageConfig((n) => ({ BACKUP_S3_BUCKET: "nwl-backups", BACKUP_S3_ACCESS_KEY_ID: "AK", BACKUP_S3_SECRET_ACCESS_KEY: "SK", ...o })[n] ?? null);
  assert.equal(storageConfig(() => null), null, "not configured without bucket and keys");
  const aws = cfg({ BACKUP_S3_REGION: "ap-southeast-1" });
  assert.deepEqual([aws.prefix, aws.keep, aws.endpoint], ["nawlogic/", 30, null]);
  assert.equal(objectLocation(aws, "nawlogic/a.nwlbackup").origin, "https://nwl-backups.s3.ap-southeast-1.amazonaws.com");
  assert.equal(objectLocation(aws, "nawlogic/a.nwlbackup").path, "/nawlogic/a.nwlbackup");
  const r2 = cfg({ BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", BACKUP_S3_REGION: "auto", BACKUP_S3_PREFIX: "/office", BACKUP_S3_KEEP: "7" });
  assert.deepEqual([r2.prefix, r2.keep, r2.region], ["office/", 7, "auto"]);
  assert.equal(objectLocation(r2, "office/x").path, "/nwl-backups/office/x", "path-style on custom endpoints");
  assert.equal(objectLocation(cfg({ BACKUP_S3_BUCKET: "dotted.bucket" }), "k").host, "s3.us-east-1.amazonaws.com");
  assert.throws(() => cfg({ BACKUP_S3_ENDPOINT: "http://storage.example.com" }), /HTTPS/);
  assert.ok(cfg({ BACKUP_S3_ENDPOINT: "http://127.0.0.1:9000" }), "local MinIO over http is allowed");
  assert.throws(() => cfg({ BACKUP_S3_ENDPOINT: "https://user:pw@storage.example.com" }), /credentials/);
  assert.throws(() => cfg({ BACKUP_S3_BUCKET: "bad bucket" }), /bucket/);
  assert.throws(() => cfg({ BACKUP_S3_REGION: "Asia Pacific" }), /region/);
  assert.throws(() => cfg({ BACKUP_S3_KEEP: "0" }), /1 to 365/);
  assert.throws(() => cfg({ BACKUP_S3_PREFIX: "../escape" }), /prefix/);
});

// A tiny S3 imitation that checks every request's signature.
function fakeS3({ fail } = {}) {
  const objects = new Map(),
    calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const h = init.headers;
    const body = init.body ? Buffer.from(init.body) : null;
    calls.push({ method: init.method, url: u, headers: h });
    const expected = signV4({
      method: init.method,
      host: u.host,
      path: decodeURIComponent(u.pathname),
      query: Object.fromEntries(u.searchParams),
      headers: h["content-type"] ? { "content-type": h["content-type"] } : {},
      payloadHash: body ? sha(body) : sha(""),
      accessKeyId: "AKTEST",
      secretAccessKey: "sk-test-secret",
      region: "auto",
      date: new Date(h["x-amz-date"].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")),
    });
    assert.equal(h.authorization, expected.headers.authorization, "signature checks out");
    assert.equal(h["x-amz-content-sha256"], body ? sha(body) : sha(""));
    if (fail?.(init.method, u)) return new Response("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 });
    const [, bucket, ...rest] = decodeURIComponent(u.pathname).split("/");
    assert.equal(bucket, "nwl-backups");
    const key = rest.join("/");
    if (init.method === "PUT") {
      objects.set(key, { body, modified: new Date().toISOString() });
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (init.method === "GET" && !key) {
      const prefix = u.searchParams.get("prefix") || "";
      const items = [...objects].filter(([k]) => k.startsWith(prefix));
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><LastModified>${o.modified}</LastModified></Contents>`).join("")}</ListBucketResult>`,
        { status: 200 },
      );
    }
    if (init.method === "GET") {
      const o = objects.get(key);
      return o ? new Response(o.body, { status: 200 }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    }
    return new Response("", { status: 400 });
  };
  return { fetch, objects, calls };
}

async function setup(f, dir, { keep = "2" } = {}) {
  f.server.backups.directory = dir;
  for (const [k, v] of Object.entries({
    BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    BACKUP_S3_REGION: "auto",
    BACKUP_S3_BUCKET: "nwl-backups",
    BACKUP_S3_ACCESS_KEY_ID: "AKTEST",
    BACKUP_S3_SECRET_ACCESS_KEY: "sk-test-secret",
    BACKUP_S3_KEEP: keep,
  }))
    f.store.setSecret(k, v);
}

test("the owner generates a backup key once in Settings; it is stored encrypted", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "nwl-team-backup-"));
  try {
    assert.equal((await f.json("/api/workspace")).backupStatus.configured, false);
    f.server.backups.directory = dir;
    assert.equal((await f.auth("/api/team/backup/key", "POST", { password: "wrong" })).status, 403);
    const made = await f.json("/api/team/backup/key", "POST", { password });
    assert.match(made.key, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(made.configured, true);
    assert.equal((await f.auth("/api/team/backup/key", "POST", { password })).status, 409, "shown once, never again");
    const raw = f.store.db.prepare("SELECT value FROM secrets WHERE name='BACKUP_KEY'").get().value;
    assert.ok(!raw.includes(made.key) && !Buffer.from(raw, "base64").toString().includes(made.key));
    const ws = await f.json("/api/workspace");
    assert.equal(ws.backupStatus.configured, true);
    assert.equal(ws.backupStatus.keySource, "app");
    assert.equal(ws.ext.team.backup.keySource, "app");
    assert.ok(!JSON.stringify(ws).includes(made.key), "the key never comes back");
    const out = await f.json("/api/recovery/backup", "POST", {});
    assert.match(out.filename, /^nawlogic-.*\.nwlbackup$/);
    assert.equal(out.remote, undefined, "no off-site copy without storage settings");
    // Restorable with the generated key.
    const restored = await restoreBackup(join(dir, out.filename), join(dir, "restored.sqlite"), made.key);
    assert.equal(restored.sessionsRevoked, true);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("each backup is uploaded off-site, old copies are pruned, and a downloaded copy restores", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "nwl-team-backup-"));
  try {
    const s3 = fakeS3();
    f.server.ctx.services.team.remote.fetch = s3.fetch;
    await setup(f, dir);
    const { key } = await f.json("/api/team/backup/key", "POST", { password });
    await f.json("/api/team/users", "POST", { email: "pending@example.com", role: "staff" });
    const names = [];
    for (let i = 0; i < 3; i++) {
      const out = await f.json("/api/recovery/backup", "POST", {});
      assert.equal(out.remote.status, "uploaded");
      assert.equal(out.remote.key, "nawlogic/" + out.filename);
      names.push(out.filename);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Retention keeps the newest two remotely; local retention is separate.
    assert.deepEqual([...s3.objects.keys()].sort(), names.slice(1).map((n) => "nawlogic/" + n).sort());
    assert.equal(s3.calls.filter((c) => c.method === "DELETE").length, 1);
    assert.equal((await readdir(dir)).filter((n) => n.endsWith(".nwlbackup")).length, 3);
    // Only ciphertext leaves the server.
    for (const o of s3.objects.values()) assert.equal(o.body.subarray(0, 4).toString(), "NWL2");
    // An unrelated object in the folder is never touched by retention.
    s3.objects.set("nawlogic/notes.txt", { body: Buffer.from("keep me"), modified: new Date().toISOString() });
    await f.json("/api/recovery/backup", "POST", {});
    assert.ok(s3.objects.has("nawlogic/notes.txt"));
    const ws = await f.json("/api/workspace");
    const remote = ws.ext.team.backup.remote;
    assert.equal(remote.configured, true);
    assert.equal(remote.lastUpload.status, "uploaded");
    assert.equal(remote.keep, 2);
    assert.equal(remote.provider, "acct.r2.cloudflarestorage.com");
    assert.ok(!JSON.stringify(ws).includes("sk-test-secret"), "storage secret never reaches the browser");
    const list = await f.json("/api/team/backup/remote");
    assert.equal(list.length, 2);
    // Download the newest copy and restore it to a new database with the key.
    const bytes = await f.server.ctx.services.team.remote.download(list[0].filename);
    const file = join(dir, "downloaded.nwlbackup");
    await writeFile(file, bytes);
    const restored = await restoreBackup(file, join(dir, "from-remote.sqlite"), key);
    const db = new DatabaseSync(restored.path);
    assert.equal(db.prepare("SELECT email FROM owners").get().email, "owner@example.com");
    assert.equal(db.prepare("SELECT count(*) n FROM owners WHERE email='pending@example.com'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM team_tokens").get().n, 0, "invitation links revoked in the restored copy");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM team_tokens").get().n, 1, "the live workspace keeps its link");
    db.close();
    const audit = f.store.db.prepare("SELECT action FROM audit WHERE action LIKE 'backup.%'").all().map((r) => r.action);
    assert.ok(audit.includes("backup.uploaded") && audit.includes("backup.remote_pruned"));
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed upload never fails the local backup and can be retried; the connection test reports the failing step", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "nwl-team-backup-"));
  try {
    let deny = true;
    const s3 = fakeS3({ fail: (method, u) => deny && (method === "PUT" || u.searchParams.has("list-type")) });
    f.server.ctx.services.team.remote.fetch = s3.fetch;
    await setup(f, dir);
    await f.json("/api/team/backup/key", "POST", { password });
    const out = await f.json("/api/recovery/backup", "POST", {});
    assert.ok(out.filename, "local backup succeeded");
    assert.equal(out.remote.status, "failed");
    assert.match(out.remote.error, /AccessDenied/);
    assert.ok(!out.remote.error.includes("sk-test-secret"));
    const status = (await f.json("/api/workspace")).ext.team.backup.remote;
    assert.equal(status.lastAttempt.status, "failed");
    assert.equal(status.lastUpload, null);
    const failed = await f.json("/api/team/backup/test", "POST", {});
    assert.deepEqual([failed.ok, failed.step], [false, "upload"]);
    deny = false;
    const retried = await f.json("/api/team/backup/upload", "POST", {});
    assert.equal(retried.status, "uploaded");
    assert.equal(retried.filename, out.filename);
    const ok = await f.json("/api/team/backup/test", "POST", {});
    assert.equal(ok.ok, true);
    assert.ok(!s3.objects.has("nawlogic/nawlogic-connection-test.txt"), "test object removed");
    assert.equal((await f.json("/api/workspace")).ext.team.backup.remote.lastTest.ok, true);
    // Storage that is not set up says so plainly.
    f.store.setSecret("BACKUP_S3_BUCKET", null);
    assert.equal((await f.auth("/api/team/backup/test", "POST", {})).status, 409);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("console commands combine server and saved storage settings key by key", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDatabase } = await import("../server/db.mjs");
  const { remoteBackups } = await import("../server/team-cli.mjs");
  const dir = mkdtempSync(join(tmpdir(), "nwl-cli-"));
  const saved = { ...process.env };
  try {
    const path = join(dir, "work.sqlite");
    const s = openDatabase(path);
    s.setSecret("BACKUP_S3_ENDPOINT", "https://account.r2.cloudflarestorage.com");
    s.setSecret("BACKUP_S3_REGION", "auto");
    s.setSecret("BACKUP_S3_PREFIX", "office/");
    s.db.close();
    Object.assign(process.env, {
      DATABASE_PATH: path,
      BACKUP_S3_BUCKET: "env-bucket",
      BACKUP_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
      BACKUP_S3_SECRET_ACCESS_KEY: "secret-from-env",
    });
    const { remote, close } = await remoteBackups();
    const cfg = remote.config();
    close();
    assert.equal(cfg.bucket, "env-bucket");
    assert.equal(cfg.region, "auto");
    assert.equal(cfg.prefix, "office/");
    assert.match(cfg.endpoint, /r2\.cloudflarestorage\.com/);
  } finally {
    for (const k of ["DATABASE_PATH", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    rmSync(dir, { recursive: true, force: true });
  }
});
