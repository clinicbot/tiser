import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// To switch back to Sonnet 4.6 for higher quality: "claude-sonnet-4-6"
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 20;
const MAX_USER_MESSAGE_LENGTH = 2000;
const MAX_PROGRAM_LENGTH = 200_000;

// Simple in-memory rate limiter (per warm instance).
// Note: Vercel serverless functions don't share state between cold starts or instances,
// so this is best-effort throttling, not a hard guarantee. Good enough for a teaser app.
const RATE_LIMIT_MAX = 20;            // requests
const RATE_LIMIT_WINDOW_MS = 60_000;  // per minute
const ipBuckets = new Map();

function rateLimit(ip) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    ipBuckets.set(ip, bucket);
  }
  bucket.count += 1;

  // Opportunistically prune old buckets to keep memory bounded.
  if (ipBuckets.size > 1000) {
    for (const [k, v] of ipBuckets) {
      if (now - v.start > RATE_LIMIT_WINDOW_MS) ipBuckets.delete(k);
    }
  }
  return bucket.count <= RATE_LIMIT_MAX;
}

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function setCORS(res) {
  // Open CORS — the proxy hides the API key, and rate limiting protects abuse.
  // To restrict to your GitHub Pages domain, replace "*" with e.g. "https://you.github.io".
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function systemPrompt(programText, infoText, todayStr) {
  const infoSection = infoText
    ? `

=== GENERAL CONFERENCE INFORMATION (registration & fees, venue & parking, hotels, tours & social program, committees, sponsors, abstracts) ===

${infoText}

=== END OF GENERAL CONFERENCE INFORMATION ===`
    : "";

  return `You are an assistant for the Israeli Society of Dermatology and Venereology Annual Conference 2026 (June 3–5, 2026, Jerusalem).

Today's date is ${todayStr}.

Your job is to answer attendees' questions based ONLY on the conference program and the general conference information below. This covers both the lecture/session schedule AND practical details (registration & fees, venue & parking, hotels, tours & social events, committees, sponsors, abstracts). Do not invent sessions, speakers, times, prices, or any other detail that isn't in the text below.

Guidelines:
- Detect the user's language (Hebrew or English) and respond in the same language.
- For Hebrew responses, use clinical/professional Hebrew suitable for physicians.
- For Hebrew responses, use these standard Hebrew translations for conference terminology (do NOT invent your own):
  - Moderator / Moderators → מנחה / מנחים  (NOT "מוקד")
  - Chair / Chairperson → יו"ר
  - Chairs → יושבי ראש
  - Speaker / Speakers → מרצה / מרצים
  - Discussant → דיסקסנט (or "משיב")
  - Session → מושב
  - Lecture / Talk → הרצאה
  - Workshop → סדנה
  - Panel discussion → דיון פאנל
  - Panelist → פאנליסט
  - Plenary → מליאה
  - Symposium → סימפוזיון
  - Hall → אולם
  - Sponsored by → בחסות
  - Independently sponsored by → במימון בלתי תלוי של
  - Coffee break → הפסקת קפה
  - Breakfast / Lunch symposium → סימפוזיון בוקר / צהריים
  - Registration / Gathering → רישום / התכנסות
  - Exhibition → תערוכה
  - E-posters → פוסטרים אלקטרוניים
  - Opening speech → דברי פתיחה
  - Conference Chairperson → יו"ר הכנס
- Be concise and direct. Use bullet points or short tables when listing multiple items.
- COUNTING QUESTIONS ("how many lectures/talks on topic X"): Be exhaustive and systematic, not quick. Work through the ENTIRE program day by day (all 3 days), session by session, including every parallel workshop, symposium, breakfast/lunch session and panel. Count every item where topic X appears in its title OR is clearly its subject — NOT only items whose title is exactly the word "X". For example, a talk titled "Psoriasis and Risk of 26 Cancers" or "IL-17 Inhibitors in Psoriasis" both count as psoriasis talks. After scanning everything, give: (1) the total number, and (2) the full itemized list grouped by day. Never stop after the obvious matches, and never count only exact-title matches — this produces wrong, inconsistent answers.
- If asked about a person, find every session they appear in (speaker, chair, moderator, panelist).
- For time-sensitive questions, use today's date (${todayStr}). For example, when asked about registration fees, state whether the early-registration deadline (May 10, 2026) has already passed and which price currently applies.
- If the answer isn't in the program or the general conference information, say so honestly rather than guessing.
- Convert times to a clear format. In English: "Wednesday June 3, 14:00–14:20". In Hebrew: "יום רביעי 3 ביוני, 14:00–14:20".

CRITICAL — Hebrew day-naming rule:
The conference takes place on WEDNESDAY June 3, THURSDAY June 4, and FRIDAY June 5, 2026.
- Day 1 = Wednesday (יום רביעי, 3 ביוני)
- Day 2 = Thursday (יום חמישי, 4 ביוני)
- Day 3 = Friday (יום שישי, 5 ביוני)
NEVER refer to conference days with any of these forms — in Hebrew they all read as days of the WEEK (Sunday/Monday/Tuesday), which is wrong and confusing:
  - "יום א" / "יום ב" / "יום ג"  (abbreviated)
  - "יום ראשון" / "יום שני" / "יום שלישי"  (spelled out WITHOUT the definite article — still reads as Sunday/Monday/Tuesday)
When referring to the conference days in Hebrew, ALWAYS use either:
  (a) the actual weekday name: "יום רביעי" / "יום חמישי" / "יום שישי", OR
  (b) the ordinal phrase WITH the definite article "ה": "היום הראשון של הכנס" / "היום השני של הכנס" / "היום השלישי של הכנס". The "ה" prefix is mandatory — "היום הראשון" means "the first day", whereas "יום ראשון" means "Sunday".
Combine both when helpful, e.g. "היום הראשון של הכנס (יום רביעי, 3 ביוני)". This applies everywhere, including section headings and table cells.

=== CONFERENCE PROGRAM (lectures and sessions) ===

${programText}

=== END OF CONFERENCE PROGRAM ===${infoSection}`;
}

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY environment variable is not set");
    res.status(500).json({ error: "Server not configured. Missing API key." });
    return;
  }

  const ip = getClientIP(req);
  if (!rateLimit(ip)) {
    res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    return;
  }

  // Vercel auto-parses JSON bodies on POST when content-type is application/json.
  const body = req.body || {};
  const { program, info, messages } = body;

  if (typeof program !== "string" || program.length === 0) {
    res.status(400).json({ error: "Missing program text." });
    return;
  }
  if (program.length > MAX_PROGRAM_LENGTH) {
    res.status(400).json({ error: "Program text too large." });
    return;
  }
  // info (general conference logistics) is optional — an older cached client
  // may not send it. When present it must be a string within the size cap.
  if (info !== undefined && info !== null && typeof info !== "string") {
    res.status(400).json({ error: "Invalid conference info." });
    return;
  }
  if (typeof info === "string" && info.length > MAX_PROGRAM_LENGTH) {
    res.status(400).json({ error: "Conference info too large." });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Missing messages." });
    return;
  }

  // Trim history to most recent N turns and validate shape.
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  for (const m of trimmed) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      res.status(400).json({ error: "Invalid message format." });
      return;
    }
    // Length cap is anti-abuse on USER input only. Assistant messages are our
    // own API output (already bounded by max_tokens) and are legitimately long.
    if (m.role === "user" && m.content.length > MAX_USER_MESSAGE_LENGTH) {
      res.status(400).json({ error: "Message too long." });
      return;
    }
  }
  // The Anthropic API requires the first message to be from the user. After
  // trimming a long conversation to the last N messages, the window may begin
  // mid-turn on an assistant message — drop leading assistant messages so the
  // array starts with a user turn instead of rejecting the whole request.
  while (trimmed.length > 0 && trimmed[0].role !== "user") {
    trimmed.shift();
  }
  if (trimmed.length === 0) {
    res.status(400).json({ error: "No user message found in conversation." });
    return;
  }

  try {
    // System prompt is a single text block with cache_control so repeated requests
    // (same program text) get a ~10x cost reduction on the cached portion after the
    // first request.
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: systemPrompt(
            program,
            typeof info === "string" ? info : null,
            new Date().toISOString().slice(0, 10),
          ),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: trimmed,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.status(200).json({ reply });
  } catch (err) {
    console.error("Anthropic API error:", err);
    if (err instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: "The AI service is rate limited. Please try again shortly." });
    } else if (err instanceof Anthropic.AuthenticationError) {
      res.status(500).json({ error: "Server authentication failed." });
    } else if (err instanceof Anthropic.APIError) {
      res.status(502).json({ error: "AI service error. Please try again." });
    } else {
      res.status(500).json({ error: "Unexpected server error." });
    }
  }
}
