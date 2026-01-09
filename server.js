import express from "express";
import cors from "cors";
import crypto from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --- إعدادات البيئة ---
const OPS_BASE_URL = (process.env.OPS_BASE_URL || "").replace(/\/+$/, "");
const OPS_KEY = process.env.OPS_KEY || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; 
const PORT = Number(process.env.PORT || 10000);

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("❌ Error: Missing OPS_BASE_URL or OPS_KEY");
}

// --- دالة الاتصال المحسنة (تعالج مشاكل JSON) ---
async function opsFetch(path, options = {}) {
  const url = `${OPS_BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 
        "Content-Type": "application/json", 
        "X-Ops-Key": OPS_KEY,
        ...options.headers 
      },
    });
    const text = await res.text();
    // محاولة قراءة JSON، وإذا فشل نعيد النص لمعرفة الخطأ
    try { return JSON.parse(text); } catch { return { error: "Invalid JSON response", raw: text, status: res.status }; }
  } catch (err) {
    return { error: String(err) };
  }
}

// --- تعريف السيرفر ---
const mcp = new McpServer({ name: "hr-ops-mcp", version: "2.2.0" });

// 1. Health
mcp.tool("ops_health", "Check connection health", z.object({}), async () => {
  const r = await opsFetch("/ops/health");
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 2. Tail Log
mcp.tool("ops_tail_log", "Get last log lines", z.object({ lines: z.number().default(200) }), async ({ lines }) => {
  const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 3. Artisan
mcp.tool("ops_run_artisan", "Run artisan command", z.object({ command: z.string() }), async ({ command }) => {
  const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 4. DB Select
mcp.tool("ops_db_select", "Run SELECT query", z.object({ sql: z.string() }), async ({ sql }) => {
  const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 5. Read File
mcp.tool("ops_read_file", "Read file content", z.object({ path: z.string() }), async ({ path }) => {
  const r = await opsFetch(`/ops/file?path=${encodeURIComponent(path)}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 6. List Files (محسنة لتدعم المسارات المعقدة)
mcp.tool("ops_list_files", "List files in directory", z.object({ path: z.string() }), async ({ path }) => {
  const r = await opsFetch(`/ops/files?path=${encodeURIComponent(path)}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 7. [NEW] Write File (الأداة الجديدة للمبرمج) ✍️
mcp.tool("ops_write_file", "Write or Overwrite file content (Full Path)", z.object({
  path: z.string().describe("Relative path e.g. app/Models/User.php"),
  content: z.string().describe("The full content of the file")
}), async ({ path, content }) => {
  const r = await opsFetch("/ops/file/write", { 
    method: "POST", 
    body: { path, content } 
  });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// --- HTTP Server Setup ---
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // زيادة الحجم للسماح بكتابة ملفات كبيرة

app.get("/", (req, res) => res.send("MCP Server (Writer Mode) Active 🚀"));

const transports = new Map();

// توحيد التحقق من المصادقة
function checkAuth(req) {
  if (!MCP_AUTH_TOKEN) return true;
  const h = req.headers['authorization'] || "";
  const k = req.headers['x-api-key'] || "";
  return h.includes(MCP_AUTH_TOKEN) || k.includes(MCP_AUTH_TOKEN);
}

app.post("/mcp", async (req, res) => {
  if (!checkAuth(req)) return res.status(401).send("Unauthorized");

  const sessionId = req.query.sessionId || req.headers["mcp-session-id"];
  let transport;

  // منطق الجلسة (Session Logic)
  if (sessionId && transports.has(String(sessionId))) {
    transport = transports.get(String(sessionId));
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    transport.onclose = () => transports.delete(transport.sessionId);
    await mcp.connect(transport);
  }

  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling request:", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal MCP Error" });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
