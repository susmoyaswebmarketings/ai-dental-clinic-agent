// The AI receptionist's brain, running on the server.
// Holds the clinic's data (appointments, enquiries, staff alerts, settings, patient chats) in data/clinic.json,
// so bookings made in the patient chat appear on the owner's dashboard.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "clinic.json");

// ---------- clinic setup ----------
const DENTISTS = {
  D1: { name: "Dr. Ananya Sen", short: "Dr. Sen", focus: "General & cosmetic dentistry, cleaning, fillings, whitening" },
  D2: { name: "Dr. Rahul Ghosh", short: "Dr. Ghosh", focus: "Orthodontics (braces/aligners), implants, root canal" }
};
const TIMES = ["10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30"];
// Optional extra slot for testing reminder calls: TEST_SLOT_TIME=18:00 in .env keeps that slot free today.
const TEST_SLOT_TIME = /^\d{2}:\d{2}$/.test(process.env.TEST_SLOT_TIME || "") ? process.env.TEST_SLOT_TIME : null;
const DEFAULT_CLINIC = "Smile Dental Clinic";
const DEFAULT_KB = `ADDRESS: 12 Lake Road, Ballygunge, Kolkata 700019 (near Lake Mall). Google Maps: search "Smile Dental Clinic Ballygunge".
PHONE (front desk): +91 33 4000 1234
HOURS: Monday–Saturday, 10:00 AM–2:00 PM and 5:00 PM–9:00 PM. Closed Sunday.
DENTISTS: Dr. Ananya Sen (BDS, MDS) – general & cosmetic dentistry. Dr. Rahul Ghosh (BDS, MDS Orthodontics) – braces, aligners, implants, root canal.
SERVICES: Check-up & consultation, scaling & cleaning, fillings, root canal treatment (RCT), crowns & bridges, braces & clear aligners, dental implants, teeth whitening, extractions, kids' dentistry.
APPROVED PRICES (may be quoted):
- Consultation: ₹300
- Scaling & cleaning: from ₹800
- Teeth whitening: from ₹6,000
All other treatments (RCT, implants, braces, crowns): cost is given only after the dentist examines the patient. Do not estimate.
PAYMENT: Cash, UPI, all major cards. EMI available for braces and implants (details at the clinic).
FIRST VISIT: Arrive 10 minutes early. Bring previous dental records or X-rays if you have them.
PARKING: Street parking on Lake Road; paid parking at Lake Mall.
CANCELLATION: Please cancel or reschedule at least 2 hours before the appointment.`;
const SERVICES = ["Check-up","Scaling & cleaning","Filling","Root canal","Braces review","Implant consult","Whitening","Extraction","Kids check-up","Crown fitting"];
const NAMES = ["Sourav Das","Priya Banerjee","Arijit Roy","Moumita Saha","Debjani Paul","Rohan Mukherjee","Sneha Chatterjee","Amit Kundu","Tanushree Bose","Imran Ahmed","Kavita Sharma","Subhajit Mondal","Rina Dey","Anirban Pal","Pooja Agarwal","Nilanjana Sarkar","Vikram Singh","Sayantani Dutta"];
const RED_FLAGS = [
  [/swell|swollen|ফোলা|ফুলে|सूज|सूजन/i, "facial swelling"],
  [/can'?t breathe|difficulty breathing|breathing|শ্বাস|सांस/i, "breathing difficulty"],
  [/swallow|গিলতে|निगल/i, "difficulty swallowing"],
  [/bleeding|won'?t stop|রক্ত|खून/i, "bleeding"],
  [/accident|fell|fall|injur|broken|knocked out|ভেঙে|দুর্ঘটনা|टूट|चोट/i, "dental trauma"],
  [/fever|জ্বর|बुखार/i, "fever"],
  [/unbearable|severe pain|extreme pain|খুব ব্যথা|প্রচণ্ড|बहुत दर्द|तेज दर्द/i, "severe pain"]
];
const CHIPS = [
  "I want a dental cleaning tomorrow evening",
  "কাল সকালে অ্যাপয়েন্টমেন্ট পাওয়া যাবে?",
  "Implant er khoroch koto?",
  "मेरे दांत में बहुत दर्द है, आज दिखा सकते हैं?",
  "Where are you located? Is there parking?",
  "Can I talk to a person?"
];

// ---------- utils ----------
const pad = n => String(n).padStart(2, "0");
const isoOf = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const dayLabel = s => parseIso(s).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const longDay = s => parseIso(s).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
const t12 = t => { let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + pad(m) + " " + ap; };
const nowClock = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const today = () => isoOf(new Date());
const timesFor = date => TEST_SLOT_TIME && date === today() ? [...new Set([...TIMES, TEST_SLOT_TIME])].sort() : TIMES;
const isTestSlot = (date, time) => TEST_SLOT_TIME && date === today() && time === TEST_SLOT_TIME;
function days() {
  const out = [], now = new Date();
  for (let i = 0; i < 7; i++) { const d = addDays(now, i); out.push({ iso: isoOf(d), closed: d.getDay() === 0, offset: i }); }
  return out;
}
function isOpenNow() {
  const d = new Date(); if (d.getDay() === 0) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 600 && m < 840) || (m >= 1020 && m < 1260);
}
function isPast(date, time) {
  const [h, mi] = time.split(":").map(Number); const d = parseIso(date); d.setHours(h, mi, 0, 0);
  return d.getTime() < Date.now() + 30 * 60000;
}

// ---------- phone numbers ----------
const toAsciiDigits = s => String(s).replace(/[০-৯]/g, c => c.charCodeAt(0) - 0x09E6).replace(/[०-९]/g, c => c.charCodeAt(0) - 0x0966);
function normPhone(v) {
  if (v == null) return null;
  const d = toAsciiDigits(v).replace(/\D/g, "");
  const n = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(n) ? "+91 " + n.slice(0, 5) + " " + n.slice(5) : null;
}
function findPhone(text) { const m = toAsciiDigits(text).match(/(\+?\d[\d\s-]{8,15}\d)/); return m ? normPhone(m[1]) : null; }
const SAME_RE = /\b(same|ek(i)?|eki|ekoi|wahi|vahi|yahi|yes|haan|ha|hya|hyan|ji)\b|একই|হ্যাঁ|ওই|वही|यही|हाँ|हां/i;
const DIFF_RE = /\b(different|another|other|alada|alag|onno|dusra|doosra)\b|আলাদা|অন্য|अलग|दूसरा/i;

// ---------- storage ----------
let D;
function fresh() {
  return { appts: [], leads: [], alerts: [], stats: { msgs: 0, after: 0, booked: 0, esc: 0, rt: [] },
    settings: { clinicName: DEFAULT_CLINIC, kb: DEFAULT_KB }, nextId: 500, seeded: [], sessions: {}, callSeen: {} };
}
function load() {
  try { D = Object.assign(fresh(), JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch { D = fresh(); }
  ensureSeeded(); save();
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(D)); fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); }
    catch (e) { console.error("[agent] could not save data:", e.message); }
  }, 200);
}
// Demo appointments booked "by the front desk", so the calendar looks like a real clinic. Each new day is filled once.
function ensureSeeded() {
  for (const day of days()) {
    if (day.closed || D.seeded.includes(day.iso)) continue;
    const r = rng(Number(day.iso.replace(/-/g, "")));
    for (const t of TIMES) for (const den of Object.keys(DENTISTS)) {
      if (r() < (day.offset === 0 ? 0.55 : day.offset === 1 ? 0.5 : 0.35) && !isTestSlot(day.iso, t)) {
        D.appts.push({ id: "A" + D.nextId++, date: day.iso, time: t, dentist: den, name: NAMES[Math.floor(r() * NAMES.length)],
          service: SERVICES[Math.floor(r() * SERVICES.length)], source: "Front desk", status: "booked", phone: null });
      }
    }
    D.seeded.push(day.iso);
  }
  // Drop old data (appointments over 30 days ago, chats idle for 7 days).
  const cutoff = isoOf(addDays(new Date(), -30));
  D.appts = D.appts.filter(a => a.date >= cutoff);
  D.seeded = D.seeded.filter(d => d >= cutoff);
  for (const [id, s] of Object.entries(D.sessions)) if (Date.now() - s.last > 7 * 86400000) delete D.sessions[id];
}

