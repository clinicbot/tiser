import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sonnet 4.6 for higher-quality document-grounded reasoning. Haiku 4.5 was
// cheaper but made reliability errors on this task: it mis-attributed session
// days (using a "Session N -> Day N" shortcut despite explicit instructions not
// to) and hallucinated/conflated roles (e.g. inventing a Session 8 moderator
// slot). Sonnet handles careful program tracing far better; prompt caching on
// the large system prompt keeps the cost difference small. To revert for cost:
// "claude-haiku-4-5".
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
// Low temperature for deterministic, repeatable answers. This is a factual
// lookup over a fixed program — at the API default (1.0) the SAME question can
// flip between "found" and "not found" across requests, forcing users to ask
// again. Pinning it near 0 makes identical questions return identical answers.
const TEMPERATURE = 0;
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

// Deterministically extract every speaker/chair/moderator/panelist appearance
// from the program and group them by institution. This index is appended to the
// system prompt so that enumeration queries ("which lectures from hospital X",
// "list everyone from Y", "all of Dr. Z's appearances") can be answered from a
// clean, complete, pre-extracted list instead of the model re-scanning the
// nested program — which it does inconsistently, missing items in parallel
// workshops. The index is generated from the program text on every request, so
// it never goes stale when program.txt is updated.
function buildSpeakerIndex(programText) {
  const lines = programText.split(/\r?\n/);
  let day = "", time = "", title = "", context = "";
  const recs = [];
  const dayShort = { "1": "Wed", "2": "Thu", "3": "Fri" };
  const add = (inst, name, role) => {
    inst = (inst || "").trim().replace(/\s+/g, " ");
    name = (name || "").trim();
    if (!inst || !name) return false;
    recs.push({ day, time, context, title, role, name, inst });
    return true;
  };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^DAY (\d)\b/))) { day = dayShort[m[1]] || ("Day" + m[1]); continue; }
    if (/^Session \d+/.test(l)) { context = l.replace(/\s*[—–-].*$/, "").trim(); title = ""; continue; }
    if ((m = l.match(/^>>> WORKSHOP:\s*(.+?)\s*\(/))) { context = "Workshop: " + m[1]; title = ""; continue; }
    if ((m = l.match(/^(\d{2}:\d{2}[–-]\d{2}:\d{2})\s+(.*)$/))) {
      time = m[1];
      const rest = m[2];
      if (!/^\|/.test(rest) && !/^Chairs:/.test(rest)) {
        title = rest.replace(/\s*\(Sponsored[^)]*\)/i, "").trim();
      }
      // fall through — a session time line can also carry inline "| Chairs: ..."
    }
    if ((m = l.match(/(Chairs?|Moderators?):\s*(.+)$/))) {
      const role = /^Chair/i.test(m[1]) ? "Chair" : "Moderator";
      const list = m[2];
      let found = false;
      const re = /([^;()]+?)\s*\(([^)]+)\)/g;
      let mm;
      while ((mm = re.exec(list))) { add(mm[2], mm[1], role); found = true; }
      if (!found) { const s = list.match(/^(.+?),\s*(.+)$/); if (s) add(s[2], s[1], role); }
      continue;
    }
    // panel/tumor-board item carrying its own inline time: "- 08:38–08:46 Name, Inst"
    if ((m = l.match(/^\s*-\s*\d{2}:\d{2}[–-]\d{2}:\d{2}\s+(.+?),\s*(.+)$/))) { add(m[2], m[1], "Case"); continue; }
    // panel item with its own title: "- Title — Name, Inst"
    if ((m = l.match(/^\s*-\s*(.+?)\s+—\s+(.+?),\s*(.+)$/))) { if (add(m[3], m[2], "Panel")) recs[recs.length - 1].title = m[1].trim(); continue; }
    // simple panel item: "- Name, Inst"
    if ((m = l.match(/^\s*-\s*(.+?),\s*(.+)$/))) { add(m[2], m[1], "Panel"); continue; }
    // talk speaker: an indented "Name, Inst" line under a titled time slot
    if ((m = l.match(/^\s{2,}(.+?),\s*(.+)$/))) { add(m[2], m[1], "Speaker"); continue; }
  }
  if (recs.length === 0) return "";
  const groups = {};
  for (const r of recs) { (groups[r.inst] = groups[r.inst] || []).push(r); }
  const dayOrder = { Wed: 1, Thu: 2, Fri: 3 };
  let out = "";
  for (const inst of Object.keys(groups).sort()) {
    out += `\n${inst}:\n`;
    const items = groups[inst].sort(
      (a, b) => (dayOrder[a.day] || 9) - (dayOrder[b.day] || 9) || a.time.localeCompare(b.time)
    );
    for (const r of items) {
      const t = r.title ? ` — ${r.title}` : "";
      const ctx = r.context ? ` (${r.context})` : "";
      out += `  [${r.day}] ${r.time} | ${r.role} | ${r.name}${t}${ctx}\n`;
    }
  }
  return out;
}

