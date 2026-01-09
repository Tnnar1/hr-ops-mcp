import express from "express";
import cors from "cors";
import crypto from "crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// إعدادات البيئة
const OPS_BASE_URL_RAW = process.env.OPS_BASE_URL || "";
const OPS_KEY = process.env.OPS_KEY || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; 
const PORT = Number(process.env.PORT || 3000);

const OPS_BASE_URL = OPS_BASE_URL_RAW.replace(/\/+$/, "");

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("Error: Missing OPS_BASE_URL or OPS_KEY");
}

// دالة التحقق من التوكن (الحماية)
function checkMcpAuth(req, res) {
  if (!MCP_AUTH_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const apiKey = (req.headers["x-api-key"] || "").toString().trim();
  if (bearer === MCP_AUTH_TOKEN || apiKey === MCP_AUTH_TOKEN) return true;
  res.status(401).send("Unauthorized");
  return false;
}

// دالة الاتصال بـ Laravel
async function opsFetch(path, { method = "GET", body } = {}) {
  const url = `${OPS_BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-Ops-Key": OPS_KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; } 
    catch { return { ok: res.ok, status: res.status, data: text }; }
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err) } };
  }
}

// --- تعريف السيرفر والأدوات ---
const mcp = new McpServer({ name: "hr-ops-mcp", version: "1.2.0" });

// 1. Health
mcp.tool("ops_health", "Health check", z.object({}), async () => {
  const r = await opsFetch("/ops/health");
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 2. Tail Log
mcp.tool("ops_tail_log", "Read log", z.object({ lines: z.number().default(200) }), async ({ lines }) => {
  const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 3. Artisan
mcp.tool("ops_run_artisan", "Run artisan", z.object({ command: z.string() }), async ({ command }) => {
  const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 4. DB Select
mcp.tool("ops_db_select", "Run SELECT SQL", z.object({ sql: z.string() }), async ({ sql }) => {
  const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 5. Read File
mcp.tool("ops_read_file", "Read file", z.object({ path: z.string() }), async ({ path }) => {
  const r = await opsFetch(`/ops/file?path=${encodeURIComponent(path)}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// 6. List Files (الأداة المهمة جداً)
mcp.tool("ops_list_files", "List files in directory", z.object({ path: z.string() }), async ({ path }) => {
  const r = await opsFetch(`/ops/files?path=${encodeURIComponent(path)}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// --- إعداد HTTP Server (هنا كان الخطأ وتم إصلاحه) ---
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => res.send("MCP Server Fixed & Running 🚀"));

const transports = new Map();

app.post("/mcp", async (req, res) => {
  if (!checkMcpAuth(req, res)) return;
  try {
    const sessionId = (req.headers["mcp-session-id"] || "").toString();
    let transport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else {
      // FIX: هذا هو التعديل. نتحقق يدوياً بدلاً من استخدام الدالة المكسورة
      // نتأكد أن الطلب هو "initialize"
      if (req.body?.method !== "initialize") {
         // إذا لم يكن initialize وليس لدينا جلسة، فهذا خطأ
         // لكن أحياناً OpenAI يرسل طلبات أخرى، لذا سنحاول إنشاء جلسة احتياطاً
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      await mcp.connect(transport);
    }
    
    await transport.handleRequest(req, res, req.body);
  } catch (e) { 
    console.error("MCP Error:", e); 
    if (!res.headersSent) res.status(500).send("Internal Server Error"); 
  }
});

app.get("/mcp", async (req, res) => {
  if (!checkMcpAuth(req, res)) return;
  const transport = transports.get((req.headers["mcp-session-id"] || "").toString());
  if (!transport) return res.status(400).send("No session found");
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
