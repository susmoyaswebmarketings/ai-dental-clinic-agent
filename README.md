# AI Dental Clinic Agent

An AI receptionist for dental clinics, built by AS Webmarketings. Patients chat in English, Bengali or Hindi to book, reschedule or cancel appointments. The clinic owner sees everything in a dashboard, and patients who ask for it get an automated reminder phone call before their appointment.

## What's included

- **Patient chat** (`/`): answers clinic questions using approved information only. It books from the real free slots, collects the phone and WhatsApp numbers, detects emergencies, and hands over to staff.
- **Owner dashboard** (`/dashboard`, login required): appointments by dentist, staff alerts, enquiries with full conversations, reminder calls, and clinic setup.
- **Reminder calls**: Twilio calls the patient before the appointment, in their language. The patient confirms, cancels or asks for a new time by voice or keypad, and the dashboard updates.

## Run it locally

Requirements: Node.js 18 or later. No npm packages are needed.

1. Copy `.env.example` to `.env`.
2. Add a free AI key. Gemini is recommended: https://aistudio.google.com/apikey
3. Run `node server.js`, or double-click `start.bat`.
4. Open http://localhost:3000 for the patient chat.
5. Open http://localhost:3000/dashboard for the owner dashboard. The login is in `.env`; it's created on first start if you leave it empty.

### Optional: real reminder calls

1. Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` to `.env`.
2. Install cloudflared (`winget install Cloudflare.cloudflared`), which gives Twilio a public URL to reach your PC.
3. On a Twilio trial account, you can only call verified numbers.

## Files

| File | Purpose |
|---|---|
| `server.js` | Web server, AI provider calls, routes |
| `agent.js` | Receptionist logic, calendar, clinic data (`data/clinic.json`) |
| `reminders.js` | Reminder-call scheduling, Twilio webhooks, cloudflared tunnel |
| `auth.js` | Owner login (hashed password check, session cookie, lockout) |
| `public/` | Patient chat, login and dashboard pages |
| `dental-ai-receptionist.html` | The original single-page demo (published as a claude.ai artifact) |

## Privacy

`.env` (keys, passwords) and the patient data files (`data/`, `reminders.json`, `calls.log`) are excluded from git. The demo uses fictional patients. Don't put real patient data into a free-tier AI provider.
