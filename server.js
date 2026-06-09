// ============================================================
//  AI RECEPTIONIST — TOOL SERVER
// ============================================================
//  This small server is the "hands" of your phone agent.
//  Vapi (the voice platform) handles the actual phone call.
//  Whenever the agent needs to DO something — check the diary,
//  book an appointment, leave a note, log a callback — Vapi
//  sends a request here, this server does the work, and sends
//  the result back so the agent can say it out loud.
//
//  You do not need to edit this file to get started.
//  All your settings live in the .env file.
// ============================================================

const express = require("express");
const app = express();
app.use(express.json());

// ---- Settings (loaded from your .env file / host dashboard) ----
const PORT = process.env.PORT || 3000;
const CAL_API_KEY = process.env.CAL_API_KEY; // from cal.com → Settings → API Keys
const CAL_EVENT_TYPE_ID = process.env.CAL_EVENT_TYPE_ID; // the numeric ID of your booking type
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "Europe/London";
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL; // where notes & callback requests are sent
const RESEND_API_KEY = process.env.RESEND_API_KEY; // from resend.com (free tier is fine)
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const VAPI_SECRET = process.env.VAPI_SECRET; // optional shared secret, set the same value in Vapi

// ============================================================
//  HELPERS
// ============================================================

// Send an email to the business (used for notes + callback requests)
async function emailBusiness(subject, text) {
  if (!RESEND_API_KEY || !BUSINESS_EMAIL) {
    console.log("EMAIL (not sent - missing keys):", subject, text);
    return { ok: false, reason: "Email not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [BUSINESS_EMAIL],
      subject,
      text,
    }),
  });
  return { ok: res.ok };
}

// Ask Cal.com which slots are free on a given date (YYYY-MM-DD)
async function getAvailableSlots(date) {
  const url =
    `https://api.cal.com/v2/slots?eventTypeId=${CAL_EVENT_TYPE_ID}` +
    `&start=${date}&end=${date}&timeZone=${encodeURIComponent(BUSINESS_TIMEZONE)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "cal-api-version": "2024-09-04",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Cal.com slots error:", res.status, body);
    return null;
  }
  const data = await res.json();
  // The response groups slots by date; flatten to a list of start times
  const slotsByDate = data.data || {};
  const slots = Object.values(slotsByDate).flat();
  return slots.map((s) => (typeof s === "string" ? s : s.start));
}

// Create a booking in Cal.com
async function createBooking({ name, phone, email, startISO }) {
  const res = await fetch("https://api.cal.com/v2/bookings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "Content-Type": "application/json",
      "cal-api-version": "2024-08-13",
    },
    body: JSON.stringify({
      eventTypeId: Number(CAL_EVENT_TYPE_ID),
      start: startISO, // e.g. "2026-06-15T10:00:00Z"
      attendee: {
        name: name,
        email: email || "no-email-provided@phone-booking.local",
        phoneNumber: phone,
        timeZone: BUSINESS_TIMEZONE,
      },
      metadata: { source: "ai-phone-agent" },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Cal.com booking error:", res.status, body);
    return { ok: false };
  }
  return { ok: true };
}

// Turn a date + time into an ISO timestamp in UTC for the business timezone.
// Keeps things simple: expects date "YYYY-MM-DD" and time "HH:MM" (24h).
function toISO(date, time) {
  // We let Cal.com interpret using the attendee timeZone, but bookings
  // need a UTC instant. Build it from the local wall-clock time:
  const local = new Date(`${date}T${time}:00`);
  // Adjust from server time to the business timezone using Intl:
  const inv = new Date(
    local.toLocaleString("en-US", { timeZone: BUSINESS_TIMEZONE })
  );
  const diff = local.getTime() - inv.getTime();
  return new Date(local.getTime() + diff).toISOString();
}

// Format a list of ISO slot times into something readable to say aloud
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
//  THE TOOLS — these names must match the tools you create in Vapi
// ============================================================

const tools = {
  // ---- 1. Check availability -------------------------------
  // args: { date: "YYYY-MM-DD" }
  async check_availability(args) {
    if (!args.date) return "I need a date to check, in YYYY-MM-DD format.";
    const slots = await getAvailableSlots(args.date);
    if (slots === null) return "Sorry, I couldn't reach the booking system just now.";
    if (slots.length === 0) return `There are no free slots on ${args.date}.`;
    return `Available times on ${args.date}: ${speakableSlots(slots)}. (${slots.length} slots free in total.)`;
  },

  // ---- 2. Book an appointment ------------------------------
  // args: { name, phone, email?, date: "YYYY-MM-DD", time: "HH:MM", service? }
  async book_appointment(args) {
    const { name, phone, email, date, time, service } = args;
    if (!name || !phone || !date || !time)
      return "I still need the caller's name, phone number, date and time before I can book.";
    const startISO = toISO(date, time);
    const result = await createBooking({ name, phone, email, startISO });
    if (!result.ok)
      return "That time could not be booked — it may have just been taken. Offer to check availability again.";
    // Also email the business a heads-up
    await emailBusiness(
      `New booking: ${name} — ${date} ${time}`,
      `Booked by the AI receptionist.\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || "not given"}\nService: ${service || "not specified"}\nWhen: ${date} at ${time} (${BUSINESS_TIMEZONE})`
    );
    return `Booked! ${name} is confirmed for ${date} at ${time}.`;
  },

  // ---- 3. Leave a note for the business --------------------
  // args: { caller_name, caller_phone, message }
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

  // ---- 4. Schedule a callback ------------------------------
  // args: { caller_name, caller_phone, preferred_time, topic }
  async schedule_callback(args) {
    const { caller_name, caller_phone, preferred_time, topic } = args;
    if (!caller_phone) return "I need the caller's phone number to arrange a callback.";
    const sent = await emailBusiness(
      `Callback requested: ${caller_name || "caller"} — ${preferred_time || "any time"}`,
      `The AI receptionist logged a callback request:\n\nName: ${caller_name || "unknown"}\nPhone: ${caller_phone}\nPreferred time: ${preferred_time || "any time"}\nTopic: ${topic || "not specified"}`
    );
    return sent.ok
      ? `A callback has been requested for ${preferred_time || "as soon as possible"}. The team will ring back on ${caller_phone}.`
      : "The callback was logged, but email delivery may have failed.";
  },
};

// ============================================================
//  THE WEBHOOK — Vapi sends every tool call here
// ============================================================

app.post("/vapi/webhook", async (req, res) => {
  try {
    // Optional security: reject requests without the shared secret
    if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
      return res.status(200).json({ results: [] }); // silently ignore
    }

    const message = req.body?.message;
    if (message?.type !== "tool-calls") {
      return res.status(200).json({}); // ignore other event types
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
        try {
          result = await tools[name](args);
        } catch (err) {
          console.error(`Tool ${name} failed:`, err);
          result = "Sorry, that action failed. Apologise to the caller and offer to take a message instead.";
        }
      } else {
        result = `Unknown tool: ${name}`;
      }

      // Vapi requires: results array, matching toolCallId, result as a
      // single-line STRING, and HTTP 200 even on errors.
      results.push({ toolCallId: call.id, result: String(result).replace(/\n/g, " ") });
    }

    res.status(200).json({ results });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ results: [] });
  }
});

// Simple health check so you can confirm the server is alive in a browser
app.get("/", (_req, res) => res.send("AI receptionist tool server is running ✅"));

app.listen(PORT, () => console.log(`Tool server listening on port ${PORT}`));
