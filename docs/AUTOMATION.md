# Sales, AI and MCP — v0.3.0

This release adds an operational automation layer to the existing single-owner Nawlogic billing app. An AI model is optional: sales, PO registration, proposals, deterministic rules and MCP work without one. A configured model is required for the built-in natural-language assistant. No live provider, external account or production deployment is connected by this commit.

## Sales flow

1. Add the customer and catalog services.
2. In **Sales & POs**, create an opportunity, choose **Prepare quote**, then queue a quotation proposal. The quick form provides one line; edit the resulting draft for additional lines.
3. In **AI & automation**, review the customer, scope, dates, prices and terms, then approve. Approval creates a draft quotation and links it to the opportunity.
4. Review and issue the quotation through the existing document workflow. Share through the existing client link when ready.
5. Customer acceptance can come through the portal. For verified acceptance received elsewhere, **Record acceptance** requires the signatory name and communication/evidence reference and records a distinct owner audit action.
6. Register the **customer's PO to Nawlogic** against the accepted quotation. This release supports one full-value MYR PO per quotation. Supplier purchasing, partial orders, multi-currency POs, PO file uploads/OCR, amendments and cancellation are not implemented.
7. Create/open the single linked invoice draft, or enable the deterministic PO rule before receiving new POs. The invoice includes the customer PO reference in its notes when first generated through this workflow. Existing issued invoices are not rewritten.

The PO reference and amount are verified owner records, not independent validation with the customer's procurement system. A PO cannot be registered twice for the same quotation, or with the same normalized customer/reference. Invoice conversion reuses the existing invoice for a quotation.

## Built-in AI assistant

Configure the server environment, then restart:

```dotenv
# Example local compatible model service; replace the model with one you installed.
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=your-installed-tool-capable-model
# For an authenticated hosted compatible endpoint, use HTTPS and its private key.
# AI_API_KEY=...
```

