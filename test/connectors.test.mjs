import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { today, addDays } from "../server/domain.mjs";
const password = "Strong-test-connector-password-1";
async function fixture(options = {}) {
  const s = openDatabase(":memory:");
  s.saveSettings({
    registration: "TEST-1",
    address: "Test office",
    email: "test@example.com",
  });
  await createOwner(s, "owner@example.com", password);
  const c = s.saveClient({ name: "Connector customer" });
  const server = createApp({
    store: s,
    appUrl: "http://localhost",
    assistantConfig: null,
    ...options,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password }),
  });
  const session = await login.json(),
    cookie = login.headers.get("set-cookie").split(";")[0];
  const auth = (path, method = "GET", body) =>
    fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost",
        Cookie: cookie,
        "X-CSRF-Token": session.csrf,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const close = async () => {
    await new Promise((r) => server.close(r));
    s.db.close();
  };
  return { s, c, base, auth, close };
}
test("HTTP connectors require bearer scope and never receive owner approval or payment access", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.auth("/api/automation/connectors", "POST", {
          label: "Agent",
          scopes: ["business:read"],
          password: "wrong",
        })
      ).status,
      403,
    );
    const created = await f.auth("/api/automation/connectors", "POST", {
      label: "Agent",
      scopes: ["business:read"],
      password,
    });
    assert.equal(created.status, 201);
    const { token, id } = await created.json();
    const call = (path, b) =>
      fetch(f.base + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(b),
      });
    assert.equal(
      (await call("/api/integrations/tools/pipeline_summary", {})).status,
      200,
    );
    assert.equal(
      (
        await call("/api/integrations/tools/propose_sales", {
          request_key: "connector-test-key-1",
          data: { client_id: f.c.id, title: "No permission" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/automation/proposals/any/approve", {})).status,
      403,
    );
    assert.equal((await call("/api/receipts", {})).status, 403);
    assert.equal((await fetch(f.base + "/api/integrations/tools")).status, 401);
    const listing = await (
      await fetch(f.base + "/api/integrations/tools", {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
    assert.ok(listing.tools.every((t) => !t.name.startsWith("propose_")));
    await f.auth("/api/automation/connectors/" + id + "/revoke", "POST", {});
    assert.equal(
      (await call("/api/integrations/tools/pipeline_summary", {})).status,
      401,
    );
  } finally {
    await f.close();
  }
});
test("HTTP proposal approval is CSRF protected, idempotent and separate from connector submission", async () => {
  const f = await fixture();
  try {
    const { token } = f.s.createConnector({
      label: "Agent",
      scopes: ["business:read", "proposals:write"],
    });
    const payload = {
      request_key: "connector-proposal-key-0001",
      data: {
        client_id: f.c.id,
        title: "Customer automation project",
        expected_amount: 100,
      },
    };
    const call = () =>
      fetch(f.base + "/api/integrations/tools/propose_sales", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    const p = await (await call()).json();
    assert.equal(p.state, "pending");
    assert.equal((await (await call()).json()).id, p.id);
    assert.equal(f.s.sales().opportunities.length, 0);
    await f.auth("/api/automation/proposals/" + p.id + "/approve", "POST", {});
    await f.auth("/api/automation/proposals/" + p.id + "/approve", "POST", {});
    assert.equal(f.s.sales().opportunities.length, 1);
    const actor = f.s.db
      .prepare(
        "SELECT actor FROM audit WHERE action='automation.proposal.created'",
      )
      .get().actor;
    assert.ok(actor.startsWith("connector:Agent:"));
  } finally {
    await f.close();
  }
});
test("real MCP stdio handshake, tool schema validation, REST permissions and proposal lifecycle", async () => {
  const f = await fixture();
  const client = new Client({ name: "nawlogic-test", version: "1.0.0" });
  try {
    const { token } = f.s.createConnector({
      label: "MCP test",
      scopes: ["business:read", "proposals:write"],
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../server/mcp.mjs", import.meta.url))],
      env: { NAWLOGIC_URL: f.base, NAWLOGIC_CONNECTOR_TOKEN: token },
      stderr: "pipe",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    assert.ok(!listed.tools.some((t) => /approve|issue|refund/.test(t.name)));
    const summary = await client.callTool({
      name: "pipeline_summary",
      arguments: {},
    });
    assert.ok(!summary.isError);
    assert.equal(JSON.parse(summary.content[0].text).currency, "MYR");
    const invalid = await client.callTool({
      name: "search_records",
      arguments: { kind: "all", secret: true },
    });
    assert.equal(invalid.isError, true);
    const proposed = await client.callTool({
      name: "propose_sales",
      arguments: {
        request_key: "mcp-test-proposal-key-001",
        data: { client_id: f.c.id, title: "MCP opportunity" },
      },
    });
    assert.ok(!proposed.isError);
    const p = JSON.parse(proposed.content[0].text);
    assert.equal(f.s.sales().opportunities.length, 0);
    await f.auth("/api/automation/proposals/" + p.id + "/approve", "POST", {});
    const status = await client.callTool({
      name: "get_proposal",
      arguments: { id: p.id },
    });
    assert.equal(JSON.parse(status.content[0].text).state, "applied");
    assert.equal(f.s.sales().opportunities.length, 1);
  } finally {
    await client.close();
    await f.close();
  }
});
