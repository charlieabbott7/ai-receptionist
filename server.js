// ============================================================
//  AI RECEPTIONIST — TOOL SERVER  (v2)
// ============================================================
//  Updated to work with Vapi's "API Request" tools, which send
//  the parameters as a plain JSON body to a URL per tool.
//  Each tool now has its OWN address:
//
//    POST /tools/check_availability
//    POST /tools/book_appointment
//    POST /tools/leave_note
//    POST /tools/schedule_callback
//
//  Every request and result is logged, so Railway's Deploy Logs
//  will always show what happened.
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

// ---- Settings (from Railway's Variables tab) ----
const PORT = process.env.PORT || 3000;
const CAL_API_KEY = process.env.CAL_API_KEY;
const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID;
const CAL_API_BASE = process.env.CAL_API_BASE || "https://api.cal.eu/v2"; // EU region account
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "Europe/London";
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

// ============================================================
//  HELPERS
// ============================================================

async function emailBusiness(subject, text) {
  if (!RESEND_API_KEY || !BUSINESS_EMAIL) {
    console.log("EMAIL SKIPPED (missing RESEND_API_KEY or BUSINESS_EMAIL):", subject);
    return { ok: false };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [BUSINESS_EMAIL], subject, text }),
    });
    const body = await res.text();
    console.log(`EMAIL ${res.ok ? "SENT" : "FAILED " + res.status}: ${subject} | ${body.slice(0, 200)}`);
    return { ok: res.ok };
  } catch (err) {
    console.error("EMAIL ERROR:", err.message);
    return { ok: false };
  }
}

async function getAvailableSlots(date) {
  const url =
    `${CAL_API_BASE}/slots?eventTypeId=${CAL_EVENT_TYPE_ID}` +
    `&start=${date}&end=${date}&timeZone=${encodeURIComponent(BUSINESS_TIMEZONE)}`;
  console.log("CAL SLOTS REQUEST:", url);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "cal-api-version": "2024-09-04",
    },
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.error("CAL SLOTS ERROR:", res.status, bodyText.slice(0, 500));
    return null;
  }
  let data;
  try { data = JSON.parse(bodyText); } catch { return null; }
  const slotsByDate = data.data || {};
  const slots = Object.values(slotsByDate).flat();
  console.log(`CAL SLOTS OK: ${slots.length} slots on ${date}`);
  return slots.map((s) => (typeof s === "string" ? s : s.start));
}

