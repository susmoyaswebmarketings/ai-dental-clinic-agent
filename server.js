// Local server for the AI Dental Clinic Agent.
//   /           patient chat (front end)
//   /login      clinic owner login
//   /dashboard  owner dashboard (AI Dental Receptionist: appointments, alerts, enquiries, reminder calls, setup)
// The receptionist's prompts go to a free AI provider; clinic data is kept in data/clinic.json.
// No npm packages needed: run `node server.js` (Node 18+).
//
// Providers (set AI_PROVIDER in .env):
//   gemini     - Google Gemini free tier   (key: https://aistudio.google.com/apikey)        <- recommended
//   groq       - Groq free tier            (key: https://console.groq.com/keys)
//   openrouter - OpenRouter ":free" models (key: https://openrouter.ai/keys)
//   ollama     - runs offline on this PC, no key (https://ollama.com) - slow without a strong GPU

const http = require("http");
const fs = require("fs");
const path = require("path");

// Load .env (KEY=value lines) without extra dependencies.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    const val = m ? m[2].replace(/(^|\s)#.*$/, "").trim().replace(/^["']|["']$/g, "") : "";
    if (m && !process.env[m[1]]) process.env[m[1]] = val;
  }
}

const PROVIDERS = {
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // Tried in order; the next one is used if a model is busy (503), rate-limited (429) or retired (404).
    key: "GEMINI_API_KEY", model: "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.5-flash,gemini-flash-latest", jsonMode: true,
    extra: { reasoning_effort: "low" }
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: "GROQ_API_KEY", model: "llama-3.3-70b-versatile", jsonMode: true
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: "OPENROUTER_API_KEY", model: "meta-llama/llama-3.3-70b-instruct:free", jsonMode: false
  },
  ollama: {
    url: (process.env.OLLAMA_URL || "http://localhost:11434") + "/v1/chat/completions",
    key: null, model: "qwen2.5:7b", jsonMode: true
  }
};

const PORT = Number(process.env.PORT) || 3000;
const PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const P = PROVIDERS[PROVIDER];
if (!P) { console.error(`Unknown AI_PROVIDER "${PROVIDER}". Use: ${Object.keys(PROVIDERS).join(", ")}`); process.exit(1); }
const API_KEY = P.key ? (process.env[P.key] || "") : "local";
const MODEL = process.env.AI_MODEL || P.model;          // comma-separated list = fallbacks
const MODELS = MODEL.split(",").map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 30000; // total wait per patient message, across all fallbacks
const PER_MODEL_MS = 9000; // a healthy reply takes 1-4s; anything slower is usually stuck behind a busy model
const PUBLIC = path.join(__dirname, "public");

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 200000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Pull the first complete JSON object out of the model's text (handles ```json fences).
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function askAI(prompt, budgetMs = TIMEOUT_MS) {
  let lastErr;
  const deadline = Date.now() + budgetMs;
  for (const model of MODELS) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    try {
      const out = await askModel(model, prompt, Math.min(PER_MODEL_MS, left));
      if (MODELS.length > 1) console.log(`[${PROVIDER}] replied with ${model}`);
      return out;
    } catch (e) {
      lastErr = e;
      const retryable = [404, 429, 500, 503, 504].includes(e.status) || e.name === "TimeoutError" || e.code === "invalid_json";
      console.error(`[${PROVIDER}] ${model}: ${e.message}${retryable && model !== MODELS[MODELS.length - 1] ? " - trying next model" : ""}`);
      if (!retryable) break;
    }
  }
  throw lastErr || Object.assign(new Error("AI took too long to reply"), { status: 504 });
}

