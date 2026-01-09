import express from "express";
import cors from "cors";
import crypto from "crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * ENV Variables:
 * OPS_BASE_URL: https://your-domain.com/api
 * OPS_KEY: Secret key matches X-Ops-Key in Laravel
 * MCP_AUTH_TOKEN: Optional protection for this server
 */
const OPS_BASE_URL_RAW = process.env.OPS_BASE_URL || "";
const OPS_KEY = process.env.OPS_KEY || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; 
const PORT = Number(process.env.PORT || 3000);

// Normalize base url
const OPS_BASE_URL = OPS_BASE_URL_RAW.replace(/\/+$/, "");

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("Error: Missing OPS_BASE_URL or OPS_KEY");
  process.exit(1);
}

// Auth Middleware
function checkMcpAuth(req, res) {
  if (!MCP_AUTH_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const apiKey = (req.headers["x-api-key"] || "").toString().trim();
  if (bearer === MCP_AUTH_TOKEN || apiKey === MCP_AUTH_TOKEN) return true;
  res.status(401).send("Unauthorized (missing/invalid MCP auth token)");
  return false;
}

// Helper to call Laravel Ops API
async function opsFetch(path, { method = "GET", body } = {}) {
  const url = `${OPS_BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Ops-Key": OPS_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err?.message || err) } };
  }
}

// ---- MCP Server Tools Definition ----
const mcp = new McpServer({
  name: "hr-ops-mcp",
  version: "1.2.0",
});

// 1. Health
mcp.tool("ops_health", "Health check for Ops Gateway", z.object({}), async () => {
  const r = await opsFetch("/ops/health");
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 2. Tail Log
mcp.tool("ops_tail_log", "Tail laravel.log", z.object({
  lines: z.number().int().min(10).max(5000).default(200),
}), async ({ lines }) => {
  const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 3. Run Artisan
mcp.tool("ops_run_artisan", "Run allowlisted artisan command", z.object({
  command: z.string().min(1),
}), async ({ command }) => {
  const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 4. DB Select
mcp.tool("ops_db_select", "Run SELECT query (read-only)", z.object({
  sql: z.string().min(1),
}), async ({ sql }) => {
  const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 5. Read File (Old single file reader)
mcp.tool("ops_read_file", "Read a specific file content", z.object({
  path: z.string().min(1),
}), async ({ path }) => {
  const encoded = encodeURIComponent(path);
  const r = await opsFetch(`/ops/file?path=${encoded}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 6. [NEW] List Files (Explore Directories)
mcp.tool("ops_list_files", "List files and directories in a path (e.g. 'app/Models')", z.object({
  path: z.string().min(1).describe("Relative path to scan, e.g. 'app' or 'routes'"),
}), async ({ path }) => {
  const encoded = encodeURIComponent(path);
  // Note: We call the NEW endpoint /ops/files
  const r = await opsFetch(`/ops/files?path=${encoded}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ---- HTTP Server Setup ----
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // Increased limit for large logs

const transports = new Map();

app.get("/", (req, res) => res.send("MCP Server is Running 🚀"));

app.post("/mcp", async (req, res) => {
  if (!checkMcpAuth(req, res)) return;
  try {
    const sessionIdHeader = (req.headers["mcp-session-id"] || "").toString();
    let transport;
    if (sessionIdHeader && transports.has(sessionIdHeader)) {
      transport = transports.get(sessionIdHeader);
    } else {
      if (!StreamableHTTPServerTransport.isInitializeRequest(req.body)) {
        res.status(400).send("Bad Request: Missing/invalid mcp-session-id");
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId) => transports.set(sessionId, transport),
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).send("MCP error");
  }
});

app.get("/mcp", async (req, res) => {
  if (!checkMcpAuth(req, res)) return;
  const sessionId = (req.headers["mcp-session-id"] || "").toString();
  const transport = transports.get(sessionId);
  if (!transport) return res.status(400).send("Unknown session");
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  if (!checkMcpAuth(req, res)) return;
  const sessionId = (req.headers["mcp-session-id"] || "").toString();
  const transport = transports.get(sessionId);
  if (!transport) return res.status(400).send("Unknown session");
  await transport.handleRequest(req, res);
  transports.delete(sessionId);
});

app.listen(PORT, () => {
  console.log(`MCP server listening on ${PORT}`);
});