async function createBooking({ name, phone, email, startISO }) {
  console.log("CAL BOOKING REQUEST:", startISO, name, phone);
  const res = await fetch(`${CAL_API_BASE}/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "Content-Type": "application/json",
      "cal-api-version": "2024-08-13",
    },
    body: JSON.stringify({
      eventTypeId: Number(CAL_EVENT_TYPE_ID),
      start: startISO,
      attendee: {
        name: name,
        email: email || "no-email-provided@phone-booking.local",
        phoneNumber: phone,
        timeZone: BUSINESS_TIMEZONE,
      },
      metadata: { source: "ai-phone-agent" },
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.error("CAL BOOKING ERROR:", res.status, bodyText.slice(0, 500));
    return { ok: false };
  }
  console.log("CAL BOOKING OK");
  return { ok: true };
}

function toISO(date, time) {
  const local = new Date(`${date}T${time}:00`);
  const inv = new Date(local.toLocaleString("en-US", { timeZone: BUSINESS_TIMEZONE }));
  const diff = local.getTime() - inv.getTime();
  return new Date(local.getTime() + diff).toISOString();
}

function speakableSlots(slots, max = 5) {
  return slots
    .slice(0, max)
    .map((iso) =>
      new Date(iso).toLocaleTimeString("en-GB", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: BUSINESS_TIMEZONE,
      })
    )
    .join(", ");
}

// ============================================================
//  THE TOOLS
// ============================================================

const tools = {
  async check_availability(args) {
    if (!args.date) return "I need a date to check, in YYYY-MM-DD format.";
    const slots = await getAvailableSlots(args.date);
    if (slots === null) return "Sorry, I couldn't reach the booking system just now.";
    if (slots.length === 0) return `There are no free slots on ${args.date}.`;
    return `Available times on ${args.date}: ${speakableSlots(slots)}. (${slots.length} slots free in total.)`;
  },

  async book_appointment(args) {
    const { name, phone, email, date, time, service } = args;
    if (!name || !phone || !date || !time)
      return "I still need the caller's name, phone number, date and time before I can book.";
    const startISO = toISO(date, time);
    const result = await createBooking({ name, phone, email, startISO });
    if (!result.ok)
      return "That time could not be booked - it may have just been taken. Offer to check availability again.";
    await emailBusiness(
      `New booking: ${name} - ${date} ${time}`,
      `Booked by the AI receptionist.\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || "not given"}\nService: ${service || "not specified"}\nWhen: ${date} at ${time} (${BUSINESS_TIMEZONE})`
    );
    return `Booked! ${name} is confirmed for ${date} at ${time}.`;
  },

  async leave_note(args) {
    const { caller_name, caller_phone, message } = args;
    if (!message) return "I need the message content to leave a note.";
    const sent = await emailBusiness(
      `Phone note from ${caller_name || "a caller"}`,
      `The AI receptionist took this message:\n\nFrom: ${caller_name || "unknown"} (${caller_phone || "no number given"})\n\nMessage: ${message}`
    );
    return sent.ok
      ? "The note has been passed to the team."
      : "The note was logged, but email delivery may have failed.";
  },

  async schedule_callback(args) {
    const { caller_name, caller_phone, preferred_time, topic } = args;
    if (!caller_phone) return "I need the caller's phone number to arrange a callback.";
    const sent = await emailBusiness(
      `Callback requested: ${caller_name || "caller"} - ${preferred_time || "any time"}`,
      `The AI receptionist logged a callback request:\n\nName: ${caller_name || "unknown"}\nPhone: ${caller_phone}\nPreferred time: ${preferred_time || "any time"}\nTopic: ${topic || "not specified"}`
    );
    return sent.ok
      ? `A callback has been requested for ${preferred_time || "as soon as possible"}. The team will ring back on ${caller_phone}.`
      : "The callback was logged, but email delivery may have failed.";
  },
};

// ============================================================
//  ROUTES — one per tool (for Vapi "API Request" tools)
// ============================================================

for (const [name, fn] of Object.entries(tools)) {
  app.post(`/tools/${name}`, async (req, res) => {
    console.log(`TOOL CALL: ${name}`, JSON.stringify(req.body).slice(0, 300));
    try {
      const result = await fn(req.body || {});
      console.log(`TOOL RESULT: ${name} -> ${String(result).slice(0, 200)}`);
      res.status(200).json({ result: String(result) });
    } catch (err) {
      console.error(`TOOL ERROR: ${name}`, err);
      res.status(200).json({
        result: "Sorry, that action failed. Apologise to the caller and offer to take a message instead.",
      });
    }
  });
}

// ============================================================
//  LEGACY ROUTE — kept for Vapi's older "custom function" format
// ============================================================

app.post("/vapi/webhook", async (req, res) => {
  console.log("LEGACY WEBHOOK HIT:", JSON.stringify(req.body).slice(0, 300));
  try {
    const message = req.body?.message;
    if (message?.type !== "tool-calls") {
      console.log("LEGACY WEBHOOK: not a tool-calls message, ignoring");
      return res.status(200).json({});
    }
    const results = [];
    for (const call of message.toolCallList || []) {
      const name = call.function?.name || call.name;
      let args = call.function?.arguments || call.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      let result;
      if (tools[name]) {
        try { result = await tools[name](args); }
        catch (err) {
          console.error(`Tool ${name} failed:`, err);
          result = "Sorry, that action failed.";
        }
      } else {
        result = `Unknown tool: ${name}`;
      }
      results.push({ toolCallId: call.id, result: String(result).replace(/\n/g, " ") });
    }
    res.status(200).json({ results });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ results: [] });
  }
});

app.get("/", (_req, res) => res.send("AI receptionist tool server is running ✅ (v2)"));

app.listen(PORT, () => console.log(`Tool server v2 listening on port ${PORT}`));
