import express from "express";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  StreamableHTTPServerTransport,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * ENV:
 * OPS_BASE_URL = https://hr.estedama-sa.com/api
 * OPS_KEY      = <X-Ops-Key value>
 * (optional) MCP_ACCESS_TOKEN = <token for Agent Builder to send as Bearer>
 * PORT = 3000 (Render sets it automatically)
 */

const OPS_BASE_URL_RAW = process.env.OPS_BASE_URL || "";
const OPS_KEY = process.env.OPS_KEY || "";
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";

const OPS_BASE_URL = OPS_BASE_URL_RAW.replace(/\/+$/, ""); // remove trailing slash
const PORT = Number(process.env.PORT || 3000);

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("Missing OPS_BASE_URL or OPS_KEY env vars");
  process.exit(1);
}

// ---- optional auth for MCP endpoint (recommended later, not mandatory now)
function requireMcpAuth(req, res, next) {
  if (!MCP_ACCESS_TOKEN) return next(); // auth disabled

  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (token && token === MCP_ACCESS_TOKEN) return next();

  // allow alternative header if you prefer Custom headers:
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey && xApiKey === MCP_ACCESS_TOKEN) return next();

  return res.status(401).send("Unauthorized");
}

// ---- CORS (Agent Builder / browsers may preflight OPTIONS)
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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
app.use(express.json({ limit: "1mb" }));

// health
app.get("/", (req, res) => res.send("OK"));

// --- MCP Server
const mcpServer = new Server(
  { name: "hr-ops-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// tools/list
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
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

// tools/call
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "ops_health") {
    const r = await opsFetch("/ops/health");
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  }

  if (name === "ops_tail_log") {
    const lines = Math.max(10, Math.min(Number(args?.lines ?? 200), 2000));
    const r = await opsFetch(`/ops/log/tail?lines=${lin
