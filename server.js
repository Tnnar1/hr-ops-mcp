import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const OPS_BASE_URL = process.env.OPS_BASE_URL; // مثال: https://hr.estedama-sa.com/api
const OPS_KEY = process.env.OPS_KEY;
const PORT = Number(process.env.PORT || 3000);

// (اختياري) لحماية MCP endpoint من أي أحد
// إذا وضعته: لازم ترسله من OpenAI كـ Authorization: Bearer <token>
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

function requireMcpAuth(req, res) {
  if (!MCP_TOKEN) return true; // لا يوجد حماية مفعلة

  const auth = req.headers.authorization || "";
  const ok = auth === `Bearer ${MCP_TOKEN}`;
  if (!ok) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

/** نبني MCP server جديد لكل Session/Request لتجنب مشاكل الحالة */
function buildMcpServer() {
  const server = new McpServer({ name: "hr-ops-mcp", version: "1.0.0" });

  server.tool("ops_health", "Health check for Ops Gateway", async () => {
    const r = await opsFetch("/ops/health");
    return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
  });

  server.tool(
    "ops_tail_log",
    "Tail laravel.log via Ops Gateway",
    { lines: { type: "number", default: 200, description: "10..2000" } },
    async ({ lines = 200 } = {}) => {
      const n = Math.max(10, Math.min(Number(lines || 200), 2000));
      const r = await opsFetch(`/ops/log/tail?lines=${n}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  server.tool(
    "ops_run_artisan",
    "Run an allowlisted artisan command",
    { command: { type: "string" } },
    async ({ command } = {}) => {
      const r = await opsFetch("/ops/artisan", { method: "POST", body: { command } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  server.tool(
    "ops_db_select",
    "Run SELECT query (read-only)",
    { sql: { type: "string" } },
    async ({ sql } = {}) => {
      const r = await opsFetch("/ops/db/select", { method: "POST", body: { sql } });
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  server.tool(
    "ops_read_file",
    "Read an allowed server-side file path",
    { path: { type: "string" } },
    async ({ path } = {}) => {
      const enc = encodeURIComponent(path || "");
      const r = await opsFetch(`/ops/file?path=${enc}`);
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  return server;
}

const app = express();

// مهم: نحتاج body للـ /mcp (JSON) عشان نمرره لـ transport.handleRequest
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// لاحظ: استخدمنا app.all عشان OpenAI/العملاء قد يستخدمون POST غالبًا، لكن خلّه مرن
app.all("/mcp", async (req, res) => {
  try {
    if (!requireMcpAuth(req, res)) return;

    // 1) ننشئ Transport
    const transport = new StreamableHTTPServerTransport({
      // sessionIdGenerator: undefined  // الافتراضي جيد
    });

    // 2) ننشئ MCP Server
    const server = buildMcpServer();

    // 3) نربطهم
    await server.connect(transport);

    // 4) أهم سطرين: مرّر الطلب_toggle للـ transport
    await transport.handleRequest(req, res, req.body);

    // 5) تنظيف
    res.on("close", async () => {
      try {
        await transport.close();
      } catch {}
      try {
        await server.close();
      } catch {}
    });
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent) res.status(500).send("MCP error");
  }
});

app.listen(PORT, () => {
  console.log(`hr-ops-mcp listening on port ${PORT}`);
});
