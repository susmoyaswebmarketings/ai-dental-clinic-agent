// Reminder calls: rings the patient's mobile before the appointment (via Twilio),
// reads the reminder in their language, and records "confirm / cancel / reschedule"
// from their voice or keypad. The spoken answer is understood by the same AI the chat uses.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const DATA_FILE = path.join(__dirname, "reminders.json");
const SID = process.env.TWILIO_ACCOUNT_SID || "";
const TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const FROM = process.env.TWILIO_FROM_NUMBER || "";
const MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE) || 120;
const RETRY_MINUTES = 10;   // one retry if the patient doesn't pick up
const MAX_ATTEMPTS = 2;

let publicUrl = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
let askAI = null;           // injected by server.js
let tunnelNote = "";

// ---------- storage ----------
let items = [];
try { items = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { items = []; }
// Saving also tells the clinic data (agent.js) about every reminder whose status changed,
// so the calendar and staff alerts update when a patient confirms or cancels on the call.
let onUpdate = () => {};
const notified = {};
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
  for (const r of items) {
    if (notified[r.id] === r.status) continue;
    notified[r.id] = r.status;
    try { onUpdate(r); } catch (e) { console.error("[reminder] update hook:", e.message); }
  }
}
// Schedule one reminder call. Replaces any still-pending call for the same appointment.
function schedule({ apptId, name, contact, date, time, dentist, service, language, clinic }) {
  if (!/^\+?91\s?\d{5}\s?\d{5}$/.test(String(contact || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("bad reminder");
  items = items.filter(r => !(r.apptId === apptId && r.date === date && r.time === time && ["scheduled", "retry"].includes(r.status)));
  const r = { id: "R" + Date.now().toString(36), apptId, name: String(name).slice(0, 60), contact, date, time, dentist: String(dentist).slice(0, 60),
    service: String(service || "").slice(0, 60), language: langOf(language), clinic: String(clinic || "the dental clinic").slice(0, 60),
    callAt: apptTime({ date, time }) - MINUTES_BEFORE * 60000, status: "scheduled", attempts: 0, created: Date.now() };
  log(r, `Reminder call scheduled for ${new Date(r.callAt).toLocaleString("en-IN")}`);
  items.push(r); save();
  return r;
}
const byId = id => items.find(r => r.id === id);
function log(r, text) { r.log = r.log || []; r.log.push({ at: new Date().toISOString(), text }); }
// Every Twilio request and our answer, for troubleshooting calls (calls.log next to this file).
const CALL_LOG = path.join(__dirname, "calls.log");
function callLog(text) {
  const line = `${new Date().toLocaleTimeString("en-IN", { hour12: false })} ${text}`;
  console.log("[call] " + line);
  try { fs.appendFileSync(CALL_LOG, line + "\n"); } catch {}
}

// ---------- language ----------
const VOICES = {
  en: { lang: "en-IN", voice: "Google.en-IN-Standard-A" },
  hi: { lang: "hi-IN", voice: "Google.hi-IN-Standard-A" },
  bn: { lang: "bn-IN", voice: "Google.bn-IN-Standard-A" }
};
const langOf = l => (l === "hi" || l === "bn" ? l : l === "mixed" ? "bn" : "en");

function spokenTime(time, lang) {
  const [H, M] = time.split(":").map(Number);
  const h12 = ((H + 11) % 12) + 1, mm = M ? ":" + String(M).padStart(2, "0") : "";
  if (lang === "hi") return `${H < 12 ? "सुबह" : H < 16 ? "दोपहर" : H < 19 ? "शाम" : "रात"} ${h12}${mm} बजे`;
  if (lang === "bn") return `${H < 12 ? "সকাল" : H < 16 ? "দুপুর" : H < 19 ? "বিকেল" : "সন্ধ্যা"} ${h12}${mm}-টায়`;
  return `${h12}${mm} ${H < 12 ? "A M" : "P M"}`;
}
function spokenDay(date, lang) {
  const d = new Date(date + "T00:00:00"), t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return { en: "today", hi: "आज", bn: "আজ" }[lang];
  if (diff === 1) return { en: "tomorrow", hi: "कल", bn: "আগামীকাল" }[lang];
  return d.toLocaleDateString(lang === "en" ? "en-IN" : lang + "-IN", { weekday: "long", day: "numeric", month: "long" });
}

const T = {
  intro: (r, L) => ({
    en: `Hello ${r.name}. This is an automated reminder call from ${r.clinic}. You have a dental appointment ${spokenDay(r.date, L)} at ${spokenTime(r.time, L)} with ${r.dentist}.`,
    hi: `नमस्ते ${r.name}। यह ${r.clinic} की ओर से ऑटोमेटेड रिमाइंडर कॉल है। ${spokenDay(r.date, L)} ${spokenTime(r.time, L)} ${r.dentist} के साथ आपका डेंटल अपॉइंटमेंट है।`,
    bn: `নমস্কার ${r.name}। ${r.clinic} থেকে এটি একটি স্বয়ংক্রিয় রিমাইন্ডার কল। ${spokenDay(r.date, L)} ${spokenTime(r.time, L)} ${r.dentist}-এর সঙ্গে আপনার ডেন্টাল অ্যাপয়েন্টমেন্ট আছে।`
  })[L],
  ask: L => ({
    en: "Will you be coming? Say yes, or press 1 to confirm. Press 2 to cancel. Press 3 to change the time.",
    hi: "क्या आप आएँगे? कन्फर्म करने के लिए हाँ बोलें या 1 दबाएँ। कैंसिल करने के लिए 2 दबाएँ। समय बदलने के लिए 3 दबाएँ।",
    bn: "আপনি কি আসছেন? কনফার্ম করতে হ্যাঁ বলুন বা ১ টিপুন। বাতিল করতে ২ টিপুন। সময় বদলাতে ৩ টিপুন।"
  })[L],
  confirm: (r, L) => ({
    en: `Thank you. Your appointment is confirmed for ${spokenTime(r.time, L)}. Please arrive 10 minutes early. Goodbye.`,
    hi: `धन्यवाद। ${spokenTime(r.time, L)} का आपका अपॉइंटमेंट कन्फर्म है। कृपया 10 मिनट पहले आएँ। नमस्ते।`,
    bn: `ধন্যবাদ। ${spokenTime(r.time, L)} আপনার অ্যাপয়েন্টমেন্ট কনফার্ম হয়েছে। দয়া করে ১০ মিনিট আগে আসবেন। নমস্কার।`
  })[L],
  cancel: L => ({
    en: "Your appointment is cancelled. We will send you a WhatsApp message so you can book another time. Goodbye.",
    hi: "आपका अपॉइंटमेंट कैंसिल कर दिया गया है। नया समय बुक करने के लिए हम आपको व्हाट्सऐप पर मैसेज भेजेंगे। नमस्ते।",
    bn: "আপনার অ্যাপয়েন্টমেন্ট বাতিল করা হয়েছে। নতুন সময় বুক করার জন্য আমরা আপনাকে হোয়াটসঅ্যাপে মেসেজ পাঠাব। নমস্কার।"
  })[L],
  reschedule: L => ({
    en: "No problem. Our front desk will contact you on WhatsApp shortly to choose a new time. Goodbye.",
    hi: "कोई बात नहीं। नया समय चुनने के लिए हमारा फ्रंट डेस्क जल्द ही आपसे व्हाट्सऐप पर संपर्क करेगा। नमस्ते।",
    bn: "কোনো অসুবিধা নেই। নতুন সময় ঠিক করতে আমাদের ফ্রন্ট ডেস্ক শিগগিরই হোয়াটসঅ্যাপে আপনার সঙ্গে যোগাযোগ করবে। নমস্কার।"
  })[L],
  sorry: L => ({ en: "Sorry, I didn't catch that.", hi: "माफ़ कीजिए, मैं समझ नहीं पाया।", bn: "দুঃখিত, বুঝতে পারলাম না।" })[L],
  noReply: L => ({
    en: "We didn't get a reply. Our clinic team will contact you on WhatsApp. Goodbye.",
    hi: "हमें जवाब नहीं मिला। हमारी क्लिनिक टीम आपसे व्हाट्सऐप पर संपर्क करेगी। नमस्ते।",
    bn: "আমরা কোনো উত্তর পাইনি। আমাদের ক্লিনিক টিম হোয়াটসঅ্যাপে আপনার সঙ্গে যোগাযোগ করবে। নমস্কার।"
  })[L]
};

// ---------- TwiML ----------
const x = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const say = (text, L) => `<Say voice="${VOICES[L].voice}" language="${VOICES[L].lang}">${x(text)}</Say>`;
const twiml = body => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
function gather(r, L, lead, tries) {
  const action = `${publicUrl}/voice/answer?id=${encodeURIComponent(r.id)}&amp;try=${tries}`;
  return `<Gather input="speech dtmf" numDigits="1" timeout="6" speechTimeout="auto" language="${VOICES[L].lang}" action="${action}" method="POST">${say(lead + " " + T.ask(L), L)}</Gather>`
    + (tries < 2 ? `<Redirect method="POST">${publicUrl}/voice/answer?id=${encodeURIComponent(r.id)}&amp;try=${tries}&amp;silent=1</Redirect>` : say(T.noReply(L), L));
}

// ---------- understanding the answer ----------
const RE = {
  reschedule: /reschedul|change|another time|other time|later|postpone|badal|bodol|बदल|दूसरा|অন্য সময়|সময় বদল|পরে/i,
  cancel: /cancel|can'?t come|cannot come|not coming|nahi|nahin|नहीं|रद्द|कैंसिल|না|বাতিল|আসতে পারব না|ক্যানসেল/i,
  confirm: /\b(yes|yeah|yep|sure|ok|okay|confirm|coming|will come|haan|ha|ji)\b|हाँ|हां|जी|आऊँगा|आऊंगी|आएंगे|ठीक|হ্যাঁ|হ্যা|আসব|আসছি|ঠিক আছে|কনফার্ম/i
};
async function intentOf(digits, speech, L) {
  if (digits === "1") return "confirm";
  if (digits === "2") return "cancel";
  if (digits === "3") return "reschedule";
  if (!speech) return "unclear";
  if (askAI) {
    try {
      const out = await askAI(`A dental clinic called a patient to remind them of today's appointment and asked whether they will come. ` +
        `The patient answered (speech-to-text, language ${VOICES[L].lang}): "${speech}".\n` +
        `Classify the answer. Reply with ONLY JSON: {"intent": "confirm"|"cancel"|"reschedule"|"unclear"}. ` +
        `"reschedule" = they want a different time or day. "cancel" = they will not come and did not ask for another time.`, 8000);
      if (out && ["confirm", "cancel", "reschedule", "unclear"].includes(out.intent)) return out.intent;
    } catch { /* fall back to keywords */ }
  }
  for (const k of ["reschedule", "cancel", "confirm"]) if (RE[k].test(speech)) return k;
  return "unclear";
}

// ---------- Twilio ----------
const twilioReady = () => Boolean(SID && TOKEN && FROM);
async function placeCall(r) {
  if (!twilioReady()) throw new Error("Twilio keys missing in .env");
  if (!publicUrl) throw new Error("No public URL yet (install cloudflared, or set PUBLIC_URL in .env)");
  const to = "+" + r.contact.replace(/\D/g, "");
  const form = new URLSearchParams({
    To: to, From: FROM,
    Url: `${publicUrl}/voice/reminder?id=${encodeURIComponent(r.id)}`,
    // Twilio POSTs here when the call ends; CallStatus says completed / busy / no-answer / failed.
    // (No StatusCallbackMethod: POST is the default, and trial accounts reject that parameter.)
    StatusCallback: `${publicUrl}/voice/status?id=${encodeURIComponent(r.id)}`,
    StatusCallbackEvent: "completed"
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: form, signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
  return data.sid;
}

// Twilio signs every webhook; reject anything that isn't from Twilio.
function validTwilio(req, params) {
  const sig = req.headers["x-twilio-signature"];
  if (!sig || !TOKEN || !publicUrl) return false;
  // Twilio may sign the URL with or without the default port (:443), so accept either form,
  // exactly as Twilio's own helper libraries do.
  const base = publicUrl + req.url;
  const withPort = base.replace(/^(https:\/\/[^/:]+)(\/)/, "$1:443$2");
  const tail = Object.keys(params).sort().map(k => k + params[k]).join("");
  const ok = [base, withPort].some(u => {
    const expected = crypto.createHmac("sha1", TOKEN).update(Buffer.from(u + tail, "utf8")).digest("base64");
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  return ok;
}

async function dial(r, reason) {
  r.attempts = (r.attempts || 0) + 1;
  r.status = "calling"; r.lastTry = Date.now();
  log(r, `Calling ${r.contact} (${reason}, attempt ${r.attempts})`); save();
  try { r.callSid = await placeCall(r); log(r, "Phone is ringing"); callLog(`DIAL ${r.id} → ${r.contact} via ${publicUrl}`); }
  catch (e) { r.status = "failed"; r.error = e.message; log(r, "Call failed: " + e.message); callLog(`DIAL ${r.id} failed: ${e.message}`); }
  save();
}

// ---------- scheduler ----------
const apptTime = r => new Date(`${r.date}T${r.time}:00`).getTime();
function tick() {
  const now = Date.now();
  for (const r of items) {
    if (apptTime(r) <= now) { if (["scheduled", "retry"].includes(r.status)) { r.status = "missed"; log(r, "Appointment time passed before the call"); save(); } continue; }
    if (r.status === "scheduled" && now >= r.callAt) {
      if (!publicUrl) continue; // wait for the tunnel instead of failing the call
      dial(r, `${MINUTES_BEFORE} min before`);
    }
    else if (r.status === "retry" && now >= r.nextTry) dial(r, "retry");
  }
}

// ---------- public tunnel (cloudflared quick tunnel, free, no account) ----------
function startTunnel(port) {
  if (publicUrl) { tunnelNote = `Public URL (from .env): ${publicUrl}`; return; }
  // Find cloudflared even if this terminal was opened before it was installed (PATH not refreshed yet).
  const exe = [process.env.CLOUDFLARED_PATH,
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "cloudflared", "cloudflared.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "cloudflared", "cloudflared.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "cloudflared.exe")
  ].find(p => p && fs.existsSync(p)) || "cloudflared";
  tunnelNote = "Starting public URL (cloudflared)…";
  let proc;
  try { proc = spawn(exe,["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { windowsHide: true }); }
  catch { tunnelNote = "cloudflared not installed"; return; }
  proc.on("error", () => { tunnelNote = "cloudflared not installed - real calls can't send answers back. Install: winget install Cloudflare.cloudflared"; console.log(tunnelNote); });
  const grab = buf => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !publicUrl) { publicUrl = m[0]; tunnelNote = `Public URL for Twilio: ${publicUrl}`; console.log(tunnelNote); }
  };
  proc.stdout.on("data", grab); proc.stderr.on("data", grab);
  process.on("exit", () => { try { proc.kill(); } catch {} });
}

// ---------- HTTP handlers (called by server.js) ----------
function readForm(body) { return Object.fromEntries(new URLSearchParams(body)); }
const isLocal = req => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "") && !req.headers["cf-connecting-ip"];

async function handle(req, res, url, readBody, sendJson) {
  const p = url.pathname;

  // Owner dashboard API - server.js only lets logged-in owners on this PC reach it (it holds patient numbers).
  if (p.startsWith("/api/reminders")) {
    if (!isLocal(req)) return sendJson(res, 403, { error: "forbidden" }), true;
    if (req.method === "GET") {
      return sendJson(res, 200, { ready: twilioReady() && Boolean(publicUrl), twilio: twilioReady(), publicUrl: Boolean(publicUrl), note: tunnelNote, minutesBefore: MINUTES_BEFORE, items }), true;
    }
    if (p === "/api/reminders" && req.method === "POST") {
      try { return sendJson(res, 200, schedule(JSON.parse(await readBody(req) || "{}"))), true; }
      catch (e) { return sendJson(res, 400, { error: e.message }), true; }
    }
    const m = p.match(/^\/api\/reminders\/([^/]+)\/(call|cancel)$/);
    const r = m && byId(m[1]);
    if (!r) return sendJson(res, 404, { error: "not found" }), true;
    if (m[2] === "call") { r.attempts = 0; await dial(r, "test call from dashboard"); return sendJson(res, 200, r), true; }
    if (m[2] === "cancel") { r.status = "off"; log(r, "Reminder call switched off"); save(); return sendJson(res, 200, r), true; }
  }

  // Twilio webhooks (reach this PC through the public tunnel). Twilio may use POST or GET.
  if (p.startsWith("/voice/")) {
    // For GET, Twilio's parameters are in the URL and the signature covers the URL only.
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    const bodyParams = readForm(rawBody);
    const params = { ...Object.fromEntries(url.searchParams), ...bodyParams };
    callLog(`${req.method} ${req.url} | host=${req.headers.host} | ${params.CallStatus || ""}${params.Digits ? " digits=" + params.Digits : ""}${params.SpeechResult ? ' said="' + params.SpeechResult + '"' : ""}`);
    const r = byId(url.searchParams.get("id"));
    // Genuine if Twilio's signature matches, OR if the request carries our Account SID and the exact
    // CallSid of the call we placed for this reminder (a 34-character id only Twilio and we know).
    const sigOk = validTwilio(req, bodyParams);
    const sidOk = !sigOk && r && r.callSid && params.CallSid === r.callSid && params.AccountSid === SID;
    if (!sigOk && !sidOk) {
      callLog(`  → 403 rejected (signature + CallSid check failed). keys=${Object.keys(bodyParams).sort().join(",")}`);
      res.writeHead(403); res.end(); return true;
    }
    if (!sigOk) callLog(`  signature mismatch. sig=${req.headers["x-twilio-signature"] || "none"} body=${rawBody}`);
    if (sidOk) callLog("  accepted by matching CallSid");
    const xml = s => { callLog(`  → 200 ${s.slice(0, 160)}`); res.writeHead(200, { "Content-Type": "text/xml" }); res.end(twiml(s)); };
    if (!r) return xml("<Hangup/>"), true;
    const L = r.language;

    if (p === "/voice/reminder") { log(r, "Patient picked up"); r.status = "in-call"; save(); return xml(gather(r, L, T.intro(r, L), 1)), true; }

    if (p === "/voice/answer") {
      const tries = Number(url.searchParams.get("try")) || 1;
      const digits = params.Digits || "", speech = params.SpeechResult || "";
      if (url.searchParams.get("silent")) { return xml(gather(r, L, T.sorry(L), tries + 1)), true; }
      const intent = await intentOf(digits, speech, L);
      log(r, `Patient answered: ${digits ? "pressed " + digits : `"${speech}"`} → ${intent}`);
      if (intent === "unclear") {
        if (tries < 2) { save(); return xml(gather(r, L, T.sorry(L), tries + 1)), true; }
        r.status = "no-response"; r.answer = speech || digits; save();
        return xml(say(T.noReply(L), L) + "<Hangup/>"), true;
      }
      r.status = { confirm: "confirmed", cancel: "cancelled", reschedule: "reschedule" }[intent];
      r.answer = speech || "pressed " + digits; save();
      return xml(say(intent === "confirm" ? T.confirm(r, L) : T[intent](L), L) + "<Hangup/>"), true;
    }

    if (p === "/voice/status") {
      const st = params.CallStatus;
      if (["busy", "no-answer", "failed", "canceled"].includes(st)) {
        log(r, `Call ${st}`);
        if (r.attempts < MAX_ATTEMPTS && st !== "failed" && apptTime(r) - Date.now() > (RETRY_MINUTES + 5) * 60000) {
          r.status = "retry"; r.nextTry = Date.now() + RETRY_MINUTES * 60000; log(r, `Will try again in ${RETRY_MINUTES} minutes`);
        } else r.status = st === "failed" ? "failed" : "no-answer";
      } else if (st === "completed" && ["calling", "in-call"].includes(r.status)) { r.status = "no-response"; log(r, "Call ended without an answer"); }
      save(); callLog("  → 204 status noted"); res.writeHead(204); res.end(); return true;
    }
    callLog("  → 404 unknown voice path"); res.writeHead(404); res.end(); return true;
  }
  return false;
}

function init(opts) {
  askAI = opts.askAI;
  if (opts.onUpdate) onUpdate = opts.onUpdate;
  // Calls that failed because of a setup problem (keys, tunnel, Twilio settings) are retried
  // automatically on the next start, as long as the appointment is still more than 5 minutes away.
  for (const r of items) {
    if (r.status === "failed" && apptTime(r) - Date.now() > 5 * 60000) {
      r.status = "scheduled"; r.attempts = 0; delete r.error;
      log(r, "Server restarted - the reminder call will be retried automatically");
    }
  }
  save();
  startTunnel(opts.port);
  // Check every 30 s; the first check waits ~8 s so the public URL (cloudflared) is ready before any call.
  setInterval(tick, 30000); setTimeout(tick, 8000);
  return twilioReady()
    ? `Reminder calls ON via Twilio from ${FROM}, ${MINUTES_BEFORE} min before each appointment`
    : "Reminder calls: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER to .env to place real calls";
}

module.exports = { init, handle, isLocal, schedule };
