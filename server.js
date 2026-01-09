import express from "express";
import cors from "cors";
import crypto from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// -------------------- Config --------------------
const OPS_BASE_URL = (process.env.OPS_BASE_URL || "").replace(/\/+$/, "");
const OPS_KEY = process.env.OPS_KEY || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const PORT = Number(process.env.PORT || 10000);

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("❌ Missing OPS_BASE_URL or OPS_KEY");
} else {
  console.log(`✅ OPS Target: ${OPS_BASE_URL}`);
}

// -------------------- Helpers --------------------
function checkAuth(req) {
  if (!MCP_AUTH_TOKEN) return true;

  const authHeader = String(req.headers["authorization"] || "");
  const apiKeyHeader = String(req.headers["x-api-key"] || "");
  const tokenHeader = String(req.headers["x-mcp-auth"] || "");

  const cleanAuth = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cleanKey = apiKeyHeader.trim();
  const cleanToken = tokenHeader.trim();

  const ok =
    cleanAuth === MCP_AUTH_TOKEN ||
    cleanKey === MCP_AUTH_TOKEN ||
    cleanToken === MCP_AUTH_TOKEN;

  if (!ok) console.warn("🔒 Auth failed (bad token or missing header).");
  return ok;
}

async function opsFetch(path, options = {}) {
  const url = `${OPS_BASE_URL}${path}`;

  const headers = {
    "Content-Type": "application/json",
    "X-Ops-Key": OPS_KEY,
    ...(options.headers || {}),
  };

  const fetchOptions = {
    method: options.method || "GET",
    headers,
    body: options.body,
  };

  // مهم: fetch يحتاج body كـ string إذا JSON
  if (fetchOptions.body && typeof fetchOptions.body !== "string") {
    fetchOptions.body = JSON.stringify(fetchOptions.body);
  }

  const res = await fetch(url, fetchOptions);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { ok: res.ok, status: res.status, data };
}

// -------------------- MCP Server --------------------
const mcp = new McpServer({ name: "hr-ops-mcp", version: "3.1.0" });

// Tools
mcp.tool("ops_health", "Health check for Ops Gateway", z.object({}), async () => {
  const r = await opsFetch("/ops/health");
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool(
  "ops_tail_log",
  "Tail laravel.log via Ops Gateway",
  z.object({ lines: z.number().min(10).max(2000).default(200) }),
  async ({ lines }) => {
    const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool(
  "ops_run_artisan",
  "Run an allowlisted artisan command",
  z.object({ command: z.string().min(1) }),
  async ({ command }) => {
    const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool(
  "ops_db_select",
  "Run SELECT query (read-only)",
  z.object({ sql: z.string().min(1) }),
  async ({ sql }) => {
    const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool(
  "ops_list_files",
  "List files from an allowed path",
  z.object({ path: z.string().min(1) }),
  async ({ path }) => {
    const r = await opsFetch(`/ops/files?path=${encodeURIComponent(path)}`);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool(
  "ops_read_file",
  "Read an allowed server-side file",
  z.object({ path: z.string().min(1) }),
  async ({ path }) => {
    const r = await opsFetch(`/ops/file?path=${encodeURIComponent(path)}`);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool(
  "ops_write_file",
  "Write full content to a file (DANGEROUS, use carefully)",
  z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  async ({ path, content }) => {
    const r = await opsFetch("/ops/file/write", {
      method: "POST",
      body: { path, content },
    });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

// -------------------- HTTP App --------------------
const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("OK - MCP Streamable HTTP Ready ✅"));

// جلسات MCP (Streamable HTTP)
const sessions = new Map();

// ملاحظة: Streamable HTTP غالباً يكون POST فقط
app.post("/mcp", async (req, res) => {
  try {
    if (!checkAuth(req)) return res.status(401).send("Unauthorized");

    const body = req.body;

    // sessionId ممكن يجي query أو header حسب العميل
    const sessionId =
      String(req.query.sessionId || "") ||
      String(req.headers["mcp-session-id"] || "");

    // إذا فيه sessionId: هذه رسالة لاحقة للجلسة
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) return res.status(404).send("Session not found");
      await transport.handleRequest(req, res, body);
      return;
    }

    // إذا ما فيه sessionId: لازم تكون initialize
    if (!isInitializeRequest(body)) {
      return res.status(400).send("Expected initialize request");
    }

    // أنشئ Transport جديد
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        console.log("✨ MCP session initialized:", id);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      console.log("🛑 MCP session closed");
    };

    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("❌ MCP error:", e);
    res.status(500).send("MCP error");
  }
});

// لو أحد فتح /mcp بالمتصفح
app.get("/mcp", (req, res) => {
  res
    .status(405)
    .send("Use POST /mcp (Streamable HTTP). This endpoint is not SSE.");
});

app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
