import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const OPS_BASE_URL = process.env.OPS_BASE_URL; // مثال: https://hr.estedama-sa.com/api
const OPS_KEY = process.env.OPS_KEY;
const PORT = process.env.PORT || 3000;

// (اختياري) حماية MCP نفسها بتوكن مستقل
// لو حبيت تفعلها لاحقاً: أضف MCP_TOKEN في Render Environment
const MCP_TOKEN = process.env.MCP_TOKEN || null;

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("Missing OPS_BASE_URL or OPS_KEY env vars");
  process.exit(1);
}

async function opsFetch(path, { method = "GET", body } = {}) {
  const url = `${OPS_BASE_URL}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Ops-Key": OPS_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

const app = express();
app.use(express.json());

// ---- CORS for Agent Builder / browsers ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Preflight request: reply fast
  if (req.method === "OPTIONS") return res.sendStatus(204);

  next();
});

const server = new Server(
  { name: "hr-ops-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ops_health",
      description: "Health check for Ops Gateway",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ops_tail_log",
      description: "Tail laravel.log via Ops Gateway",
      inputSchema: {
        type: "object",
        properties: { lines: { type: "integer", default: 200 } },
      },
    },
    {
      name: "ops_run_artisan",
      description: "Run an allowlisted artisan command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "ops_db_select",
      description: "Run SELECT query (read-only)",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
    {
      name: "ops_read_file",
      description: "Read an allowed server-side file path",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "ops_health") {
    const r = await opsFetch("/ops/health");
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  }

  if (name === "ops_tail_log") {
    const lines = Math.max(10, Math.min(Number(args?.lines ?? 200), 2000));
    const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  }

  if (name === "ops_run_artisan") {
    const command = String(args?.command ?? "").trim();
    const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  }

  if (name === "ops_db_select") {
    const sql = String(args?.sql ?? "");
    const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  }

  if (name === "ops_read_file") {
    const path = encodeURIComponent(String(args?.path ?? ""));
    const r = await opsFetch(`/ops/file?path=${path}`);
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// MCP endpoint
app.post("/mcp", (req, res) => {
  try {
    // (اختياري) تحقق من توكن حماية MCP لو فعلته
    if (MCP_TOKEN) {
      const auth = req.headers.authorization || "";
      const ok = auth === `Bearer ${MCP_TOKEN}`;
      if (!ok) return res.status(401).send("Unauthorized");
    }

    const transport = new StreamableHTTPServerTransport(req, res);

    // لا تستخدم await هنا حتى لا يعلق الاتصال في المتصفح/Agent Builder
    server.connect(transport).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send("MCP error");
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).send("MCP error");
  }
});

app.get("/", (req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`MCP server listening on ${PORT}`));
