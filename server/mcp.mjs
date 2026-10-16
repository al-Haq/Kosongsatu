import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TOOL_DEFINITIONS } from "./automation.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
// Errors whose message is safe and useful to show the MCP host.
class ConnectorError extends Error {}
export function createMcpServer({
  base = process.env.NAWLOGIC_URL,
  token = process.env.NAWLOGIC_CONNECTOR_TOKEN,
  fetcher = fetch,
} = {}) {
  if (!base || !token)
    throw new Error(
      "Set NAWLOGIC_URL and NAWLOGIC_CONNECTOR_TOKEN. Create a scoped token in AI & automation.",
    );
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "NAWLOGIC_URL must be an HTTPS origin or a loopback HTTP origin.",
    );
  const server = new McpServer({ name: "nawlogic-sales", version: "0.3.0" });
  for (const tool of TOOL_DEFINITIONS)
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          const response = await fetcher(
            url.origin + "/api/integrations/tools/" + tool.name,
            {
              method: "POST",
              redirect: "error",
              headers: {
                Authorization: "Bearer " + token,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(args),
              signal: AbortSignal.timeout(20000),
            },
          );
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 128000)
              throw new ConnectorError(
                "Connector response too large. Narrow the search.",
              );
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            throw new ConnectorError("Connector response was not JSON.");
          }
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            isError: !response.ok,
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text:
                  e instanceof ConnectorError
                    ? e.message
                    : "Connector unavailable. Check URL/token and server status.",
              },
            ],
            isError: true,
          };
        }
      },
    );
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await serveStdio(() => createMcpServer());