async function askModel(model, prompt, timeoutMs) {
  const headers = { "Content-Type": "application/json" };
  if (P.key) headers.Authorization = `Bearer ${API_KEY}`;
  const body = {
    model,
    temperature: 0.4,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    ...(P.extra || {})
  };
  if (P.jsonMode) body.response_format = { type: "json_object" };

  const r = await fetch(P.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const raw = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = Array.isArray(raw) ? raw[0] : raw;
    const err = new Error((e && e.error && (e.error.message || e.error)) || `${PROVIDER} error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const text = raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.content || "";
  const json = extractJson(text);
  if (!json) { const err = new Error("Model did not return valid JSON"); err.code = "invalid_json"; throw err; }
  return json;
}

const reminders = require("./reminders");
const agent = require("./agent");
const auth = require("./auth");

function page(res, file, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" });
  fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
async function jsonBody(req) {
  // Only JSON bodies are accepted, which (with the SameSite cookie) blocks cross-site form posts.
  if (!/^application\/json/i.test(req.headers["content-type"] || "")) throw Object.assign(new Error("JSON body required"), { status: 415 });
  try { return JSON.parse(await readBody(req) || "{}"); } catch { throw Object.assign(new Error("Bad JSON"), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname, M = req.method;
  try {
    // Twilio webhooks may arrive through the public tunnel; reminders.js checks them.
    if (p.startsWith("/voice/")) { if (await reminders.handle(req, res, url, readBody, sendJson)) return; }

    // Everything else is only for this PC - never through the public tunnel.
    if (!reminders.isLocal(req)) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("Forbidden"); }

    // ---- patient-facing chat (front end) ----
    if (M === "GET" && (p === "/" || p === "/chat")) return page(res, "chat.html");
    if (M === "POST" && p === "/api/chat/start") {
      const { sessionId } = await jsonBody(req);
      const s = agent.startSession(typeof sessionId === "string" ? sessionId : null);
      return sendJson(res, 200, { ...agent.publicInfo(), ...agent.sessionView(s) });
    }
    if (M === "POST" && p === "/api/chat/send") {
      const { sessionId, text } = await jsonBody(req);
      const msg = await agent.send(String(sessionId || ""), text);
      return sendJson(res, 200, { kind: msg.kind, text: msg.text, at: msg.at });
    }

    // ---- owner login ----
    if (M === "GET" && p === "/login") return auth.current(req) ? redirect(res, "/dashboard") : page(res, "login.html");
    if (M === "POST" && p === "/api/login") {
      const { email, password } = await jsonBody(req);
      const r = auth.login(req, email, password);
      if (!r.ok) return sendJson(res, 401, { error: r.error });
      res.setHeader("Set-Cookie", r.cookie);
      return sendJson(res, 200, { ok: true });
    }
    if (M === "POST" && p === "/api/logout") { res.setHeader("Set-Cookie", auth.logout(req)); return sendJson(res, 200, { ok: true }); }

    // ---- owner dashboard (login required) ----
    const user = auth.current(req);
    if (M === "GET" && p === "/dashboard") return user ? page(res, "dashboard.html") : redirect(res, "/login");
    if (p.startsWith("/api/admin/") || p.startsWith("/api/reminders")) {
      if (!user) return sendJson(res, 401, { error: "Please log in" });
      if (M !== "GET" && !/^application\/json/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "JSON body required" });
      if (p.startsWith("/api/reminders")) { if (await reminders.handle(req, res, url, readBody, sendJson)) return; }
      if (M === "GET" && p === "/api/admin/state") return sendJson(res, 200, { ...agent.adminState(), user: user.email, provider: PROVIDER });
      if (M === "GET" && p === "/api/admin/conversation") return sendJson(res, 200, { messages: agent.conversation(url.searchParams.get("lead")) });
      if (M === "POST" && p === "/api/admin/settings") { agent.saveSettings(await jsonBody(req)); return sendJson(res, 200, { ok: true }); }
      if (M === "POST" && p === "/api/admin/reset") { agent.resetDemo(); return sendJson(res, 200, { ok: true }); }
      const m = p.match(/^\/api\/admin\/alerts\/([\w-]+)\/done$/);
      if (M === "POST" && m) return sendJson(res, agent.alertDone(m[1]) ? 200 : 404, { ok: true });
    }

    if (M === "GET" && p === "/api/status") return sendJson(res, 200, { ready: Boolean(API_KEY), provider: PROVIDER });

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    if (!e.status || e.status >= 500) console.error("[server]", e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
  }
});

agent.init({ askAI, aiReady: () => Boolean(API_KEY), reminders });
const ownerNote = auth.init(envPath);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AI Dental Clinic Agent running`);
  console.log(`  Patient chat:     http://localhost:${PORT}/`);
  console.log(`  Owner dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`  ${ownerNote}`);
  console.log(API_KEY
    ? `Live AI on - provider: ${PROVIDER}, model: ${MODEL}`
    : `No ${P.key} in .env - running in scripted demo mode`);
  console.log(reminders.init({ askAI, port: PORT, onUpdate: r => agent.onCallUpdate(r) }));
});
