import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const bash = (script, env = {}) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("shell scripts parse and use strict mode", () => {
  for (const file of ["scripts/install.sh", "scripts/update.sh"]) {
    const r = spawnSync("bash", ["-n", new URL(file, root).pathname], { encoding: "utf8" });
    assert.equal(r.status, 0, file + ": " + r.stderr);
    const src = read(file);
    assert.match(src, /^#!\/usr\/bin\/env bash\n/);
    assert.match(src, /\nset -euo pipefail\n/);
    assert.match(src, /if \[\[ "\$\{BASH_SOURCE\[0\]\}" == "\$0" \]\]; then main "\$@"; fi\n$/, "functions can be loaded without running");
    assert.ok(statSync(new URL(file, root)).mode & 0o100, file + " is executable");
  }
  const install = read("scripts/install.sh");
  assert.match(install, /\[\[ \$EUID -eq 0 \]\]/, "requires root");
  assert.match(install, /docker\.sources/, "Docker's apt repository");
  assert.match(install, /Signed-By: \/etc\/apt\/keyrings\/docker\.asc/);
  assert.match(install, /ufw allow OpenSSH/, "SSH is allowed before the firewall is turned on");
  assert.match(read("scripts/update.sh"), /cli\.mjs backup \|\|\s+die/, "an update stops when the backup fails");
});

test("install.sh writes a private .env once and never replaces existing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "nwl-install-"));
  try {
    const env = join(dir, ".env");
    const run = (vars) => bash(`source "${new URL("scripts/install.sh", root).pathname}"; write_env`, { ENV_FILE: env, ...vars });
    let r = run({ DOMAIN: "billing.example.com", ACME_EMAIL: "ops@example.com" });
    assert.equal(r.status, 0, r.stderr);
    const first = readFileSync(env, "utf8");
    assert.equal(statSync(env).mode & 0o777, 0o600, "readable by its owner only");
    const get = (text, k) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
    for (const k of ["BACKUP_KEY", "MFA_ENCRYPTION_KEY"]) {
      assert.match(get(first, k), /^[A-Za-z0-9+/]{43}=$/, k + " is 32 bytes of base64");
      assert.equal(Buffer.from(get(first, k), "base64").length, 32);
    }
    assert.notEqual(get(first, "BACKUP_KEY"), get(first, "MFA_ENCRYPTION_KEY"), "independent keys");
    assert.equal(get(first, "APP_URL"), "https://billing.example.com");
    assert.equal(get(first, "TRUST_PROXY"), "1");
    assert.equal(get(first, "NODE_ENV"), "production");
    // Running again with a new domain keeps the keys and the owner's own settings.
    writeFileSync(env, first + "SMTP_HOST=smtp.example.com\n", { mode: 0o600 });
    r = run({ DOMAIN: "invoice.example.my", ACME_EMAIL: "ops@example.com" });
    assert.equal(r.status, 0, r.stderr);
    const second = readFileSync(env, "utf8");
    for (const k of ["BACKUP_KEY", "MFA_ENCRYPTION_KEY"]) assert.equal(get(second, k), get(first, k), k + " kept");
    assert.equal(get(second, "DOMAIN"), "invoice.example.my");
    assert.equal(get(second, "APP_URL"), "https://invoice.example.my");
    assert.equal(get(second, "SMTP_HOST"), "smtp.example.com");
    assert.equal(second.match(/^DOMAIN=/gm).length, 1, "no duplicate lines");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install.sh validates the domain and emails", () => {
  const check = (fn, value) => bash(`source "${new URL("scripts/install.sh", root).pathname}"; ${fn} "$V"`, { V: value }).status === 0;
  for (const ok of ["billing.example.com", "a.b.example.my", "xn--bcher-kva.example"]) assert.ok(check("valid_domain", ok), ok);
  for (const bad of ["localhost", "-x.example.com", "billing.example.com/", "http://x.com", "a..b.com", "billing example.com", "x.com;rm -rf /"]) assert.ok(!check("valid_domain", bad), bad);
  for (const ok of ["owner@example.com", "first.last+billing@company.com.my"]) assert.ok(check("valid_email", ok), ok);
  for (const bad of ["owner", "a@b", 'x"@example.com', "a b@example.com", "$(id)@example.com"]) assert.ok(!check("valid_email", bad), bad);
});

test("compose stack: HTTPS proxy, private app port, health checks, restarts and log rotation", () => {
  const c = read("docker-compose.yml");
  const app = c.slice(c.indexOf("\n  app:"), c.indexOf("\n  caddy:"));
  const caddy = c.slice(c.indexOf("\n  caddy:"), c.indexOf("\nvolumes:"));
  assert.ok(!/\n\s+ports:/.test(app), "the app is not published on the host");
  assert.match(app, /TRUST_PROXY: "1"/);
  assert.match(app, /NODE_ENV: production/);
  assert.match(app, /APP_URL: https:\/\/\$\{DOMAIN:\?/);
  assert.match(app, /app-data:\/app\/data/);
  assert.match(app, /\/app\/backups/);
  assert.match(app, /read_only: true/);
  assert.match(app, /no-new-privileges:true/);
  for (const s of [app, caddy]) {
    assert.match(s, /restart: unless-stopped/);
    assert.match(s, /healthcheck:/);
    assert.match(s, /logging: \*logging/);
  }
  assert.match(c, /max-size: "10m"/);
  assert.match(c, /max-file: "5"/);
  assert.match(caddy, /"443:443"/);
  assert.match(caddy, /"80:80"/);
  assert.match(caddy, /condition: service_healthy/);
  assert.match(caddy, /caddy-data:\/data/);
  const caddyfile = read("deploy/Caddyfile");
  assert.match(caddyfile, /\{\$DOMAIN\} \{/);
  assert.match(caddyfile, /reverse_proxy app:3000/);
  assert.match(caddyfile, /email \{\$ACME_EMAIL\}/);
  const docker = read("Dockerfile");
  assert.match(docker, /HEALTHCHECK/);
  assert.match(docker, /USER node/);
  const example = read(".env.example");
  for (const k of ["DOMAIN", "ACME_EMAIL", "BACKUP_HOST_DIR", "PLATFORM_OWNER_WHATSAPP"]) assert.match(example, new RegExp(`# ${k}=`));
  assert.match(read("deploy/nginx.conf.example"), /proxy_set_header X-Forwarded-For \$remote_addr;/, "nginx overwrites, never appends, the client address");
  const unit = read("deploy/nawlogic.service");
  assert.match(unit, /EnvironmentFile=\/opt\/nawlogic\/\.env/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /HOST=127\.0\.0\.1/);
});

test("the container health check command works against the app", async () => {
  const c = read("docker-compose.yml");
  const js = c.match(/"node", "-e", "(.+?)"\]/)[1];
  assert.equal(read("Dockerfile").match(/"node", "-e", "(.+?)"\]/)[1], js, "same check in both files");
  // The server runs in this process, so the check must not block the event loop.
  const exitCode = (port) =>
    new Promise((resolve) => spawn(process.execPath, ["-e", js], { env: { PORT: port }, stdio: "ignore" }).on("exit", resolve));
  const f = await fixture();
  try {
    assert.equal(await exitCode(new URL(f.base).port), 0, "healthy");
  } finally {
    await f.close();
  }
  assert.equal(await exitCode("1"), 1, "unhealthy when nothing answers");
});
