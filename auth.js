// Owner login for the clinic dashboard.
// The owner's email and password live in .env (OWNER_EMAIL / OWNER_PASSWORD). If they are missing,
// a strong password is generated once and written to .env, and shown in the server window.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SESSION_HOURS = 12;
const MAX_FAILS = 5, LOCK_MINUTES = 10;
const sessions = new Map();   // token -> { email, expires }
const fails = new Map();      // ip -> { count, until }
let owner = null;             // { email, salt, hash }

const hashOf = (pw, salt) => crypto.scryptSync(String(pw), salt, 64);

function init(envPath) {
  let email = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  let password = process.env.OWNER_PASSWORD || "";
  let note = "";
  if (!email || !password) {
    email = email || "owner@clinic.local";
    password = password || crypto.randomBytes(9).toString("base64url");
    try {
      fs.appendFileSync(envPath, `\n# Clinic owner dashboard login (change these any time, then restart)\nOWNER_EMAIL=${email}\nOWNER_PASSWORD=${password}\n`);
      note = `Owner login created and saved in .env -> email: ${email}  password: ${password}`;
    } catch { note = `Owner login (could not save to .env) -> email: ${email}  password: ${password}`; }
  } else note = `Owner login: ${email} (password in .env)`;
  const salt = crypto.randomBytes(16);
  owner = { email, salt, hash: hashOf(password, salt) };
  return note;
}

function cookieToken(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)sid=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}
function current(req) {
  const t = cookieToken(req), s = t && sessions.get(t);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(t); return null; }
  return s;
}

// Returns { ok, error, cookie }
function login(req, email, password) {
  const ip = req.socket.remoteAddress || "local";
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return { ok: false, error: `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.` };
  const emailOk = String(email || "").trim().toLowerCase() === owner.email;
  const pwOk = crypto.timingSafeEqual(hashOf(password || "", owner.salt), owner.hash);
  if (!emailOk || !pwOk) {
    const n = (f && f.until > Date.now() ? f.count : (f ? f.count : 0)) + 1;
    fails.set(ip, n >= MAX_FAILS ? { count: 0, until: Date.now() + LOCK_MINUTES * 60000 } : { count: n, until: 0 });
    return { ok: false, error: "Wrong email or password." };
  }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { email: owner.email, expires: Date.now() + SESSION_HOURS * 3600000 });
  return { ok: true, cookie: `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` };
}
function logout(req) {
  const t = cookieToken(req); if (t) sessions.delete(t);
  return "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
}

module.exports = { init, current, login, logout };
