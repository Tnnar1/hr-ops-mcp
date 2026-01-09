import express from "express";
import cors from "cors";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --------------------
// Config
// --------------------
const OPS_BASE_URL = (process.env.OPS_BASE_URL || "").replace(/\/+$/, "");
const OPS_KEY = (process.env.OPS_KEY || "").trim();

// Token لحماية MCP endpoint (اختياري لكن أنصحك بشدة)
// ضعه في Render Env Vars: MCP_AUTH_TOKEN=شيء_طويل_وعشوائي
const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();

const PORT = Number(process.env.PORT || 10000);

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("❌ Missing OPS_BASE_URL or OPS_KEY. Set them in Render environment variables.");
  process.exit(1);
}

console.log(`✅ OPS_BASE_URL=${OPS_BASE_URL}`);
console.log(`✅ MCP_AUTH_TOKEN ${MCP_AUTH_TOKEN ? "is set" : "is NOT set (endpoint is open!)"}`);

// --------------------
// Auth helper
// --------------------
function isAuthed(req) {
  if (!MCP_AUTH_TOKEN) return true;

  const authHeader = String(req.headers["authorization"] || "");
  const apiKeyHeader = String(req.headers["x-api-key"] || req.headers["x-api_key"] || "");
  const mcpAuthHeader = String(req.headers["x-mcp-auth"] || "");

  const cleanAuth = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cleanKey = apiKeyHeader.trim();
  const cleanMcp = mcpAuthHeader.trim();

  return cleanAuth === MCP_AUTH_TOKEN || cleanKey === MCP_AUTH_TOKEN || cleanMcp === MCP_AUTH_TOKEN;
}

// --------------------
// opsFetch helper (FIXED: JSON.stringify body)
// --------------------
async function opsFetch(path, { method = "GET", body, headers = {} } = {}) {
  const url = `${OPS_BASE_URL}${path}`;

  const reqInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Ops-Key": OPS_KEY,
      ...headers,
    },
  };

  if (body !== undefined) {
    reqInit.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, reqInit);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { ok: res.ok, status: res.status, data };
}

// --------------------
// MCP server factory (tools registered هنا)
// --------------------
function buildMcpServer() {
  const mcp = new McpServer({ name: "hr-ops-mcp", version: "3.1.0" });

  // Health
  mcp.tool("ops_health", "Health check for Ops Gateway", z.object({}), async () => {
    const r = await opsFetch("/ops/health");
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  });

  // Logs
  mcp.tool(
    "ops_tail_log",
    "Tail laravel.log via Ops Gateway",
    z.object({ lines: z.number().min(10).max(2000).default(200) }),
    async ({ lines }) => {
      const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // Artisan (allowlisted on Laravel side)
  mcp.tool(
    "ops_run_artisan",
    "Run an allowlisted artisan command",
    z.object({ command: z.string().min(1) }),
    async ({ command }) => {
      const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // DB select
  mcp.tool(
    "ops_db_select",
    "Run SELECT query (read-only)",
    z.object({ sql: z.string().min(1) }),
    async ({ sql }) => {
      const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // File list
  mcp.tool(
    "ops_list_files",
    "List files in server path (allowed paths only)",
    z.object({ path: z.string().default("./") }),
    async ({ path }) => {
      const r = await opsFetch(`/ops/files?path=${encodeURIComponent(path)}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // Read file
  mcp.tool(
    "ops_read_file",
    "Read an allowed server-side file path",
    z.object({ path: z.string().min(1) }),
    async ({ path }) => {
      const r = await opsFetch(`/ops/file?path=${encodeURIComponent(path)}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // Write file (Dangerous, but you asked for it)
  mcp.tool(
    "ops_write_file",
    "Write full content to a file path (VERY powerful)",
    z.object({ path: z.string().min(1), content: z.string() }),
    async ({ path, content }) => {
      const r = await opsFetch("/ops/file/write", { method: "POST", body: { path, content } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  return mcp;
}

// --------------------
// Express app
// --------------------
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Mcp-Auth"],
  })
);

app.options("/mcp", (req, res) => res.sendStatus(204));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Streamable HTTP MCP endpoint (POST only)
app.post("/mcp", async (req, res) => {
  try {
    if (!isAuthed(req)) return res.status(401).send("Unauthorized");

    // Stateless transport: no sessions
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const server = buildMcpServer();

    res.on("close", async () => {
      try { await transport.close(); } catch {}
      try { await server.close?.(); } catch {}
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("❌ MCP error:", e);
    if (!res.headersSent) res.status(500).send("MCP error");
  }
});

// Optional: reject other methods clearly
app.all("/mcp", (req, res) => res.status(405).send("Method Not Allowed (use POST)"));

app.listen(PORT, () => console.log(`🚀 MCP server listening on port ${PORT}`));
