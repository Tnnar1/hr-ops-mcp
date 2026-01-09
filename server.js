import express from "express";
import cors from "cors";
import crypto from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --- Configuration ---
const OPS_BASE_URL = (process.env.OPS_BASE_URL || "").replace(/\/+$/, "");
const OPS_KEY = process.env.OPS_KEY || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; 
const PORT = Number(process.env.PORT || 10000);

if (!OPS_BASE_URL || !OPS_KEY) {
    console.error("❌ Critical: OPS_BASE_URL or OPS_KEY Env Vars Missing!");
} else {
    console.log(`✅ Config Loaded. OPS Target: ${OPS_BASE_URL}`);
}

// --- Fetch Helper ---
async function opsFetch(path, options = {}) {
  const url = `${OPS_BASE_URL}${path}`;
  console.log(`📡 Proxying request to Laravel: ${path}`);
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 
          "Content-Type": "application/json", 
          "X-Ops-Key": OPS_KEY, 
          ...options.headers 
      },
    });
    
    if (!res.ok) {
        console.error(`⚠️ Laravel Error ${res.status}: ${res.statusText}`);
        return { error: `Laravel Error: ${res.status}`, details: await res.text() };
    }

    const text = await res.text();
    try { 
        return JSON.parse(text); 
    } catch { 
        return { error: "Invalid JSON from Laravel", raw: text }; 
    }
  } catch (err) { 
      console.error(`❌ Fetch Error: ${err}`);
      return { error: String(err) }; 
  }
}

const mcp = new McpServer({ name: "hr-ops-mcp", version: "3.0.0" });

// --- Tools Definitions ---

mcp.tool("ops_health", "Check health", z.object({}), async () => {
  const r = await opsFetch("/ops/health");
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("ops_list_files", "List files", z.object({ path: z.string() }), async ({ path }) => {
  const r = await opsFetch(`/ops/files?path=${encodeURIComponent(path)}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("ops_read_file", "Read file", z.object({ path: z.string() }), async ({ path }) => {
  const r = await opsFetch(`/ops/file?path=${encodeURIComponent(path)}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ✍️ أداة الكتابة
mcp.tool("ops_write_file", "Write content to file (Full)", z.object({
  path: z.string().describe("Relative path e.g. app/Models/User.php"),
  content: z.string().describe("Full file content")
}), async ({ path, content }) => {
  const r = await opsFetch("/ops/file/write", { method: "POST", body: { path, content } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("ops_run_artisan", "Run artisan", z.object({ command: z.string() }), async ({ command }) => {
  const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("ops_db_select", "Run SQL", z.object({ sql: z.string() }), async ({ sql }) => {
  const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("ops_tail_log", "Read log", z.object({ lines: z.number().default(200) }), async ({ lines }) => {
  const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// --- Server Setup ---
const app = express();

// إعدادات CORS مفتوحة بالكامل لتجنب مشاكل المتصفحات والأدوات
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
}));

app.use(express.json({ limit: "50mb" }));

// Middleware لتسجيل كل الطلبات الواردة (للتشخيص)
app.use((req, res, next) => {
    console.log(`📥 Incoming ${req.method} request to: ${req.path}`);
    next();
});

// صفحة ترحيب للتأكد من العمل
app.get("/", (req, res) => res.send("MCP v3.0 Writer Mode - Ready 🚀"));

const transports = new Map();

// دالة تحقق مرنة للمصادقة
function checkAuth(req) {
  if (!MCP_AUTH_TOKEN) {
      console.log("🔓 Auth Skipped: No MCP_AUTH_TOKEN env var set.");
      return true;
  }

  const authHeader = req.headers['authorization'] || "";
  const apiKeyHeader = req.headers['x-api-key'] || "";

  // تنظيف التوكن من كلمة Bearer ومسافات
  const cleanAuth = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cleanKey = apiKeyHeader.trim();

  const isValid = cleanAuth === MCP_AUTH_TOKEN || cleanKey === MCP_AUTH_TOKEN;

  if (!isValid) {
      console.warn(`🔒 Auth Failed! Expected token ending in ...${MCP_AUTH_TOKEN.slice(-4)}. Received: ${cleanAuth ? 'Auth Header' : 'No Header'}`);
  } else {
      console.log("🔑 Auth Successful");
  }

  return isValid;
}

// نقطة الاتصال SSE (GET)
app.get("/mcp", async (req, res) => {
  if (!checkAuth(req)) return res.status(401).send("Unauthorized");

  console.log("📡 Establishing SSE Connection...");

  // إعداد الهيدرز يدوياً لضمان عدم حدوث Timeout في Render
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
        console.log(`✨ New Session Initialized: ${id}`);
        transports.set(id, transport);
    },
  });
   
  transport.onclose = () => {
      console.log("🛑 Session Closed");
      transports.delete(transport.sessionId);
  };

  await mcp.connect(transport);
  
  // معالجة الطلب عبر الترانسبورت
  await transport.handleRequest(req, res);
});

// نقطة الأوامر JSON-RPC (POST)
app.post("/mcp", async (req, res) => {
  if (!checkAuth(req)) return res.status(401).send("Unauthorized");

  const sessionId = req.query.sessionId;
  console.log(`📨 Message Received for Session: ${sessionId}`);

  const transport = transports.get(String(sessionId));

  if (!transport) {
    console.error("❌ Session Not Found for POST request");
    return res.status(404).send("Session not found");
  }

  await transport.handleRequest(req, res);
});

app.listen(PORT, () => console.log(`🚀 Server Listening on port ${PORT}`));