The provider must support non-streaming `/chat/completions` with function tools and the configured model must support tool calling. The implementation follows the compatible API shape documented by [Ollama](https://docs.ollama.com/api/openai-compatibility); provider/model compatibility and response quality need acceptance testing with your chosen service. It does not install or download a model. Do not assume every compatible provider implements every option identically.

Remote providers require HTTPS. Loopback HTTP is permitted for a local model; if the app runs in Docker, `127.0.0.1` refers to the app container. Use a trusted HTTPS endpoint or deliberately configure networking rather than weakening the URL check. The URL, model and secret are server-managed; users and models cannot supply arbitrary outbound destinations.

Before each request, the UI requires consent to send the prompt and requested business records to the configured provider. A local URL alone does not prove that the underlying model service never calls the cloud; configure and verify the provider separately. Prompts, responses and tool summaries are stored in SQLite and included in encrypted database backups. The business JSON export includes sales/PO records and the latest 100 proposal/run rows; it excludes chat history and connector credentials and remains unsuitable for full restore. Do not paste passwords or API tokens into prompts.

Example requests:

- “Cari opportunity yang qualified dan senaraikan yang belum ada quotation.”
- “Sediakan quotation draft untuk customer ini, gunakan service catalog. Tanya aku kalau scope atau harga tak cukup.”
- “Daftarkan cadangan customer PO PO-123 bagi quotation yang sudah accepted.”
- “Sediakan invoice draft daripada quotation yang accepted.”

Each request is a new conversation turn with no hidden replay of previous chat history. Relevant IDs/context should be stated or retrieved by tools. Up to four provider requests and eight tool calls are allowed per user turn, with request timeouts and output-size caps. Allow at least 120 seconds for the assistant endpoint in your reverse proxy if you use it; ordinary API routes retain their shorter limits. The app never sends the complete database by default. Tools expose customer names/IDs, catalog rates, sales records and selected document fields, excluding bank instructions, sessions, password/MFA data, private link tokens and payment references. Text deliberately entered in sales/document notes can still be sensitive and is treated as untrusted data.

The assistant can **read and propose**. It has no approval, issuing, sharing, sending, payment, refund, arbitrary SQL, shell or general HTTP tool. Generated text can still be wrong; the review queue and resulting record state are authoritative. Provider failures are explicit, and any already-created proposals remain visible for review. After an interrupted request, inspect the queue before starting a new one. Provider calls can incur the provider's normal usage charges; the app does not include a subscription or credit balance.

## MCP connector

This is a real **stdio MCP server**, built with the official TypeScript SDK. A compatible local MCP host launches it; it connects to the running Nawlogic application through a scoped REST token. It does not open the SQLite database directly. It is not a public Streamable HTTP/OAuth MCP endpoint, and it is not automatically installed in ChatGPT/Claude or any other host.

1. In **AI & automation → Create connector**, choose a label, scopes and 1–90 day expiry. Confirm the current owner password and MFA code if enabled.
2. Store the token shown once in the host's private environment/credential store. Only its hash is stored by the app. Do not put the token in Git, a prompt, a screenshot or shell history.
3. Configure your MCP host to launch Node directly (not an npm script that prints to stdout):

```json
{
  "mcpServers": {
    "nawlogic": {
      "command": "node",
      "args": ["/absolute/path/Kosongsatu/server/mcp.mjs"],
      "env": {
        "NAWLOGIC_URL": "https://invoice.your-domain.example",
        "NAWLOGIC_CONNECTOR_TOKEN": "REPLACE_USING_YOUR_HOST_SECRET_STORE"
      }
    }
  }
}
```

Adapt the config format to your host. Install the repository's production dependencies before launching. For a local app use `http://127.0.0.1:3000` as the origin; remote origins require HTTPS. Do not include a path or credentials in `NAWLOGIC_URL`. `npm run mcp` is available for a direct terminal smoke check, while protocol hosts should execute `node server/mcp.mjs` directly. Logs must remain on stderr; stdout carries MCP JSON-RPC.

| Scope             | Tools                                                                                     | Capability                                             |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `business:read`   | `pipeline_summary`, `search_records`, `get_document`, `get_proposal`                      | Bounded business reads with explicit field projections |
| `proposals:write` | `propose_sales`, `propose_quotation`, `propose_customer_po`, `propose_invoice_from_quote` | Queue pending proposals, never approve them            |
| `events:read`     | `read_events`                                                                             | Poll record-ID events after an integer cursor          |

All nine tool schemas are advertised by the stdio adapter; the application checks the token's actual scope on every call and denies unauthorized tools. The HTTP discovery endpoint returns only permitted tools. Data fields ending `_sen`, document item rates and catalog rates are integer sen; proposal input rates/discount/amounts are decimal MYR. Every propose tool needs a stable 16–100 character `request_key`; reuse it only for an identical retry. Tokens can be revoked immediately in the app. Password changes, console recovery and database restore revoke tokens; restore also disables workflow rules.

## n8n / HTTP integration

Use n8n's HTTP Request node with a protected bearer credential. No n8n workflow or external message has been created automatically.

```text
GET /api/integrations/tools
Authorization: Bearer <connector-token>

POST /api/integrations/tools/read_events
Content-Type: application/json
Authorization: Bearer <connector-token>
{"after":0,"limit":50}

POST /api/integrations/tools/propose_sales
Content-Type: application/json
Authorization: Bearer <connector-token>
{"request_key":"your-source-event-000001","data":{"client_id":"existing-client-uuid","title":"Integration request","expected_amount":"1000.00"}}
```

Persist the highest event ID only after downstream work completes. Each downstream consumer should use a stable source-event key for idempotency. These bearer routes deliberately do not use browser sessions/CSRF; owner routes still require their own session, allowed origin and CSRF token. Bearer tokens never grant owner API access. The event queue supports polling, not automatic outbound webhook delivery. There are no WhatsApp, mailbox, bank or payment gateway connections in this release.

## Deterministic workflow rules

Both rules are disabled by default. Enabling records the current event cursor so historical events cannot unexpectedly trigger a newly enabled rule.

| Rule                                  | Trigger                          | Result                                               |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| Accepted quotation → invoice proposal | New `quote.accepted` event       | Pending proposal for owner review                    |
| Customer PO → invoice draft           | New `customer_po.received` event | One invoice draft from the accepted quotation and PO |

The normal server processes up to 25 queued events at startup and every 30 seconds. **Run pending events** allows deliberate processing during tests or local demo use. An enabled deterministic rule is an explicit owner policy; the model cannot change rules. Rule execution uses SQLite transactions, savepoints and unique event/rule execution records. A failed action rolls back its partial business writes, records the failure and supports owner-triggered retry. Prior failure/retry history remains in audit. No rule issues an invoice, sends a message, charges a bank account or records payment.

## Upgrade, recovery and verification

Schema v3 adds tables without changing existing invoice/receipt totals. File databases containing documents get a private `*.pre-v3-*.sqlite` snapshot before the v3 migration. Like the earlier v2 rollback snapshot, it contains plaintext private data; retain privately for acceptance, then move to encrypted backup storage or apply your retention policy.

Restore revokes owner sessions, customer links and connector tokens, disables rules and marks interrupted AI runs failed. Review data and re-enable rules deliberately after a restore. Active MFA still requires its original key, independently of the backup encryption key.

Automated tests exercise sales/PO invariants, review and retry behavior, scope enforcement, strict schemas, provider tool loops with deterministic fake responses, and a real stdio MCP client handshake through the HTTP connector. The desktop/mobile browser flow (sales → proposal → quote → verified acceptance → PO → invoice, token-once display and a test-provider chat turn) is a manual check in [ACCEPTANCE.md](ACCEPTANCE.md), not an automated test. No paid/live model or external automation account has been tested or connected.

Primary protocol references: [official SDK first-server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md), [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [Ollama compatible API](https://docs.ollama.com/api/openai-compatibility).

## Extension points

- `server/automation.mjs`: shared strict tool schemas, scope checks, field projections and proposal application. Both the assistant and MCP use this registry.
- `server/assistant.mjs`: provider adapter and bounded tool loop. Add another provider adapter here while retaining the same tool policy.
- `server/sales.mjs`: business transitions, event emission and deterministic rules. Add rules as explicit owner-configurable policies with transactional execution and replay tests.
- `server/mcp.mjs`: standard MCP transport adapter to the scoped HTTP API; credentials stay outside database-facing tools.
- External channels should consume `read_events` and submit proposals using stable source-event keys. Any future sending/payment connector needs its own scoped capability, validated callbacks, idempotency and deliberate owner policy rather than granting a model arbitrary network or database access.
