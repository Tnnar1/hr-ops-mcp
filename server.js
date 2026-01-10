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
const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();
const PORT = Number(process.env.PORT || 10000);

if (!OPS_BASE_URL || !OPS_KEY) {
  console.error("❌ Missing OPS_BASE_URL or OPS_KEY.");
  process.exit(1);
}

console.log(`✅ Ops Server Running (Stateless Mode). Target: ${OPS_BASE_URL}`);

// --------------------
// Auth Helper
// --------------------
function isAuthed(req) {
  if (!MCP_AUTH_TOKEN) return true;
  const authHeader = String(req.headers["authorization"] || "");
  const apiKeyHeader = String(req.headers["x-api-key"] || "");
  const cleanAuth = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cleanKey = apiKeyHeader.trim();
  return cleanAuth === MCP_AUTH_TOKEN || cleanKey === MCP_AUTH_TOKEN;
}

// --------------------
// Smart Fetch Helper
// --------------------
async function opsFetch(path, { method = "GET", body, headers = {} } = {}) {
  const url = `${OPS_BASE_URL}${path}`;
  
  // Log request for debugging
  console.log(`📡 Sending to Laravel: ${method} ${path}`);

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

  try {
    const res = await fetch(url, reqInit);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
      console.error(`❌ Fetch Failed: ${e.message}`);
      return { ok: false, data: { error: e.message } };
  }
}

// --------------------
// MCP Server Factory (Forgiving Inputs)
// --------------------
function buildMcpServer() {
  const mcp = new McpServer({ name: "hr-ops-mcp", version: "3.3.0" });

  mcp.tool("ops_health", "Health check", z.object({}), async () => {
    const r = await opsFetch("/ops/health");
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  });

  // Logs
  mcp.tool("ops_tail_log", "Tail laravel.log", 
    z.object({ lines: z.number().default(200) }), 
    async ({ lines }) => {
      const r = await opsFetch(`/ops/log/tail?lines=${lines}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // Artisan
  mcp.tool("ops_run_artisan", "Run artisan command", 
    z.object({ command: z.string() }), 
    async ({ command }) => {
      const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // DB Select (يقبل sql أو query ليمنع الخطأ)
  mcp.tool("ops_db_select", "Run SQL SELECT", 
    z.object({ 
        sql: z.string().optional(), 
        query: z.string().optional() 
    }), 
    async (args) => {
      // نأخذ الموجود سواء سماه sql أو query
      let finalSql = args.sql || args.query || "";
      
      // إصلاح مشكلة SHOW TABLES
      if (finalSql.trim().toUpperCase().startsWith("SHOW TABLES")) {
          finalSql = "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()";
      }

      const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql: finalSql } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // List Files (يقبل path أو dir ليمنع الخطأ)
  mcp.tool("ops_list_files", "List files", 
    z.object({ 
        path: z.string().optional(),
        dir: z.string().optional() 
    }), 
    async (args) => {
      const finalPath = args.path || args.dir || "./";
      const r = await opsFetch(`/ops/files?path=${encodeURIComponent(finalPath)}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  // Read File (يقبل path أو file)
  mcp.tool("ops_read_file", "Read file content", 
    z.object({ 
        path: z.string().optional(),
        file: z.string().optional()
    }), 
    async (args) => {
      const finalPath = args.path || args.file || "";
      const r = await opsFetch(`/ops/file?path=${encodeURIComponent(finalPath)}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  mcp.tool("ops_write_file", "Write file", 
    z.object({ path: z.string(), content: z.string() }), 
    async ({ path, content }) => {
      const r = await opsFetch("/ops/file/write", { method: "POST", body: { path, content } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  return mcp;
}

// --------------------
// Express App (Stateless Mode)
// --------------------
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("MCP Server v3.3 (Stateless) Ready 🛡️"));

// نقطة الاتصال الرئيسية: تعالج كل طلب بشكل مستقل
app.post("/mcp", async (req, res) => {
  if (!isAuthed(req)) return res.status(401).send("Unauthorized");
  
  try {
    // إنشاء سيرفر مؤقت لكل طلب (يضمن عدم فشل الجلسة)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    
    // إغلاق الموارد عند انتهاء الطلب
    res.on("close", async () => { 
        try { await transport.close(); } catch {}
        try { await server.close?.(); } catch {}
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP Error:", e);
    if (!res.headersSent) res.status(500).send("Error");
  }
});

// دعم لطلبات GET (مطلوب لبعض العملاء لبدء المصافحة)
app.get("/mcp", async (req, res) => {
    if (!isAuthed(req)) return res.status(401).send("Unauthorized");
    
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    
    // إبقاء الاتصال مفتوحاً شكلياً لإرضاء البروتوكول
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
});

app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