// ---------- calendar ----------
const booked = (date, time, den) => D.appts.find(a => a.status === "booked" && a.date === date && a.time === time && a.dentist === den);
function isFree(date, time, den) {
  const day = days().find(x => x.iso === date);
  if (!day || day.closed || !timesFor(date).includes(time) || !DENTISTS[den]) return false;
  return !isPast(date, time) && !booked(date, time, den);
}
function freeList(date, den) { return timesFor(date).filter(t => (!den ? Object.keys(DENTISTS).some(d => isFree(date, t, d)) : isFree(date, t, den))); }

// ---------- sessions (one per patient chat) ----------
function newPatient() { return { phone: "chat-" + crypto.randomBytes(5).toString("hex"), name: null, contact: null, whatsapp: null, leadId: null }; }
function newScript() { return { step: null, offered: [], pending: null, service: null }; }
function greetText() {
  return `Namaskar! 🙏 Welcome to *${D.settings.clinicName}*.\nI'm the clinic's AI assistant. I can book or change appointments and answer questions about timings, location and services${isOpenNow() ? "" : ", even though the clinic is closed right now"}.\nYou can write in English, বাংলা or हिन्दी. Type *human* anytime to reach our front desk.`;
}
function startSession(id) {
  ensureSeeded();
  let s = id && D.sessions[id];
  if (!s) {
    id = crypto.randomUUID();
    s = D.sessions[id] = { id, created: Date.now(), last: Date.now(), patient: newPatient(), chat: [], turns: [], script: newScript() };
    s.chat.push({ kind: "ai", text: greetText(), at: nowClock() });
    save();
  }
  return s;
}
function lead(s) {
  let l = D.leads.find(x => x.id === s.patient.leadId);
  if (!l) {
    l = { id: "L" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), session: s.id, phone: s.patient.phone, contact: null, whatsapp: null,
      name: null, service: null, lang: "—", langCode: null, status: "New", first: nowClock(), firstDate: today(), last: "" };
    D.leads.unshift(l); s.patient.leadId = l.id;
  }
  return l;
}
function redFlag(text) { const hits = RED_FLAGS.filter(([re]) => re.test(text)).map(([, l]) => l); return hits.length ? hits.join(", ") : null; }
function addAlert(level, reason, text, who) {
  D.alerts.unshift({ id: "AL" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), level, reason, text: text || "",
    contact: who.contact || null, whatsapp: who.whatsapp || null, name: who.name || null, at: nowClock(), date: today(), done: false });
  if (level === "urgent") D.stats.esc++;
}
function alertFromChat(s, level, reason, text) {
  const l = lead(s);
  addAlert(level, reason, text, { contact: s.patient.contact, whatsapp: s.patient.whatsapp, name: s.patient.name || l.name });
  if (l.status !== "Booked") l.status = "Escalated";
}

