import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixture } from "./helpers.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const bash = (script, env = {}) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("shell scripts parse and use strict mode", () => {
  for (const file of ["scripts/install.sh", "scripts/update.sh", "scripts/companies.sh"]) {
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

test("install.sh keeps a Cloudflare Tunnel token out of .env and switches the compose files", () => {
  const dir = mkdtempSync(join(tmpdir(), "nwl-tunnel-"));
  try {
    const env = join(dir, ".env"), tunnelEnv = join(dir, ".env.cloudflare");
    const token = "eyJhIjoiZmFrZSIsInQiOiJmYWtlIiwicyI6ImZha2UifQ-abcdefghijklmnop";
    const run = (vars) => bash(`source "${new URL("scripts/install.sh", root).pathname}"; write_env`, { ENV_FILE: env, TUNNEL_ENV_FILE: tunnelEnv, ...vars });
    let r = run({ DOMAIN: "billing.example.com", OWNER_EMAIL: "owner@example.com", ACME_EMAIL: "", TUNNEL: "1", CLOUDFLARE_TUNNEL_TOKEN: token });
    assert.equal(r.status, 0, r.stderr);
    const first = readFileSync(env, "utf8");
    const get = (text, k) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
    assert.equal(get(first, "COMPOSE_FILE"), "docker-compose.yml:deploy/docker-compose.cloudflare.yml");
    assert.equal(get(first, "ACME_EMAIL"), "owner@example.com", "docker-compose.yml still needs a value");
    assert.equal(get(first, "TRUST_PROXY"), "1");
    assert.ok(!first.includes(token), "the token is not in .env (the app container reads .env)");
    assert.equal(readFileSync(tunnelEnv, "utf8"), `TUNNEL_TOKEN=${token}\n`);
    assert.equal(statSync(tunnelEnv).mode & 0o777, 0o600, "token file readable by its owner only");
    // The saved token is offered as the default on a re-run.
    r = bash(`source "${new URL("scripts/install.sh", root).pathname}"; tunnel_token_get`, { ENV_FILE: env, TUNNEL_ENV_FILE: tunnelEnv });
    assert.equal(r.stdout.trim(), token);
    // Back to Caddy: the override and the token file go away, the keys stay.
    r = run({ DOMAIN: "billing.example.com", ACME_EMAIL: "ops@example.com" });
    assert.equal(r.status, 0, r.stderr);
    const second = readFileSync(env, "utf8");
    assert.equal(get(second, "COMPOSE_FILE"), undefined);
    assert.equal(get(second, "ACME_EMAIL"), "ops@example.com");
    assert.equal(get(second, "BACKUP_KEY"), get(first, "BACKUP_KEY"));
    assert.ok(!existsSync(tunnelEnv), "token file removed");
    assert.match(read("scripts/update.sh"), /env_get COMPOSE_FILE/, "update.sh follows the same compose file list");
    const install = read("scripts/install.sh");
    assert.match(install, /compose --profile caddy rm -sf caddy/, "a Caddy install is stopped when switching to the tunnel");
    assert.match(install, /compose up -d --remove-orphans/, "a leftover cloudflared container is removed when switching back");
    assert.match(read("scripts/update.sh"), /compose up -d --remove-orphans/);
    assert.match(install, /== "none" \]\] && CLOUDFLARE_TUNNEL_TOKEN=""/, "'none' clears a saved token");
    const tokenOk = (v) => bash(`source "${new URL("scripts/install.sh", root).pathname}"; valid_tunnel_token "$V"`, { V: v }).status === 0;
    assert.ok(tokenOk("eyJhIjoiMTIzIiwidCI6IjQ1NiIsInMiOiJhYmMrLz09In0=" + "A".repeat(20)), "standard base64 with + / =");
    assert.ok(tokenOk("eyJhIjoiMTIzIn0-_" + "b".repeat(40)), "URL-safe base64");
    assert.ok(!tokenOk("short"), "too short");
    assert.ok(!tokenOk("$(id)" + "a".repeat(40)), "shell characters");
    assert.match(read("scripts/update.sh"), /compose pull --ignore-buildable/, "pulls whichever proxy image is in use");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("several companies on one server: each install is its own compose project, image and folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "nwl-multi-"));
  try {
    const installSh = new URL("scripts/install.sh", root).pathname;
    const src = (fn, vars = {}) => bash(`source "${installSh}"; ${fn}`, vars);
    const get = (text, k) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
    // A fresh install takes its project name from its folder, made safe for Compose.
    mkdirSync(join(dir, "nawlogic-Syarikat B"));
    const env = join(dir, "nawlogic-Syarikat B", ".env");
    let r = src("write_env", { ENV_FILE: env, DOMAIN: "b.example.com", ACME_EMAIL: "ops@example.com" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(get(readFileSync(env, "utf8"), "COMPOSE_PROJECT_NAME"), "nawlogic-syarikat-b");
    assert.equal(src("project_name", { ENV_FILE: env }).stdout.trim(), "nawlogic-syarikat-b");
    r = src("write_env", { ENV_FILE: env, DOMAIN: "c.example.com", ACME_EMAIL: "ops@example.com" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(env, "utf8").match(/^COMPOSE_PROJECT_NAME=.*$/gm), ["COMPOSE_PROJECT_NAME=nawlogic-syarikat-b"], "kept on a re-run");
    // An install from before this option keeps the name docker-compose.yml declares, and with it its data volume.
    const legacy = join(dir, "legacy.env");
    writeFileSync(legacy, "DOMAIN=a.example.com\nBACKUP_KEY=x\n", { mode: 0o600 });
    r = src("write_env", { ENV_FILE: legacy, DOMAIN: "a.example.com", ACME_EMAIL: "ops@example.com" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(get(readFileSync(legacy, "utf8"), "COMPOSE_PROJECT_NAME"), undefined);
    assert.equal(src("project_name", { ENV_FILE: legacy }).stdout.trim(), "nawlogic");
    const compose = read("docker-compose.yml");
    assert.match(compose, /^name: nawlogic$/m);
    assert.match(compose, /image: nawlogic-invoice:\$\{COMPOSE_PROJECT_NAME:-nawlogic\}/, "one image tag per company");
    assert.ok(!/container_name:/.test(compose + read("deploy/docker-compose.cloudflare.yml")), "no fixed container names");
    for (const f of ["scripts/install.sh", "scripts/update.sh"]) assert.match(read(f), /docker compose -p "\$\(project_name\)"/, f + " pins the project");
    const update = read("scripts/update.sh");
    assert.match(update, /docker tag nawlogic-invoice:local "\$IMAGE"/, "an older install's :local image is adopted before the backup");
    assert.match(update, /PREVIOUS="\$IMAGE-previous"/);
    assert.match(read("scripts/install.sh"), /--filter publish=443/, "a second Caddy install on the same server is refused");
    // companies.sh: names, folders and what "add" does.
    const companies = new URL("scripts/companies.sh", root).pathname;
    const c = (fn, vars = {}) => bash(`source "${companies}"; ${fn}`, vars);
    for (const ok of ["acme", "syarikat-b", "a1"]) assert.equal(c('valid_slug "$V"', { V: ok }).status, 0, ok);
    for (const bad of ["Syarikat B", "-x", "x", "a".repeat(40), "../etc", "a;b"]) assert.notEqual(c('valid_slug "$V"', { V: bad }).status, 0, bad);
    assert.equal(c("target_dir acme").stdout.trim(), join(dirname(root.pathname.replace(/\/$/, "")), "nawlogic-acme"));
    const src2 = read("scripts/companies.sh");
    assert.match(src2, /git clone -q "\$APP_DIR" "\$target"/, "same code, new folder");
    assert.match(src2, /exec "\$target\/scripts\/install\.sh"/, "then the ordinary installer");
    assert.match(src2, /\[\[ ! -e "\$target" \]\] \|\| die/, "never over an existing folder");
    assert.match(read("docs/DEPLOYMENT.md"), /## Several companies on one server/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// "add" clones the install next to itself and hands over to that copy's installer.
// The clone needs root like the real run, so this only runs as root (the dev container, not CI).
test("companies.sh add: a clone next to this install, same remote, then its own installer", { skip: process.getuid?.() !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "nwl-companies-"));
  try {
    const first = join(dir, "nawlogic");
    mkdirSync(join(first, "scripts"), { recursive: true });
    for (const f of ["companies.sh", "install.sh"]) writeFileSync(join(first, "scripts", f), read("scripts/" + f), { mode: 0o755 });
    writeFileSync(join(first, ".env"), "DOMAIN=app.example.com\n", { mode: 0o600 });
    writeFileSync(join(first, ".gitignore"), ".env\n.env.*\n"); // as in the real repository
    const git = (...a) => spawnSync("git", ["-C", first, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
    assert.equal(git("init", "-q").status, 0);
    assert.equal(git("add", "-A").status, 0);
    assert.equal(git("commit", "-qm", "init").status, 0);
    assert.equal(git("remote", "add", "origin", "https://example.com/acme/nawlogic.git").status, 0);
    // exec is shadowed so the installer (Docker, apt) does not run here.
    const r = bash(`source "${join(first, "scripts/companies.sh")}"; exec() { echo "EXEC $*"; }; cmd_add acme`, { HOME: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp("EXEC " + join(dir, "nawlogic-acme", "scripts", "install.sh")));
    assert.ok(existsSync(join(dir, "nawlogic-acme", "scripts", "install.sh")), "cloned next to the first install");
    assert.ok(!existsSync(join(dir, "nawlogic-acme", ".env")), "no settings copied: the installer writes new keys");
    assert.equal(spawnSync("git", ["-C", join(dir, "nawlogic-acme"), "remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim(), "https://example.com/acme/nawlogic.git", "updates pull from the same remote");
    assert.notEqual(bash(`source "${join(first, "scripts/companies.sh")}"; cmd_add acme`).status, 0, "refuses an existing folder");
    writeFileSync(join(dir, "nawlogic-acme", ".env"), "DOMAIN=acme.example.com\nCOMPOSE_PROJECT_NAME=nawlogic-acme\n", { mode: 0o600 });
    const list = bash(`"${join(first, "scripts/companies.sh")}" list`);
    assert.match(list.stdout, /nawlogic-acme\s+nawlogic-acme/, "listed once the installer has written its .env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compose override for Cloudflare Tunnel: cloudflared instead of Caddy, token in its own file", () => {
  const c = read("deploy/docker-compose.cloudflare.yml");
  assert.match(c, /\n  caddy:\n    profiles: \["caddy"\]/, "Caddy is parked behind a profile nothing activates");
  const cf = c.slice(c.indexOf("\n  cloudflared:"));
  assert.match(cf, /image: cloudflare\/cloudflared:/);
  assert.match(cf, /command: tunnel --no-autoupdate run/);
  assert.match(cf, /env_file:\n\s+- \.env\.cloudflare/);
  assert.ok(!/TUNNEL_TOKEN:|CLOUDFLARE_TUNNEL_TOKEN/.test(c), "the token is never interpolated from .env");
  assert.match(cf, /restart: unless-stopped/);
  assert.match(cf, /condition: service_healthy/);
  assert.match(cf, /read_only: true/);
  assert.match(cf, /no-new-privileges:true/);
  assert.match(cf, /max-size: "10m"/);
  assert.ok(!/\n\s+ports:/.test(c), "no port is published in tunnel mode");
  assert.match(c.slice(c.indexOf("\n  app:"), c.indexOf("\n  cloudflared:")), /TRUST_PROXY: "1"/);
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