function systemPrompt(programText, infoText, todayStr) {
  // Defensive: a parser bug must never break answers. On any failure we fall
  // back to an empty index and the model answers from the program text alone.
  let speakerIndex = "";
  try {
    speakerIndex = buildSpeakerIndex(programText);
  } catch (e) {
    console.error("buildSpeakerIndex failed; continuing without index:", e);
    speakerIndex = "";
  }
  const indexSection = speakerIndex
    ? `

=== SPEAKER INDEX BY INSTITUTION (auto-generated from the program above — AUTHORITATIVE and COMPLETE for enumeration) ===

Every speaker, chair, moderator, panelist and case-presenter appearance in the program, grouped by institution. Each line is: [Day] Time | Role | Name — Title (Session/Workshop).
For any question that ENUMERATES by institution, speaker, or role — e.g. "which lectures/speakers are from <hospital>", "list everyone from X", "all of Dr. Y's appearances/sessions" — treat THIS index as the complete, authoritative list and build your answer from it. Do NOT re-scan the program and risk missing items (especially in the parallel Friday workshops). Role meanings: "Speaker" = gives a talk; "Chair"/"Moderator" = runs a session, not a talk; "Panel"/"Case" = a contribution inside a panel or case session. When the user asks specifically for "lectures"/"הרצאות", that means Role = Speaker (mention Panel/Case items separately only if relevant), and exclude Chair/Moderator-only roles. IMPORTANT: a person may hold MORE THAN ONE role — e.g. someone who gives a talk (Speaker) AND also chairs another session. Always include every Speaker entry, and never drop a person from a lectures list just because they ALSO appear as a Chair, Moderator or Panelist elsewhere. Filter by the ROLE on each line, not by the person.
${speakerIndex}
=== END OF SPEAKER INDEX ===`
    : "";

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
- COUNTING, LISTING & FILTERING QUESTIONS ("how many...", "which...", "list all...", filtered by topic, speaker, institution/hospital, session type, sponsor or day): Be exhaustive and systematic, not quick — a partial scan is the single biggest cause of wrong, run-to-run-inconsistent answers, so completeness is mandatory. Work through the ENTIRE program from top to bottom across all THREE days. Scan EVERY session AND every parallel workshop BY NAME — on Friday (Day 3) these run in parallel and are the most commonly missed: Pediatric Dermatology, Dermato-Oncology, Psoriasis, Nails, Contact Dermatitis, and the Practical AI Workshop. Also include every symposium, breakfast/lunch session and panel. Include every item that matches the filter: for a TOPIC, where it appears in the title OR is clearly the subject (e.g. "Psoriasis and Risk of 26 Cancers" counts as psoriasis); for an INSTITUTION/HOSPITAL, every speaker line bearing that institution's name; for a SPEAKER, every appearance. Before you answer, do a FINAL completeness pass: re-scan the whole program once more for any matching item you may have skipped, paying special attention to the parallel Friday workshops and to short panel/case items nested inside a session. Then give the full itemized list grouped by day (with a total count when asked "how many"). The same question must always return the same complete list — never stop after the obvious matches.
- PEOPLE & NAMES — IMPORTANT: speaker names in the program and general info are written in English/Latin script, but users frequently ask in Hebrew using a phonetic transliteration that is often imperfect or misspelled. When asked about a person:
  - Match the name PHONETICALLY across scripts. A Hebrew-transliterated name must be matched to its Latin-script equivalent in the text — e.g. "שושנה גרינברגר" or even the misspelled "שושנה ברינגרגר" → "Shoshana Greenberger"; "לבוול" → "Lebwohl"; "פרידמן" → "Friedman". Ignore honorifics (Prof./Dr./פרופ׳/ד״ר), name order, and minor spelling differences — match on how the name SOUNDS, not on exact letters.
  - A PARTIAL surname match counts as a match: "אביטן" → "Avitan-Hersh", "אביטל" → a hyphenated or compound surname. If the user gives one part of a compound/hyphenated surname, match it.
  - If exactly one person is a clear phonetic match, ANSWER ABOUT THEM DIRECTLY. Do NOT ask the user to confirm ("did you mean...?"), do NOT open with "I need more details", and do NOT say the person was not found — just give the answer. The fact that another person shares only a FIRST name (e.g. a different "Emily") is NOT a reason to ask for clarification; pick the one whose full name matches and answer.
  - Only ask the user to clarify if TWO OR MORE genuinely distinct people are each a plausible full-name phonetic match for what they typed.
  - Only state that a person is not in the program AFTER you have scanned the entire program and general info and found no plausible phonetic match in either script.
  - Then list every session they appear in (speaker, chair, moderator, panelist, discussant, committee member), each with its correct day (see the day-attribution rule below).
- Some questions are time-sensitive. Registration fees, for example, change after the early-registration deadline of May 10, 2026. Use today's date (stated above) to give the answer that is correct right now — quote the price currently in effect, and note that early registration has closed if today is past that deadline. Answer directly and naturally, weaving the date into the answer rather than opening with a standalone "today's date is..." line. If the user explicitly asks what today's date is, simply tell them.
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

CRITICAL — determining WHICH DAY a session, talk or workshop is on:
The program is divided into exactly three day blocks, each introduced by a header line of this form:
  "DAY 1 — WEDNESDAY, JUNE 3, 2026 — Museum of Tolerance"
  "DAY 2 — THURSDAY, JUNE 4, 2026 — Museum of Tolerance"
  "DAY 3 — FRIDAY, JUNE 5, 2026 — Waldorf Astoria Hotel"
Every session, talk, workshop, panel and item belongs to the day block it physically appears UNDER. To state the day of any item, scan UPWARD from that item to the nearest preceding "DAY N —" header, and use that day. The nearest preceding DAY header is the ONLY source of truth for the day.
- NEVER infer the day from the session number, the time of day, the topic, the sponsor, or memory. A session early in the morning is not necessarily Day 1; a high session number is not necessarily a later day. Only the nearest preceding DAY header decides.
- Before you state any day, re-verify it by locating that exact item in the text and reading up to the closest "DAY N —" header above it. A wrong day is a SERIOUS error — it makes attendees miss sessions — so this check is mandatory every time, and the same question must always yield the same day.

=== CONFERENCE PROGRAM (lectures and sessions) ===

${programText}

=== END OF CONFERENCE PROGRAM ===${indexSection}${infoSection}`;
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
      temperature: TEMPERATURE,
      system: [
        {
          type: "text",
          text: systemPrompt(
            program,
            typeof info === "string" ? info : null,
            // Full date (with weekday) in Israel time. Computing the weekday
            // server-side stops the model from guessing it — and getting it
            // wrong. UTC would also skew to the previous day in the evening.
            new Date().toLocaleDateString("en-US", {
              timeZone: "Asia/Jerusalem",
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
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