// ---------- AI prompt ----------
function slotSheet() {
  return days().map(d => {
    if (d.closed) return `${d.iso} (${dayLabel(d.iso)}): CLOSED`;
    const parts = Object.keys(DENTISTS).map(den => `${den}: ${freeList(d.iso, den).join(" ") || "none"}`);
    return `${d.iso} (${dayLabel(d.iso)}${d.offset === 0 ? ", today" : d.offset === 1 ? ", tomorrow" : ""}) → ${parts.join(" | ")}`;
  }).join("\n");
}
const myAppts = s => D.appts.filter(a => a.phone === s.patient.phone && a.status === "booked");
function buildPrompt(s) {
  const now = new Date(), P = s.patient;
  const mine = myAppts(s).map(a => `${a.id}: ${a.date} ${a.time} with ${a.dentist}, ${a.service}`).join("; ") || "none";
  const convo = s.turns.slice(-16).map(t => `${t.role}: ${t.text}`).join("\n");
  return `You are the AI WhatsApp receptionist for ${D.settings.clinicName}, a dental clinic in Kolkata, India. You handle administration and communication only.

NOW: ${now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${nowClock()} (clinic time). Clinic is currently ${isOpenNow() ? "OPEN" : "CLOSED"}.

APPROVED CLINIC INFORMATION (the only facts you may state):
${D.settings.kb}

DENTIST IDS: D1 = ${DENTISTS.D1.name} (${DENTISTS.D1.focus}). D2 = ${DENTISTS.D2.name} (${DENTISTS.D2.focus}).

FREE SLOTS, 24h time (ONLY these may be offered or booked; never invent others${TEST_SLOT_TIME ? `. The ${TEST_SLOT_TIME} slot today is a special test slot and may be booked even if it is outside normal hours` : ""}):
${slotSheet()}

THIS PATIENT: Name: ${P.name || "NOT GIVEN"}. Phone number: ${P.contact || "NOT GIVEN"}. WhatsApp number: ${P.whatsapp || "NOT GIVEN"}. Existing appointments: ${mine}.

RULES
1. Reply in the patient's language and script (English, Bengali, Hindi, or romanised Banglish/Hinglish to match them). Warm, brief, WhatsApp style, at most ~70 words. Use *bold* for key details. Show times as 12-hour (e.g. 4:00 PM) and always with the full day and date.
2. Booking: offer 2–4 suitable free slots (pick the right dentist for the service). Book ONLY when you have ALL of: (a) the patient's full name, (b) their phone number, (c) their WhatsApp number, (d) the service/reason, (e) a specific slot the patient chose from the free list. After they pick a slot, ask for whatever is still NOT GIVEN, at most two items per message (e.g. name and phone number together, then "Is your WhatsApp number the same, or a different one?"). Then set action "book" and the reply must be the confirmation: name, phone number, WhatsApp number, service, day + date, time, dentist, address, "arrive 10 minutes early", and ask if they want a reminder phone call on their number 2 hours before. When they answer that question, set "reminder_opt_in" to true (yes) or false (no).
2a. Phone numbers: Indian mobile numbers have 10 digits starting with 6, 7, 8 or 9 (a +91 or 0 prefix is fine). If a number the patient gives does not fit this, politely ask them to check and send it again. If they say the WhatsApp number is the same as the phone number, return that same number in "whatsapp". Never invent or guess a number.
3. Reschedule/cancel only appointments listed under existing appointments, using their id.
4. Never diagnose, never suggest medicines or home remedies, never interpret symptoms or X-rays, never recommend a treatment. For pain or symptoms, offer the earliest appointment and say the dentist will examine them.
5. Prices: quote only the approved prices above; for anything else say the dentist will advise the cost after examination.
6. Emergencies (facial swelling, fever with dental pain, trouble breathing or swallowing, uncontrolled bleeding, injury/knocked-out tooth, severe unbearable pain): set action "escalate" with urgency "urgent", tell them the clinic team is being alerted and will call shortly, and that if swelling is spreading or they have trouble breathing or swallowing they must go to the nearest hospital emergency now.
7. If they ask for a person, complain, or you cannot help: set action "handover".
8. If information is not in the approved information, say you will check with the clinic team (action "handover") rather than guess.

CONVERSATION SO FAR:
${convo}

Reply with ONLY one JSON object, no other text:
{"reply": string, "language": "en"|"bn"|"hi"|"mixed", "service": string|null, "patient_name": string|null, "phone": string|null (the patient's phone number, only if they gave it), "whatsapp": string|null (their WhatsApp number, only if they gave it or said it is the same as the phone number), "selected_slot": {"date":"YYYY-MM-DD","time":"HH:MM","dentist":"D1"|"D2"}|null (the free slot the patient has chosen but that is not booked yet, while you collect their details), "action": {"type":"none"} | {"type":"book","date":"YYYY-MM-DD","time":"HH:MM","dentist":"D1"|"D2","service":string} | {"type":"reschedule","appointment_id":string,"date":"YYYY-MM-DD","time":"HH:MM","dentist":"D1"|"D2"} | {"type":"cancel","appointment_id":string} | {"type":"escalate","urgency":"urgent"|"normal","reason":string} | {"type":"handover","reason":string}, "reminder_opt_in": true|false|null}`;
}

