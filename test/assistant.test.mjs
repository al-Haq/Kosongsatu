import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { Assistant, aiConfiguration } from "../server/assistant.mjs";
const config = {
  base: "https://models.example.com/v1",
  model: "test-model",
  key: "test-secret-never-exposed",
};
const reply = (message) =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    headers: { "Content-Type": "application/json" },
  });
async function fixture(fetcher) {
  const s = openDatabase(":memory:");
  await createOwner(s, "ai@example.com", "Strong-test-password-123");
  const c = s.saveClient({ name: "AI customer" });
  return { s, c, ai: new Assistant(s, { config, fetcher }) };
}
test("AI configuration rejects unsafe URLs and reports disabled without a configured provider", () => {
  assert.equal(aiConfiguration({}), null);
  assert.throws(
    () =>
      aiConfiguration({
        AI_BASE_URL: "http://models.example.com/v1",
        AI_MODEL: "x",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      aiConfiguration({
        AI_BASE_URL: "https://user:pass@models.example.com/v1",
        AI_MODEL: "x",
      }),
    /credentials/,
  );
  assert.ok(
    aiConfiguration({
      AI_BASE_URL: "http://127.0.0.1:11434/v1",
      AI_MODEL: "local-tool-model",
    }),
  );
});
test("built-in assistant reads and queues proposals via validated tools; retries do not call provider twice", async () => {
  let calls = 0;
  let f;
  const requests = [];
  f = await fixture(async (url, options) => {
    calls++;
    const b = JSON.parse(options.body);
    requests.push(b);
    assert.equal(url, config.base + "/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer " + config.key);
    if (calls === 1)
      return reply({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: {
              name: "search_records",
              arguments: JSON.stringify({ kind: "clients" }),
            },
          },
        ],
      });
    if (calls === 2)
      return reply({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "write-1",
            type: "function",
            function: {
              name: "propose_sales",
              arguments: JSON.stringify({
                request_key: "model-request-key-0001",
                data: {
                  client_id: f.c.id,
                  title: "AI project",
                  expected_amount: 100,
                },
              }),
            },
          },
        ],
      });
    return reply({
      role: "assistant",
      content: "Cadangan sales sudah masuk ruang semakan.",
    });
  });
  try {
    const b = {
      prompt: "Sediakan cadangan sales untuk AI customer.",
      request_key: "assistant-test-key-0001",
      consent: true,
    };
    const r = await f.ai.run(1, b);
    assert.equal(calls, 3);
    assert.equal(f.s.sales().opportunities.length, 0);
    assert.equal(f.s.automationState().proposals.length, 1);
    assert.ok(r.tools.some((t) => t.proposal_id));
    assert.equal((await f.ai.run(1, b)).id, r.id);
    assert.equal(calls, 3);
    assert.ok(!JSON.stringify(f.s.automationState()).includes(config.key));
    assert.ok(
      !requests.some((r) =>
        r.tools.some((t) =>
          /approve|issue|refund|read_events/.test(t.function.name),
        ),
      ),
    );
    assert.equal(requests[0].messages.length, 2);
  } finally {
    f.s.db.close();
  }
});
test("assistant requires consent, refuses unlisted tools and does not trust model-issued action claims", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    if (calls === 1)
      return reply({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "bad",
            type: "function",
            function: { name: "approve_proposal", arguments: "{}" },
          },
        ],
      });
    return reply({
      role: "assistant",
      content: "I cannot approve a proposal.",
    });
  });
  try {
    await assert.rejects(
      () =>
        f.ai.run(1, {
          prompt: "Do it",
          request_key: "assistant-test-key-0002",
        }),
      /Confirm sending/,
    );
    assert.equal(calls, 0);
    const r = await f.ai.run(1, {
      prompt: "Approve everything",
      request_key: "assistant-test-key-0002",
      consent: true,
    });
    assert.equal(r.tools[0].ok, false);
    assert.equal(f.s.documents().length, 0);
    assert.equal(f.s.automationState().proposals.length, 0);
  } finally {
    f.s.db.close();
  }
});
test("provider failures and oversized replies leave explicit failed status without leaking upstream secrets", async () => {
  const f = await fixture(
    async () => new Response("secret provider diagnostic", { status: 401 }),
  );
  try {
    await assert.rejects(
      () =>
        f.ai.run(1, {
          prompt: "Test",
          request_key: "assistant-test-key-0003",
          consent: true,
        }),
      /provider request failed/,
    );
    const run = f.s.db.prepare("SELECT * FROM assistant_runs").get();
    assert.equal(run.state, "failed");
    assert.ok(!JSON.stringify(run).includes("secret provider diagnostic"));
    await assert.rejects(
      () =>
        f.ai.run(1, {
          prompt: "Test",
          request_key: "assistant-test-key-0003",
          consent: true,
        }),
      /Previous request failed/,
    );
    const oversized = new Assistant(f.s, {
      config,
      fetcher: async () => new Response("x".repeat(300000)),
    });
    await assert.rejects(
      () =>
        oversized.run(1, {
          prompt: "Test size",
          request_key: "assistant-test-key-0004",
          consent: true,
        }),
      /size limit/,
    );
    const disabled = new Assistant(f.s, { config: null });
    await assert.rejects(() => disabled.run(1, {}), /not configured/);
  } finally {
    f.s.db.close();
  }
});