// ---------- scripted fallback (used when the AI is unavailable) ----------
function nextOpenDay(fromOffset) { return days().find(d => d.offset >= fromOffset && !d.closed && freeList(d.iso).length); }
function pickOffers(date) {
  const free = freeList(date); if (!free.length) return [];
  const am = free.filter(t => t < "15:00"), pm = free.filter(t => t >= "15:00");
  const picks = [am[0], am[Math.floor(am.length / 2)], pm[0], pm[Math.floor(pm.length / 2)]].filter(Boolean);
  return [...new Set(picks)].slice(0, 3);
}
function denFor(date, time, service) {
  const pref = /implant|brace|align|root|rct/i.test(service || "") ? ["D2", "D1"] : ["D1", "D2"];
  return pref.find(d => isFree(date, time, d));
}
function matchTime(text, offered) {
  const t = text.toLowerCase();
  const idx = t.match(/^\s*([1-3])\s*$/) || t.match(/\b(first|second|third)\b/);
  if (idx) { const i = { first: 1, second: 2, third: 3 }[idx[1]] || Number(idx[1]); return offered[i - 1]; }
  const m = t.match(/(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?/);
  if (!m) return null;
  let h = Number(m[1]); const mi = m[2] || "00";
  if (m[3] === "pm" && h < 12) h += 12; else if (!m[3] && h < 9) h += 12;
  return offered.find(o => o.date && o.time === pad(h) + ":" + mi) || offered.find(o => o.time.startsWith(pad(h)));
}
function scripted(s, text) {
  const st = s.script, P = s.patient, t = text.toLowerCase(), res = { reply: "", language: "en", service: null, patient_name: null, action: { type: "none" } };
  if (redFlag(text)) {
    res.action = { type: "escalate", urgency: "urgent", reason: "Possible dental emergency" };
    res.reply = "I'm sorry you're going through this. I'm alerting our clinic team right now and someone will call you shortly.\n*If the swelling is spreading or you have trouble breathing or swallowing, please go to the nearest hospital emergency immediately.*";
    return res;
  }
  if (/human|person|receptionist|staff|call me|talk to/.test(t)) { res.action = { type: "handover", reason: "Patient asked for a person" }; res.reply = "Of course. I've passed your chat to our front desk. They'll message or call you shortly."; return res; }
  if (/cancel/.test(t)) {
    const a = myAppts(s)[0];
    if (a) { res.action = { type: "cancel", appointment_id: a.id }; res.reply = `Done. Your appointment on *${longDay(a.date)}, ${t12(a.time)}* is cancelled. Would you like to book another time?`; }
    else res.reply = "I couldn't find an upcoming appointment for this chat. Would you like to book one?";
    return res;
  }
  if (/price|cost|fee|charge|khoroch|koto|kitna|দাম|খরচ/.test(t)) { res.reply = "Our approved prices: *Consultation ₹300*, *Scaling & cleaning from ₹800*, *Whitening from ₹6,000*. For implants, RCT, braces and crowns, the dentist will advise the cost after examining you. Shall I book a consultation?"; res.service = /implant/.test(t) ? "Implant consult" : null; return res; }
  if (/where|address|located|location|parking|hour|timing|open|close/.test(t) && st.step !== "pick") { res.reply = "📍 *12 Lake Road, Ballygunge, Kolkata 700019* (near Lake Mall).\n🕙 *Mon–Sat:* 10 AM–2 PM and 5 PM–9 PM. Closed Sunday.\n🚗 Street parking on Lake Road, or paid parking at Lake Mall."; return res; }
  if (st.step === "reminder") {
    st.step = null;
    if (/\b(yes|yeah|ok|okay|sure|please|haan|ha|ji|hya)\b|হ্যাঁ|হ্যা|हाँ|हां|জি|जी/i.test(t)) { res.reminder_opt_in = true; res.reply = `Done ✅ We'll *call you on ${P.contact}* 2 hours before your appointment as a reminder.`; return res; }
    if (/\b(no|nope|nahi|na)\b|না|नहीं/i.test(t)) { res.reminder_opt_in = false; res.reply = "No problem. See you at the clinic! 😊"; return res; }
  }
  if (st.pending && st.step !== "pick") st.step = !P.name ? "name" : !P.contact ? "contact" : !P.whatsapp ? "whatsapp" : null;
  if (st.pending && !st.step) return bookScripted(s, res);
  if (st.step === "pick") {
    const choice = matchTime(text, st.offered);
    if (choice) {
      st.pending = choice;
      if (!P.name) { st.step = "name"; res.reply = `Great, *${longDay(choice.date)}, ${t12(choice.time)}*. May I have the patient's full name?`; return res; }
      return askNumbersOrBook(s, res);
    }
  }
  if (st.step === "name") {
    const n = findPhone(text), name = text.replace(/[+\d০-৯०-९][\d০-৯०-९\s-]{7,}/g, "").replace(/[,;:|]+/g, " ").replace(/\b(my name is|name|amar naam|mera naam)\b/gi, "").trim();
    if (!name || name.length < 2) { res.reply = "May I have the patient's full name?"; return res; }
    P.name = res.patient_name = name.slice(0, 40);
    if (n && !P.contact) P.contact = res.phone = n;
    return askNumbersOrBook(s, res);
  }
  if (st.step === "contact") {
    const n = findPhone(text);
    if (!n) { res.reply = "That doesn't look like a valid mobile number. Please send a 10-digit number, e.g. *98765 43210*."; return res; }
    P.contact = res.phone = n; return askNumbersOrBook(s, res);
  }
  if (st.step === "whatsapp") {
    const n = findPhone(text);
    if (n) P.whatsapp = res.whatsapp = n;
    else if (DIFF_RE.test(text)) { res.reply = "No problem. Please send your *WhatsApp number*."; return res; }
    else if (SAME_RE.test(text)) P.whatsapp = res.whatsapp = P.contact;
    else { res.reply = "Please send your WhatsApp number, or reply *same* if it's the same as your phone number."; return res; }
    return askNumbersOrBook(s, res);
  }
  if (/book|appoint|clean|scal|check|slot|available|tomorrow|today|kal|aaj|কাল|আজ|आज|অ্যাপয়েন্টমেন্ট|pain|dard|ব্যথা|दर्द/.test(t)) {
    const service = /clean|scal/.test(t) ? "Scaling & cleaning" : /implant/.test(t) ? "Implant consult" : /brace|align/.test(t) ? "Braces consult" : /pain|dard|ব্যথা|दर्द/.test(t) ? "Tooth pain consult" : "Check-up";
    st.service = service; res.service = service;
    const day = nextOpenDay(/today|aaj|आज|আজ/.test(t) ? 0 : 1) || nextOpenDay(0);
    if (!day) { res.reply = "We're fully booked this week. I've asked the front desk to call you with the next opening."; res.action = { type: "handover", reason: "No free slots" }; return res; }
    let times = pickOffers(day.iso);
    if (/evening|sondhe|শাম|shaam|সন্ধ্যা/.test(t)) times = freeList(day.iso).filter(x => x >= "17:00").slice(0, 3);
    if (/morning|sokal|সকাল|सुबह/.test(t)) times = freeList(day.iso).filter(x => x < "15:00").slice(0, 3);
    if (!times.length) times = pickOffers(day.iso);
    st.offered = times.map(x => ({ date: day.iso, time: x })); st.step = "pick";
    res.reply = `I can help with that (${service}). Free slots on *${longDay(day.iso)}*:\n${times.map((x, i) => `${i + 1}. ${t12(x)}`).join("\n")}\nWhich time suits you?`;
    return res;
  }
  res.reply = "I can help you book, reschedule or cancel an appointment, and answer questions about our timings, location, services and approved prices. What would you like to do?";
  return res;
}
function askNumbersOrBook(s, res) {
  const st = s.script, P = s.patient;
  if (!P.contact) { st.step = "contact"; res.reply = `Thank you${P.name ? ", *" + P.name + "*" : ""}. What is your *phone number*?`; return res; }
  if (!P.whatsapp) { st.step = "whatsapp"; res.reply = `Got it: *${P.contact}*. Is your *WhatsApp number* the same? Reply *same*, or send your WhatsApp number.`; return res; }
  return bookScripted(s, res);
}
function bookScripted(s, res) {
  const st = s.script, P = s.patient, c = st.pending, den = c.dentist && isFree(c.date, c.time, c.dentist) ? c.dentist : denFor(c.date, c.time, st.service);
  st.step = null;
  if (!den) { res.reply = "Sorry, that slot was just taken. Could you pick another time?"; st.step = "pick"; return res; }
  res.action = { type: "book", date: c.date, time: c.time, dentist: den, service: st.service || "Check-up" };
  res.reply = `✅ *Booked!*\n*${P.name}* – ${st.service || "Check-up"}\n📞 ${P.contact} · WhatsApp ${P.whatsapp}\n📅 ${longDay(c.date)}, *${t12(c.time)}*\n👩‍⚕️ ${DENTISTS[den].name}\n📍 12 Lake Road, Ballygunge\nPlease arrive 10 minutes early. Would you like a *reminder call* on ${P.contact} 2 hours before? (Yes / No)`;
  return res;
}

// ---------- apply the AI's (or script's) answer, with validation ----------
let reminders = null; // injected: { schedule(data) }
function apply(s, res, flag) {
  const l = lead(s), P = s.patient, lastText = (s.turns[s.turns.length - 1] || {}).text || "", events = [];
  let reply = String(res && res.reply || "").trim() || "Sorry, I didn't catch that. Could you say it another way?";
  if (res.patient_name && typeof res.patient_name === "string" && res.patient_name.length < 60) P.name = P.name || res.patient_name.trim();
  if (P.name) l.name = P.name;
  const pn = normPhone(res.phone) || (!P.contact ? findPhone(lastText) : null);
  if (pn) P.contact = pn;
  const wn = normPhone(res.whatsapp);
  if (wn) P.whatsapp = wn;
  else if (res.whatsapp && P.contact && !DIFF_RE.test(lastText) && SAME_RE.test(String(res.whatsapp) + " " + lastText)) P.whatsapp = P.contact;
  l.contact = P.contact; l.whatsapp = P.whatsapp;
  const ss = res.selected_slot;
  if (ss && ss.date && ss.time && isFree(String(ss.date), String(ss.time).slice(0, 5), String(ss.dentist || ""))) {
    s.script.pending = { date: String(ss.date), time: String(ss.time).slice(0, 5), dentist: String(ss.dentist) };
    s.script.service = res.service || l.service || s.script.service;
  }
  if (res.service) l.service = String(res.service).slice(0, 40);
  if (res.language) { l.lang = { en: "English", bn: "Bengali", hi: "Hindi", mixed: "Mixed" }[res.language] || l.lang; l.langCode = res.language; }

  const a = res.action || { type: "none" };
  const findMine = id => D.appts.find(x => x.id === String(id) && x.phone === P.phone && x.status === "booked");
  if (a.type === "book") {
    const date = String(a.date || ""), time = String(a.time || "").slice(0, 5), den = String(a.dentist || "");
    if (!P.name) reply = "Before I confirm, may I have the patient's full name?";
    else if (!P.contact) reply = "Before I confirm, may I have your *phone number*? (10-digit mobile number)";
    else if (!P.whatsapp) reply = `Before I confirm: is your *WhatsApp number* the same as ${P.contact}? Reply *same*, or send your WhatsApp number.`;
    else if (isFree(date, time, den)) {
      const appt = { id: "A" + D.nextId++, date, time, dentist: den, name: P.name, service: String(a.service || l.service || "Check-up").slice(0, 40),
        source: "AI", status: "booked", phone: P.phone, contact: P.contact, whatsapp: P.whatsapp, bookedAt: Date.now() };
      D.appts.push(appt); D.stats.booked++; l.status = "Booked"; l.service = appt.service;
      s.script.pending = null; s.script.step = "reminder";
      events.push(`Saved to clinic calendar · ${DENTISTS[den].short} · ${dayLabel(date)}, ${t12(time)}`);
    } else {
      const alt = freeList(date).slice(0, 3);
      reply = `Sorry, that slot is no longer available. ${alt.length ? `Free times on *${dayLabel(date)}*: ${alt.map(t12).join(", ")}. Which one would you like?` : "Could you choose another day?"}`;
      events.push("Calendar check blocked a booking for a slot that was not free");
    }
  } else if (a.type === "reschedule") {
    const ap = findMine(a.appointment_id), date = String(a.date || ""), time = String(a.time || "").slice(0, 5), den = String(a.dentist || "");
    if (ap && isFree(date, time, den)) { ap.date = date; ap.time = time; ap.dentist = den; ap.source = "AI"; delete ap.callStatus; events.push(`Moved → ${DENTISTS[den].short} · ${dayLabel(date)}, ${t12(time)}`); }
    else reply = "Sorry, I couldn't move that appointment to that time. Could you choose another free slot?";
  } else if (a.type === "cancel") {
    const ap = findMine(a.appointment_id);
    if (ap) { ap.status = "cancelled"; l.status = "Cancelled"; events.push(`Cancelled · ${dayLabel(ap.date)}, ${t12(ap.time)}`); }
  } else if (a.type === "escalate") {
    alertFromChat(s, a.urgency === "urgent" ? "urgent" : "normal", a.reason || "Needs staff attention", lastText);
    events.push(a.urgency === "urgent" ? "Urgent alert sent to staff" : "Staff notified");
  } else if (a.type === "handover") {
    alertFromChat(s, "normal", a.reason || "Patient asked for a person", lastText);
    events.push("Chat handed over to front desk");
  }
  if (flag && a.type !== "escalate") {
    alertFromChat(s, "urgent", "Safety check flagged: " + flag, lastText);
    events.push("Safety check flagged this message");
    if (!/emergency|hospital|হাসপাতাল|अस्पताल/i.test(reply)) reply += "\n\n*If you have spreading swelling, trouble breathing or swallowing, or bleeding that won't stop, please go to the nearest hospital emergency now.* Our team has been alerted.";
  }
  if (res.reminder_opt_in === true || res.reminder_opt_in === false) { if (s.script.step === "reminder") s.script.step = null; }
  if (res.reminder_opt_in === true) {
    const ap = myAppts(s).slice(-1)[0];
    if (ap && ap.contact && reminders) {
      try {
        const r = reminders.schedule({ apptId: ap.id, name: ap.name, contact: ap.contact, date: ap.date, time: ap.time, dentist: DENTISTS[ap.dentist].name,
          service: ap.service, language: l.langCode || "en", clinic: D.settings.clinicName });
        ap.reminderId = r.id; ap.callStatus = r.status;
        events.push(`Reminder call scheduled for ${new Date(r.callAt).toLocaleString("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
      } catch (e) { events.push("Couldn't schedule the reminder call: " + e.message); }
    }
  }
  l.last = nowClock();
  return { reply, events };
}

// ---------- one patient message ----------
let askAI = null, aiReady = () => false;
async function send(sessionId, text) {
  const s = D.sessions[sessionId];
  if (!s) throw Object.assign(new Error("Chat not found. Please start a new chat."), { status: 404 });
  text = String(text || "").trim().slice(0, 1000);
  if (!text) throw Object.assign(new Error("Empty message"), { status: 400 });
  if (s.busy) throw Object.assign(new Error("Please wait for the reply"), { status: 429 });
  s.busy = true;
  try {
    ensureSeeded();
    lead(s);
    s.chat.push({ kind: "patient", text, at: nowClock() }); s.turns.push({ role: "Patient", text });
    D.stats.msgs++; if (!isOpenNow()) D.stats.after++;
    const flag = redFlag(text), t0 = Date.now();
    let res, by = "ai";
    if (aiReady()) {
      try { res = await askAI(buildPrompt(s)); if (!res || typeof res !== "object") throw new Error("invalid reply"); }
      catch (e) { res = scripted(s, text); by = "script"; }
    } else { res = scripted(s, text); by = "script"; }
    D.stats.rt.push(Date.now() - t0); if (D.stats.rt.length > 200) D.stats.rt.shift();
    const { reply, events } = apply(s, res, flag);
    const msg = { kind: "ai", text: reply, at: nowClock(), by };
    s.chat.push(msg); s.turns.push({ role: "Assistant", text: reply });
    if (events.length) s.chat.push({ kind: "event", text: events.join(" · "), at: nowClock(), staffOnly: true });
    s.last = Date.now();
    save();
    return msg;
  } finally { s.busy = false; }
}

// ---------- reminder-call outcomes (from reminders.js) ----------
function onCallUpdate(r) {
  const ap = D.appts.find(a => a.id === r.apptId && a.date === r.date && a.time === r.time && a.contact === r.contact);
  if (!ap) return;
  ap.callStatus = r.status;
  const key = r.id + ":" + r.status;
  if (D.callSeen[key]) { save(); return; }
  D.callSeen[key] = 1;
  if (r.status === "cancelled" && ap.status === "booked") { ap.status = "cancelled"; addAlert("normal", "Cancelled on the reminder call. Send a WhatsApp to rebook", r.answer, ap); }
  if (r.status === "reschedule") addAlert("normal", "Wants a new time (said on the reminder call). Contact on WhatsApp", r.answer, ap);
  if (r.status === "no-answer" || r.status === "failed") addAlert("normal", `Reminder call ${r.status === "failed" ? "failed" : "not answered"}. Please message the patient`, r.error || "", ap);
  save();
}

// ---------- owner dashboard ----------
function adminState() {
  ensureSeeded();
  const ds = days(), isos = new Set(ds.map(d => d.iso));
  const rt = D.stats.rt.length ? D.stats.rt.reduce((a, b) => a + b, 0) / D.stats.rt.length / 1000 : null;
  return {
    clinicName: D.settings.clinicName, kb: D.settings.kb, defaultKb: DEFAULT_KB, defaultClinic: DEFAULT_CLINIC,
    dentists: DENTISTS, isOpen: isOpenNow(), aiReady: aiReady(), testSlot: TEST_SLOT_TIME,
    days: ds.map(d => ({ ...d, times: timesFor(d.iso) })),
    appts: D.appts.filter(a => isos.has(a.date)),
    alerts: D.alerts.slice(0, 200), leads: D.leads.slice(0, 300),
    stats: { msgs: D.stats.msgs, after: D.stats.after, booked: D.stats.booked, esc: D.stats.esc, avgReply: rt }
  };
}
function conversation(leadId) {
  const l = D.leads.find(x => x.id === leadId); const s = l && D.sessions[l.session];
  return s ? s.chat : [];
}
function alertDone(id) { const a = D.alerts.find(x => x.id === id); if (a) { a.done = true; save(); } return Boolean(a); }
function saveSettings({ clinicName, kb }) {
  D.settings.clinicName = String(clinicName || "").trim().slice(0, 80) || DEFAULT_CLINIC;
  D.settings.kb = String(kb || "").trim().slice(0, 8000) || DEFAULT_KB;
  save();
}
function resetDemo() { D = fresh(); ensureSeeded(); save(); }
function publicInfo() { return { clinicName: D.settings.clinicName, isOpen: isOpenNow(), chips: CHIPS }; }
function sessionView(s) { return { sessionId: s.id, messages: s.chat.filter(m => !m.staffOnly).map(({ kind, text, at }) => ({ kind, text, at })) }; }

function init(opts) {
  askAI = opts.askAI; aiReady = opts.aiReady; reminders = opts.reminders;
  load();
}

module.exports = { init, startSession, send, sessionView, publicInfo, adminState, conversation, alertDone, saveSettings, resetDemo, onCallUpdate };
