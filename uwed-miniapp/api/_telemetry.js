const https = require("https");

const GIST_ID = process.env.TELEMETRY_GIST_ID || "0ac71f17bd0397a3e9062bba32bbb825";
const GH_TOKEN = process.env.TELEMETRY_GH_TOKEN || "";

let memCache = null;
let lastFetchTs = 0;
let lastSaveTs = 0;
let pendingSavePromise = null;

function ghRequest(method, path, bodyObj = null) {
  return new Promise((resolve) => {
    if (!GH_TOKEN || !GIST_ID) {
      return resolve(null);
    }
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "UWED-Helpdesk-Engine/4.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        hostname: "api.github.com",
        port: 443,
        path,
        method,
        headers,
        timeout: 7000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf-8").trim();
            resolve(raw ? JSON.parse(raw) : null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function getDefaultCampusEvents() {
  return [
    {
      id: "ev_uwed_1",
      category: "diplomacy",
      title_uz: "Diplomatik protokol va xalqaro muzokaralar mahorati",
      title_ru: "Мастер-класс: Дипломатический протокол и международные переговоры",
      title_en: "Masterclass: Diplomatic Protocol & International Negotiations",
      date: "2026-11-05",
      time: "14:00",
      location: "B-201 (Majlislar zali)",
      channel_name: "@uwed_official",
      tg_link: "https://t.me/uwed_official",
      desc_uz: "TIV faxriy elçilari iştirokida oçiq ma’ruza va savol-javob sessiyasi.",
      desc_ru: "Открытая лекция и Q&A сессия с участием действующих дипломатов МИД.",
      desc_en: "Open guest lecture and Q&A session with senior diplomats.",
      is_scheduled_event: true,
      approved: true,
    },
    {
      id: "ev_uwed_2",
      category: "clubs",
      title_uz: "JIDU Model UN (UWED MUN) — Delegatlar saralaş bosqiçi",
      title_ru: "UWED Model UN — Отборочный тур делегатов и дебаты",
      title_en: "UWED Model UN — Delegate Selection & Debate Session",
      date: "2026-11-06",
      time: "15:30",
      location: "A-305",
      channel_name: "@uwed_official",
      tg_link: "https://t.me/uwed_official",
      desc_uz: "BMT Modeli klubi yangi mavsumi uçun suhbat va rezolyutsiya muhokamasi.",
      desc_ru: "Собеседование и тренировочные дебаты для нового сезона Модели ООН УМЭД.",
      desc_en: "Mock debate and delegate onboarding for the upcoming UWED MUN conference.",
      is_scheduled_event: true,
      approved: true,
    },
    {
      id: "ev_uwed_3",
      category: "career",
      title_uz: "Xalqaro taşkilotlarda amaliyot va grant dasturlari taqdimoti",
      title_ru: "Презентация стажировок в международных организациях и зарубежных грантов",
      title_en: "International Internships & Exchange Scholarships Briefing",
      date: "2026-11-07",
      time: "12:30",
      location: "D-102 (Актовый зал)",
      channel_name: "@uwed_official",
      tg_link: "https://t.me/uwed_official",
      desc_uz: "Erasmus+, UN Volunteers va yozgi diplomatik amaliyot dasturlariga hujjatlar topşiriş tartibi.",
      desc_ru: "Разбор подачи заявок на программы обмена, стажировки ООН и летние школы.",
      desc_en: "Step-by-step application guide for exchange programs and UN internships.",
      is_scheduled_event: true,
      approved: true,
    },
    {
      id: "ev_uwed_4",
      category: "campus",
      title_uz: "Zakovat Intellektual Klubi — Fakultetlararo kubok",
      title_ru: "Интеллектуальный клуб «Заковат» — Межфакультетский кубок УМЭД",
      title_en: "Zakovat Quiz Cup — Inter-Faculty Tournament",
      date: "2026-11-08",
      time: "14:00",
      location: "B blok Coworking",
      channel_name: "@uwed_official",
      tg_link: "https://t.me/uwed_official",
      desc_uz: "6 kişilik jamoalar õrtasida navbatdagi tur õyinlari.",
      desc_ru: "Очередной тур интеллектуальной игры среди команд факультетов МО, МЭ и МП.",
      desc_en: "Weekly team trivia and logic championship across all UWED faculties.",
      is_scheduled_event: true,
      approved: true,
    },
  ];
}

function createEmptyDb() {
  return {
    maintenance_mode: true,
    users: {},
    counters: {
      rooms: {},
      searches: {},
      blocks: {},
      actions: {},
      teachers: {},
      students: {},
    },
    feedbacks: [],
    events: [],
    room_reports: {},
    subscriptions: {},
    moodle_users: {},
    campus_events: getDefaultCampusEvents(),
    tracked_channels: ["uwed_official"],
    channel_posts: [],
    last_channel_sync_ms: 0,
  };
}

function cleanChannelHandle(raw) {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\/(s\/)?/i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function detectEventCategory(text) {
  const s = String(text || "").toLowerCase();
  if (/grant|stipendi|intern|amaliyot|стажиров|грант|стипенд|career|vacancy|tanlov|конкурс/i.test(s)) {
    return "career";
  }
  if (/mun\b|zakovat|заковат|club|klub|клуб|debate|дебат|sport|turnir|турнир|cup|кубок|tedx/i.test(s)) {
    return "clubs";
  }
  if (/elchi|ambassador|посол|diplomat|дипломат|protocol|протокол|mid\b|tiv\b|мид|un\b|bmt\b|оон/i.test(s)) {
    return "diplomacy";
  }
  return "campus";
}

/**
 * Smart NLP Extractor for Telegram Posts:
 * Extracts explicit event dates (DD.MM.YYYY, DD-month, etc.), event times (14:00),
 * and UWED room/hall locations (B-201, A-305, Majlislar zali, etc.) from post text.
 */
function extractEventDetailsFromPost(cleanText, postDateStr, postTimeStr, channelHandle) {
  const s = String(cleanText || "");
  let detectedDate = postDateStr;
  let detectedTime = postTimeStr;
  let detectedLocation = `@${channelHandle}`;
  let isScheduledEvent = false;

  const yearNow = Number(postDateStr.slice(0, 4)) || 2026;

  // 1. Check DD.MM.YYYY or DD/MM/YYYY or DD.MM
  const dmyMatch = s.match(/\b(0?[1-9]|[12]\d|3[01])[./](0?[1-9]|1[0-2])(?:[./](202\d))?\b/);
  if (dmyMatch) {
    const dd = String(dmyMatch[1]).padStart(2, "0");
    const mm = String(dmyMatch[2]).padStart(2, "0");
    const yyyy = dmyMatch[3] || String(yearNow);
    detectedDate = `${yyyy}-${mm}-${dd}`;
    isScheduledEvent = true;
  } else {
    // 2. Check Month names in UZ / RU / EN (e.g., "12-noyabr", "15 ноября", "November 15")
    const monthsMap = {
      yanvar: "01", январ: "01", january: "01", jan: "01",
      fevral: "02", феврал: "02", february: "02", feb: "02",
      mart: "03", март: "03", march: "03", mar: "03",
      aprel: "04", апрел: "04", april: "04", apr: "04",
      may: "05", май: "05", мая: "05",
      iyun: "06", июн: "06", june: "06", jun: "06",
      iyul: "07", июл: "07", july: "07", jul: "07",
      avgust: "08", август: "08", august: "08", aug: "08",
      sentabr: "09", сентябр: "09", september: "09", sep: "09",
      oktabr: "10", октябр: "10", october: "10", oct: "10",
      noyabr: "11", ноябр: "11", november: "11", nov: "11",
      dekabr: "12", декабр: "12", december: "12", dec: "12",
    };
    const monthRegex = new RegExp(
      `\\b(\\d{1,2})\\s*[-–]?\\s*(${Object.keys(monthsMap).join("|")})[a-zа-я]*\\b`,
      "i"
    );
    const m1 = s.match(monthRegex);
    if (m1) {
      const dd = String(m1[1]).padStart(2, "0");
      const mm = monthsMap[m1[2].toLowerCase()] || "11";
      detectedDate = `${yearNow}-${mm}-${dd}`;
      isScheduledEvent = true;
    }
  }

  // 3. Check explicit Time in text (e.g., "soat 14:00", "в 15:30", "⏰ 11:00")
  const timeMatch =
    s.match(/(?:soat|соат|в|at|⏰|🕒|vaqti|время)\s*[:\-]?\s*([01]?\d|2[0-3])[:.]([0-5]\d)/i) ||
    s.match(/\b(0[89]|1\d|2[01]):([0-5]\d)\b/);
  if (timeMatch) {
    detectedTime = `${String(timeMatch[1]).padStart(2, "0")}:${timeMatch[2]}`;
    isScheduledEvent = true;
  }

  // 4. Check explicit UWED Room or Hall (e.g. "B-201", "A-305", "D-102", "Majlislar zali", "Coworking")
  const roomMatch = s.match(/\b([ABD])\s*[-–]\s*(\d{3}[a-zA-Z]?)\b/);
  if (roomMatch) {
    detectedLocation = `${roomMatch[1].toUpperCase()}-${roomMatch[2]}`;
    isScheduledEvent = true;
  } else if (/majlislar zali|актовый зал|конференц|conference hall/i.test(s)) {
    detectedLocation = "UWED Majlislar zali";
    isScheduledEvent = true;
  } else if (/coworking|коворкинг/i.test(s)) {
    detectedLocation = "B blok Coworking";
    isScheduledEvent = true;
  } else if (/kutubxona|библиотек|library|arm\b/i.test(s)) {
    detectedLocation = "UWED Library (ARM)";
  }

  return {
    date: detectedDate,
    time: detectedTime,
    location: detectedLocation,
    is_scheduled_event: isScheduledEvent,
  };
}

function fetchTelegramChannelPosts(handle, limit = 6) {
  const clean = cleanChannelHandle(handle);
  if (!clean) return Promise.resolve([]);
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "t.me",
        port: 443,
        path: `/s/${clean}`,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
        timeout: 6500,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const html = Buffer.concat(chunks).toString("utf-8");
            const blocks = html.split("tgme_widget_message_wrap");
            const items = [];
            for (let i = 1; i < blocks.length; i++) {
              const blk = blocks[i];
              const postMatch = blk.match(/data-post="([^"]+)"/);
              const textMatch = blk.match(
                /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
              );
              const timeMatch = blk.match(/datetime="([^"]+)"/);
              if (!postMatch || !textMatch) continue;
              const postRef = postMatch[1]; // e.g. uwed_official/10383
              const postIdNum = postRef.split("/")[1] || "";
              const cleanText = decodeHtmlEntities(textMatch[1]);
              if (!cleanText || cleanText.length < 18) continue;
              const lines = cleanText
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);
              const firstLine = (lines[0] || cleanText).slice(0, 115);
              const bodyDesc = lines.slice(1).join(" ").slice(0, 280) || cleanText.slice(0, 240);
              const isoRaw = timeMatch ? timeMatch[1] : new Date().toISOString();
              const dtObj = new Date(isoRaw);
              const tashkentMs = isNaN(dtObj.getTime())
                ? Date.now() + 5 * 3600 * 1000
                : dtObj.getTime() + 5 * 3600 * 1000;
              const tashkentIso = new Date(tashkentMs).toISOString();
              const postDateStr = tashkentIso.slice(0, 10);
              const postTimeStr = tashkentIso.slice(11, 16);

              const parsedMeta = extractEventDetailsFromPost(
                cleanText,
                postDateStr,
                postTimeStr,
                clean
              );

              items.push({
                id: `tg_${postRef.replace("/", "_")}`,
                post_id: postIdNum,
                category: detectEventCategory(cleanText),
                title_uz: firstLine,
                title_ru: firstLine,
                title_en: firstLine,
                date: parsedMeta.date,
                time: parsedMeta.time,
                post_date: postDateStr,
                location: parsedMeta.location,
                channel_name: `@${clean}`,
                channel_handle: clean,
                tg_link: `https://t.me/${postRef}`,
                desc_uz: bodyDesc,
                desc_ru: bodyDesc,
                desc_en: bodyDesc,
                from_channel: true,
                is_scheduled_event: parsedMeta.is_scheduled_event,
                approved: true,
                sort_ts: isNaN(dtObj.getTime()) ? Date.now() : dtObj.getTime(),
              });
            }
            items.sort((a, b) => (b.sort_ts || 0) - (a.sort_ts || 0));
            resolve(items.slice(0, limit));
          } catch (_) {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

async function syncTrackedChannels(db, forceSave = false) {
  const channels =
    Array.isArray(db.tracked_channels) && db.tracked_channels.length
      ? db.tracked_channels
      : ["uwed_official"];
  const allPosts = [];
  await Promise.all(
    channels.slice(0, 10).map(async (ch) => {
      const posts = await fetchTelegramChannelPosts(ch, 6);
      allPosts.push(...posts);
    })
  );
  allPosts.sort((a, b) => (b.sort_ts || 0) - (a.sort_ts || 0));
  if (allPosts.length > 0) {
    db.channel_posts = allPosts.slice(0, 36);
  }
  db.last_channel_sync_ms = Date.now();
  if (forceSave) {
    await saveDb(db, true);
  }
  return db;
}

async function adminManageChannels({ action, channel }) {
  const db = await loadDb(true);
  if (!Array.isArray(db.tracked_channels)) {
    db.tracked_channels = ["uwed_official"];
  }
  const clean = cleanChannelHandle(channel);
  if (action === "add" && clean) {
    if (!db.tracked_channels.includes(clean)) {
      db.tracked_channels.push(clean);
    }
    await syncTrackedChannels(db, true);
  } else if (action === "remove" && clean) {
    db.tracked_channels = db.tracked_channels.filter((c) => c !== clean);
    db.channel_posts = (db.channel_posts || []).filter(
      (p) => cleanChannelHandle(p.channel_name) !== clean
    );
    await saveDb(db, true);
  } else if (action === "sync") {
    await syncTrackedChannels(db, true);
  }
  return db;
}

function cleanExpiredRoomReports(reportsObj) {
  const nowMs = Date.now();
  const out = {};
  if (!reportsObj || typeof reportsObj !== "object") return out;
  for (const [rm, info] of Object.entries(reportsObj)) {
    if (info && info.expires_at && info.expires_at > nowMs) {
      out[rm] = info;
    }
  }
  return out;
}

async function loadDb(force = false) {
  if (!force && memCache && Date.now() - lastFetchTs < 8000) {
    memCache.room_reports = cleanExpiredRoomReports(memCache.room_reports);
    return memCache;
  }
  const gist = await ghRequest("GET", `/gists/${GIST_ID}`);
  if (gist && gist.files && gist.files["telemetry_db.json"]) {
    try {
      const parsed = JSON.parse(gist.files["telemetry_db.json"].content || "{}");
      memCache = {
        maintenance_mode:
          typeof parsed.maintenance_mode === "boolean" ? parsed.maintenance_mode : true,
        users: parsed.users || {},
        counters: {
          rooms: (parsed.counters && parsed.counters.rooms) || {},
          searches: (parsed.counters && parsed.counters.searches) || {},
          blocks: (parsed.counters && parsed.counters.blocks) || {},
          actions: (parsed.counters && parsed.counters.actions) || {},
          teachers: (parsed.counters && parsed.counters.teachers) || {},
          students: (parsed.counters && parsed.counters.students) || {},
        },
        feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        room_reports: cleanExpiredRoomReports(parsed.room_reports || {}),
        subscriptions: parsed.subscriptions || {},
        moodle_users: parsed.moodle_users || {},
        campus_events:
          Array.isArray(parsed.campus_events) && parsed.campus_events.length
            ? parsed.campus_events
            : getDefaultCampusEvents(),
        tracked_channels:
          Array.isArray(parsed.tracked_channels) && parsed.tracked_channels.length
            ? parsed.tracked_channels
            : ["uwed_official"],
        channel_posts: Array.isArray(parsed.channel_posts) ? parsed.channel_posts : [],
        last_channel_sync_ms: parsed.last_channel_sync_ms || 0,
      };
      lastFetchTs = Date.now();
      return memCache;
    } catch (_) {}
  }
  if (!memCache) memCache = createEmptyDb();
  return memCache;
}

async function saveDb(db, immediate = false) {
  memCache = db;
  lastFetchTs = Date.now();
  const now = Date.now();
  if (!immediate && now - lastSaveTs < 2500) {
    if (!pendingSavePromise) {
      pendingSavePromise = new Promise((resolve) => {
        setTimeout(async () => {
          pendingSavePromise = null;
          lastSaveTs = Date.now();
          await ghRequest("PATCH", `/gists/${GIST_ID}`, {
            files: {
              "telemetry_db.json": {
                content: JSON.stringify(memCache, null, 2),
              },
            },
          });
          resolve();
        }, 1200);
      });
    }
    return;
  }
  lastSaveTs = now;
  await ghRequest("PATCH", `/gists/${GIST_ID}`, {
    files: {
      "telemetry_db.json": {
        content: JSON.stringify(db, null, 2),
      },
    },
  });
}

function incCounter(obj, key, delta = 1) {
  if (!key) return;
  const k = String(key).trim().slice(0, 80);
  if (!k) return;
  obj[k] = (obj[k] || 0) + delta;
}

async function adminControlUser({ target_uid, set_blocked, admin_note, sent_message, set_pro }) {
  const db = await loadDb(true);
  const nowIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const uid = String(target_uid || "").trim();
  if (!uid) return db;

  const u = db.users[uid] || {
    id: uid,
    first_name: "User",
    last_name: "",
    username: "",
    phone: "",
    language_code: "uz",
    preferred_lang: "uz",
    first_seen: nowIso,
    last_seen: nowIso,
    actions_count: 0,
    sources: [],
    top_actions: {},
    last_actions: [],
    attending_events: [],
    blocked: false,
    is_pro: false,
    admin_note: "",
    sent_messages: [],
  };

  if (typeof set_blocked === "boolean" && uid !== "6906730753") {
    u.blocked = set_blocked;
  }
  if (typeof set_pro === "boolean") {
    u.is_pro = set_pro;
  }
  if (typeof admin_note === "string") {
    u.admin_note = admin_note.slice(0, 300);
  }
  if (sent_message) {
    if (!Array.isArray(u.sent_messages)) u.sent_messages = [];
    u.sent_messages.unshift({ ts: nowIso, text: String(sent_message).slice(0, 1000) });
    if (u.sent_messages.length > 30) u.sent_messages.length = 30;
  }

  db.users[uid] = u;
  await saveDb(db, true);
  return db;
}

async function recordTelemetry({
  user = {},
  action = "unknown",
  detail = "",
  meta = {},
  source = "miniapp",
  feedback = null,
  room_report = null,
  subscription = null,
  campus_event = null,
  event_attendance = null,
  moodle = null,
  hemis = null,
}) {
  try {
    const db = await loadDb();
    const nowIso = new Date(Date.now() + 5 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const uid = String(user.id || user.user_id || "anon");

    // 1. Upsert User Profile
    const existing = db.users[uid] || {
      id: uid,
      first_name: "",
      last_name: "",
      username: "",
      phone: "",
      language_code: "",
      preferred_lang: "",
      first_seen: nowIso,
      last_seen: nowIso,
      actions_count: 0,
      sources: [],
      top_actions: {},
      last_actions: [],
      attending_events: [],
      blocked: false,
      is_pro: false,
      admin_note: "",
      sent_messages: [],
    };

    if (user.first_name) existing.first_name = user.first_name;
    if (user.last_name) existing.last_name = user.last_name;
    if (user.username) existing.username = user.username;
    if (user.phone || user.phone_number) existing.phone = user.phone || user.phone_number;
    if (user.language_code) existing.language_code = user.language_code;
    if (user.preferred_lang && ["uz", "ru", "en"].includes(user.preferred_lang)) {
      existing.preferred_lang = user.preferred_lang;
    }
    if ((action === "change_lang" || action === "bot_lang") && ["uz", "ru", "en"].includes(detail)) {
      existing.preferred_lang = detail;
    }
    existing.last_seen = nowIso;
    existing.actions_count = (existing.actions_count || 0) + 1;
    if (!Array.isArray(existing.sources)) existing.sources = [];
    if (source && !existing.sources.includes(source)) existing.sources.push(source);

    if (!existing.top_actions) existing.top_actions = {};
    incCounter(existing.top_actions, action);

    if (!Array.isArray(existing.last_actions)) existing.last_actions = [];
    existing.last_actions.unshift({ ts: nowIso, action, detail: String(detail || "").slice(0, 140) });
    if (existing.last_actions.length > 60) existing.last_actions.length = 60;

    // Event Attendance / Notify Me toggle
    if (event_attendance && event_attendance.id) {
      if (!Array.isArray(existing.attending_events)) existing.attending_events = [];
      const evId = String(event_attendance.id);
      const idx = existing.attending_events.findIndex((e) => e.id === evId);
      if (event_attendance.remove) {
        if (idx !== -1) existing.attending_events.splice(idx, 1);
      } else if (idx === -1) {
        existing.attending_events.unshift({
          id: evId,
          title: String(event_attendance.title || "").slice(0, 140),
          date: String(event_attendance.date || nowIso.slice(0, 10)),
          time: String(event_attendance.time || "14:00"),
          location: String(event_attendance.location || "UWED"),
          channel_name: String(event_attendance.channel_name || "@uwed_official"),
          tg_link: String(event_attendance.tg_link || "https://t.me/uwed_official"),
          added_at: nowIso,
        });
        if (existing.attending_events.length > 40) existing.attending_events.length = 40;
      }
    }

    db.users[uid] = existing;

    // 2. Update Aggregate Counters
    incCounter(db.counters.actions, action);
    if (action === "open_room" || action === "bot_room") {
      incCounter(db.counters.rooms, detail);
    } else if (action === "select_block" || action === "bot_block") {
      incCounter(db.counters.blocks, detail);
    } else if (action === "search_query" || action === "bot_search") {
      incCounter(db.counters.searches, detail);
    } else if (action === "open_teacher" || action === "bot_teacher") {
      incCounter(db.counters.teachers, detail);
    } else if (action === "open_student" || action === "bot_student") {
      incCounter(db.counters.students, detail);
    }

    // 3. Record Feedback if provided
    if (feedback && feedback.message) {
      db.feedbacks.unshift({
        id: "fb_" + Date.now(),
        ts: nowIso,
        uid,
        name: [existing.first_name, existing.last_name].filter(Boolean).join(" ") || "Anonymous",
        username: existing.username ? `@${existing.username}` : "",
        phone: feedback.phone || existing.phone || "",
        category: feedback.category || "suggestion",
        rating: feedback.rating || 5,
        message: String(feedback.message).slice(0, 1000),
      });
      if (db.feedbacks.length > 200) db.feedbacks.length = 200;
    }

    // 4. Crowd-sourced Room Report (expires in 90 mins)
    if (room_report && room_report.room && room_report.status) {
      const rName = String(room_report.room).trim().toUpperCase();
      if (room_report.status === "clear") {
        delete db.room_reports[rName];
      } else {
        db.room_reports[rName] = {
          room: rName,
          status: String(room_report.status),
          note: String(room_report.note || "").slice(0, 120),
          uid,
          by: existing.first_name || existing.username || "Student",
          ts: nowIso,
          updated_ms: Date.now(),
          expires_at: Date.now() + 90 * 60 * 1000,
        };
      }
    }

    // 5. Personal Schedule Subscription (preserves cached_events & last_notified state!)
    if (subscription && subscription.target_id) {
      if (subscription.remove) {
        delete db.subscriptions[uid];
      } else {
        const prevSub = db.subscriptions[uid] || {};
        const compactEvents = Array.isArray(subscription.cached_events) && subscription.cached_events.length
          ? subscription.cached_events.slice(0, 60).map((e) => ({
              d: Number(e.d || e.week_day || 0),
              s: Number(e.s || e.slot_id || 0),
              t: String(e.t || e.title || e.lesson_name || "").slice(0, 90),
              r: String(e.r || e.room_number || "").slice(0, 24),
              i: String(e.i || e.instructor || "").slice(0, 60),
            })).filter((e) => e.d >= 1 && e.d <= 6 && e.s >= 1 && e.s <= 8)
          : (prevSub.cached_events || []);
        db.subscriptions[uid] = {
          uid,
          chat_id: user.chat_id || (/^\d+$/.test(uid) ? uid : prevSub.chat_id || ""),
          kind: subscription.kind || prevSub.kind || "STUDENT",
          target_id: String(subscription.target_id),
          title: String(subscription.title || prevSub.title || ""),
          lang: subscription.lang || existing.preferred_lang || existing.language_code || prevSub.lang || "ru",
          notify: subscription.notify !== false,
          cached_events: compactEvents,
          last_notified_slot: prevSub.last_notified_slot || null,
          last_morning_digest: prevSub.last_morning_digest || null,
          updated_at: nowIso,
        };
      }
    }

    // 5.5 Moodle Session & Verified Identity Sync (NEVER persists plaintext passwords)
    if (moodle && moodle.disconnect) {
      if (db.moodle_users && db.moodle_users[uid]) {
        delete db.moodle_users[uid];
      }
      if (existing.moodle) {
        existing.moodle.verified = false;
        existing.moodle.updated_at = nowIso;
      }
    } else if (moodle && (moodle.token || moodle.username || moodle.update_prefs)) {
      if (!db.moodle_users) db.moodle_users = {};
      if (!db.verified_moodle_links) db.verified_moodle_links = {};
      const prevM = db.moodle_users[uid] || {};
      const hasToken = Boolean(moodle.token || prevM.token);
      const mUserId = moodle.userid || prevM.userid || null;
      const nextGrades = Array.isArray(moodle.grades) ? moodle.grades : prevM.grades || [];
      const prevLastGrades = Array.isArray(prevM.last_grades) && prevM.last_grades.length
        ? prevM.last_grades
        : normalizeMoodleGrades(nextGrades);
      db.moodle_users[uid] = {
        uid,
        chat_id: user.chat_id || (/^\d+$/.test(uid) ? uid : prevM.chat_id || ""),
        token: moodle.token || prevM.token || "",
        username: moodle.username || prevM.username || "",
        fullname: moodle.fullname || prevM.fullname || moodle.username || "",
        userid: mUserId,
        verified: hasToken,
        verified_at: prevM.verified_at || (hasToken ? nowIso : null),
        courses: Array.isArray(moodle.courses) ? moodle.courses : prevM.courses || [],
        deadlines: Array.isArray(moodle.deadlines) ? moodle.deadlines : prevM.deadlines || [],
        grades: nextGrades,
        last_grades: prevLastGrades,
        notified_deadlines: prevM.notified_deadlines || {},
        notify_classes: moodle.notify_classes != null ? Boolean(moodle.notify_classes) : (prevM.notify_classes !== false),
        notify_grades: moodle.notify_grades != null ? Boolean(moodle.notify_grades) : (prevM.notify_grades !== false),
        notify_deadlines: moodle.notify_deadlines != null ? Boolean(moodle.notify_deadlines) : (prevM.notify_deadlines !== false),
        morning_digest: moodle.morning_digest != null ? Boolean(moodle.morning_digest) : (prevM.morning_digest !== false),
        morning_digest_time:
          typeof moodle.morning_digest_time === "string" && /^\d{2}:\d{2}$/.test(moodle.morning_digest_time)
            ? moodle.morning_digest_time
            : prevM.morning_digest_time || "07:45",
        lead_time_mins: Math.max(5, Math.min(60, Number(moodle.lead_time_mins) || prevM.lead_time_mins || 20)),
        last_notified_slot: prevM.last_notified_slot || null,
        last_morning_digest: prevM.last_morning_digest || null,
        last_moodle_poll_ts: prevM.last_moodle_poll_ts || Date.now(),
        updated_at: nowIso,
      };
      if (hasToken && mUserId) {
        db.verified_moodle_links[String(mUserId)] = uid;
      }
      existing.moodle = {
        verified: hasToken,
        username: db.moodle_users[uid].username,
        fullname: db.moodle_users[uid].fullname,
        userid: mUserId,
        updated_at: nowIso,
      };
    }

    // 5.6 HEMIS Safe Summary Sync (NEVER stores passwords or tokens — only GPA, NB, exams, contract)
    if (hemis && (hemis.full_name || hemis.gpa != null || Array.isArray(hemis.exams) || hemis.attendance)) {
      if (!db.hemis_users) db.hemis_users = {};
      const prevH = db.hemis_users[uid] || {};
      db.hemis_users[uid] = {
        uid,
        chat_id: user.chat_id || (/^\d+$/.test(uid) ? uid : prevH.chat_id || ""),
        full_name: hemis.full_name || prevH.full_name || "",
        student_id: hemis.student_id || prevH.student_id || "",
        group: hemis.group || prevH.group || "",
        faculty: hemis.faculty || prevH.faculty || "",
        level: hemis.level || prevH.level || "",
        gpa: hemis.gpa != null ? hemis.gpa : prevH.gpa ?? null,
        period: hemis.period || prevH.period || "",
        gpa_list: Array.isArray(hemis.gpa_list) ? hemis.gpa_list.slice(0, 12) : prevH.gpa_list || [],
        attendance: hemis.attendance || prevH.attendance || null,
        exams: Array.isArray(hemis.exams) ? hemis.exams.slice(0, 25) : prevH.exams || [],
        contract: hemis.contract || prevH.contract || null,
        documents: Array.isArray(hemis.documents) ? hemis.documents.slice(0, 20) : prevH.documents || [],
        performance: Array.isArray(hemis.performance) ? hemis.performance.slice(0, 30) : prevH.performance || [],
        subjects: Array.isArray(hemis.subjects) ? hemis.subjects.slice(0, 20) : prevH.subjects || [],
        notified_exams: prevH.notified_exams || {},
        updated_at: nowIso,
      };
      existing.hemis = {
        full_name: db.hemis_users[uid].full_name,
        group: db.hemis_users[uid].group,
        gpa: db.hemis_users[uid].gpa,
        updated_at: nowIso,
      };
    }

    // 6. Campus Event Submission (Strict Admin-Only @bxdxbxy / 6906730753)
    const isAdmin =
      uid === "6906730753" || String(existing.username || "").toLowerCase() === "bxdxbxy";
    if (campus_event && campus_event.title && isAdmin) {
      const newEv = {
        id: "ev_" + Date.now(),
        category: campus_event.category || "campus",
        title_uz: campus_event.title,
        title_ru: campus_event.title,
        title_en: campus_event.title,
        date: campus_event.date || nowIso.slice(0, 10),
        time: campus_event.time || "14:00",
        location: campus_event.location || "UWED Campus",
        channel_name: campus_event.channel_name || "@uwed_official",
        tg_link: campus_event.tg_link || "https://t.me/uwed_official",
        desc_uz: campus_event.description || "",
        desc_ru: campus_event.description || "",
        desc_en: campus_event.description || "",
        submitted_by: "@bxdxbxy",
        is_scheduled_event: true,
        approved: true,
        created_at: nowIso,
      };
      db.campus_events.unshift(newEv);
      if (db.campus_events.length > 60) db.campus_events.length = 60;
    }

    // 7. Append Event Log
    db.events.unshift({
      ts: nowIso,
      uid,
      name: [existing.first_name, existing.last_name].filter(Boolean).join(" ") || "Guest",
      username: existing.username ? `@${existing.username}` : "",
      phone: existing.phone || "",
      source,
      action,
      detail: String(detail || "").slice(0, 140),
      meta,
    });
    if (db.events.length > 300) db.events.length = 300;

    const needsImmediate = Boolean(
      feedback || room_report || subscription || campus_event || event_attendance || moodle ||
      action === "change_lang" || action === "bot_lang" || action === "save_settings"
    );
    await saveDb(db, needsImmediate);
    return db;
  } catch (err) {
    console.error("Telemetry error:", err);
    return null;
  }
}

async function adminSetMaintenance({ enabled }) {
  const db = await loadDb(true);
  db.maintenance_mode = Boolean(enabled);
  await saveDb(db, true);
  return db;
}

let memSnapshot = null;
let lastSnapshotFetchTs = 0;

async function loadSnapshotFromDb(force = false) {
  if (!force && memSnapshot && Date.now() - lastSnapshotFetchTs < 60000) {
    return memSnapshot;
  }
  try {
    const gist = await ghRequest("GET", `/gists/${GIST_ID}`);
    if (gist && gist.files && gist.files["campus_snapshot.json"] && gist.files["campus_snapshot.json"].content) {
      const parsed = JSON.parse(gist.files["campus_snapshot.json"].content);
      if (parsed && (parsed.slots || parsed.rooms || parsed.teachers || parsed.students)) {
        memSnapshot = parsed;
        lastSnapshotFetchTs = Date.now();
        return memSnapshot;
      }
    }
  } catch (_) {}

  // Fallback to local snapshot file on disk
  if (!memSnapshot) {
    try {
      memSnapshot = require("../public/snapshot.json");
      lastSnapshotFetchTs = Date.now();
    } catch (_) {
      memSnapshot = { slots: [], rooms: [], teachers: [], events: {} };
    }
  }
  return memSnapshot;
}

async function saveSnapshotToDb(snapshotData, source = "office_pc") {
  if (!snapshotData || typeof snapshotData !== "object") return null;

  const now = Date.now();
  const validSnapshot = {
    updated_at: snapshotData.updated_at || now,
    source,
    week_monday:
      snapshotData.week_monday ||
      new Date(now + 5 * 3600 * 1000).toISOString().split("T")[0],
    slots: Array.isArray(snapshotData.slots) ? snapshotData.slots : [],
    rooms: Array.isArray(snapshotData.rooms) ? snapshotData.rooms : [],
    teachers: Array.isArray(snapshotData.teachers) ? snapshotData.teachers : [],
    students: Array.isArray(snapshotData.students) ? snapshotData.students : [],
    events:
      snapshotData.events && typeof snapshotData.events === "object"
        ? snapshotData.events
        : {},
  };

  memSnapshot = validSnapshot;
  lastSnapshotFetchTs = now;

  const db = await loadDb(true);
  db.campus_snapshot_meta = {
    updated_at: now,
    source,
    slots_count: validSnapshot.slots.length,
    rooms_count: validSnapshot.rooms.length,
    teachers_count: validSnapshot.teachers.length,
    students_count: validSnapshot.students.length,
    events_count: Object.keys(validSnapshot.events).length,
  };
  await saveDb(db, true);

  // Save into GitHub Gist file campus_snapshot.json
  await ghRequest("PATCH", `/gists/${GIST_ID}`, {
    files: {
      "campus_snapshot.json": {
        content: JSON.stringify(validSnapshot),
      },
    },
  });

  return validSnapshot;
}


function moodleWsPost(pathStr, formObj, timeoutMs = 6500) {
  return new Promise((resolve) => {
    try {
      const postData = new URLSearchParams(formObj).toString();
      const req = https.request(
        {
          hostname: "moodle.uwed.uz",
          port: 443,
          path: pathStr,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(postData),
            "User-Agent": "MoodleMobile 4.4.0",
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch (_) {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.write(postData);
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

function normalizeMoodleGrades(rawGrades) {
  const out = [];
  if (!Array.isArray(rawGrades)) return out;
  for (const g of rawGrades) {
    if (!g) continue;
    const course = String(g.course || g.coursename || "Moodle").trim();
    if (Array.isArray(g.items)) {
      for (const it of g.items) {
        if (!it) continue;
        const item = String(it.name || it.item || "").trim();
        const score = String(it.score != null ? it.score : (it.grade != null ? it.grade : "")).trim();
        if (item) out.push({ course, item, score });
      }
    } else {
      const item = String(g.item || g.name || "").trim();
      const score = String(g.grade != null ? g.grade : (g.score != null ? g.score : "")).trim();
      if (item || score) out.push({ course, item: item || "Оценка", score });
    }
  }
  return out;
}

async function refreshMoodleForUser(mUser) {
  if (!mUser || !mUser.token) return false;
  const callWs = (wsfunction, extra = {}) =>
    moodleWsPost("/webservice/rest/server.php", {
      wstoken: mUser.token,
      moodlewsrestformat: "json",
      wsfunction,
      ...extra,
    });

  let userid = mUser.userid;
  if (!userid) {
    const info = await callWs("core_webservice_get_site_info");
    if (!info || info.exception || !info.userid) return false;
    userid = info.userid;
    mUser.userid = userid;
    if (info.fullname) mUser.fullname = info.fullname;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const [coursesRaw, calRaw] = await Promise.all([
    callWs("core_enrol_get_users_courses", { userid }),
    callWs("core_calendar_get_action_events_by_timesort", {
      timesortfrom: nowSec - 2 * 86400,
      limitnum: 30,
    }),
  ]);

  if (Array.isArray(coursesRaw) && coursesRaw.length) {
    mUser.courses = coursesRaw.map((c) => ({
      id: c.id,
      name: c.fullname || c.shortname || `Course #${c.id}`,
      progress: c.progress != null ? Math.round(c.progress) : null,
    }));
  }

  if (calRaw && Array.isArray(calRaw.events)) {
    mUser.deadlines = calRaw.events
      .map((ev) => ({
        id: ev.id,
        name: ev.name || "Assignment",
        course: (ev.course && ev.course.fullname) || "",
        time: ev.timestart || ev.usermidnight || nowSec,
        url: ev.url || "",
      }))
      .sort((a, b) => a.time - b.time);
  }

  const courseList = Array.isArray(mUser.courses) ? mUser.courses.slice(0, 8) : [];
  if (courseList.length) {
    const freshGrades = [];
    await Promise.all(
      courseList.map(async (c) => {
        try {
          const gRes = await callWs("gradereport_user_get_grade_items", { courseid: c.id, userid });
          const itemsRaw =
            (gRes && gRes.usergrades && gRes.usergrades[0] && gRes.usergrades[0].gradeitems) || [];
          const items = itemsRaw
            .filter((it) => it.itemname || it.itemtype === "course")
            .map((it) => ({
              name: it.itemtype === "course" ? "∑ Итого по курсу" : it.itemname,
              score:
                it.gradeformatted && it.gradeformatted !== "-"
                  ? String(it.gradeformatted).replace(/<[^>]+>/g, "").trim()
                  : "—",
            }));
          if (items.length) freshGrades.push({ course: c.name, items });
        } catch (_) {}
      })
    );
    if (freshGrades.length) {
      mUser.grades = freshGrades;
    }
  }

  mUser.last_moodle_poll_ts = Date.now();
  return true;
}

async function checkAndDispatchAlerts(snap, tgSender, opts = {}) {
  if (typeof tgSender !== "function") return { count: 0, checked_subs: 0, checked_moodle: 0, refreshed_moodle: 0 };
  const db = await loadDb(true);
  if (!db) return { count: 0, checked_subs: 0, checked_moodle: 0, refreshed_moodle: 0 };

  const forceRefresh = Boolean(opts && opts.forceRefresh);
  const nowTashkent = new Date(Date.now() + 5 * 3600 * 1000);
  const day = nowTashkent.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const hh = nowTashkent.getUTCHours();
  const mm = nowTashkent.getUTCMinutes();
  const curMins = hh * 60 + mm;
  const todayStr = nowTashkent.toISOString().slice(0, 10);

  const SLOT_CONFIG = [
    { id: 1, start: "08:30", end: "09:40", startMins: 510 },
    { id: 2, start: "09:55", end: "11:05", startMins: 595 },
    { id: 3, start: "11:20", end: "12:30", startMins: 680 },
    { id: 4, start: "12:45", end: "13:55", startMins: 765 },
    { id: 5, start: "14:30", end: "15:40", startMins: 870 },
    { id: 6, start: "15:55", end: "17:05", startMins: 955 },
    { id: 7, start: "17:20", end: "18:30", startMins: 1040 },
    { id: 8, start: "18:45", end: "19:55", startMins: 1125 },
  ];

  let dispatchedCount = 0;
  let checkedSubs = 0;
  let checkedMoodle = 0;
  let refreshedMoodle = 0;
  let dbDirty = false;

  const isUserBlocked = (uId) => Boolean(uId && String(uId) !== "6906730753" && db.users && db.users[String(uId)] && db.users[String(uId)].blocked);

  // Build quick student -> group map from snapshot so student UUID subscriptions match cleanly
  const studentGroupById = new Map();
  const studentGroupByName = new Map();
  if (snap && Array.isArray(snap.students)) {
    for (const st of snap.students) {
      const grp = String(st.group || st.group_name || "").trim().toLowerCase();
      if (st.id && grp) studentGroupById.set(String(st.id), grp);
      const fn = String(st.full_name || st.name || "").trim().toLowerCase();
      if (fn && grp) studentGroupByName.set(fn, grp);
    }
  }

  const findSlotEventForSub = (sub, targetDay, slotId) => {
    // 1. FIRST PRIORITY: Exact cached personal schedule synced from Mini App (works 100% for Student UUIDs, Teachers & Groups!)
    if (sub && Array.isArray(sub.cached_events) && sub.cached_events.length) {
      const hit = sub.cached_events.find(
        (e) => Number(e.d || e.week_day) === targetDay && Number(e.s || e.slot_id) === slotId
      );
      if (hit) {
        return {
          d: targetDay,
          s: slotId,
          t: hit.t || hit.title || "Занятие",
          r: hit.r || hit.room_number || "—",
          i: hit.i || hit.instructor || "—",
        };
      }
      return null;
    }

    if (!snap || !snap.events) return null;
    if (sub.kind === "TEACHER") {
      const tName = String(sub.title || "").trim().toLowerCase();
      if (!tName) return null;
      for (const elist of Object.values(snap.events)) {
        for (const e of elist) {
          if (Number(e.d) === targetDay && Number(e.s) === slotId && e.i && e.i.toLowerCase().includes(tName)) {
            return e;
          }
        }
      }
      return null;
    }
    if (sub.kind === "ROOM") {
      const rEvents = snap.events[sub.target_id] || [];
      return rEvents.find((e) => Number(e.d) === targetDay && Number(e.s) === slotId) || null;
    }
    const rawTarget = String(sub.target_id || "").trim();
    const rawTitle = String(sub.title || "").trim().toLowerCase();
    const resolvedGrp = (
      studentGroupById.get(rawTarget) ||
      studentGroupByName.get(rawTitle) ||
      (rawTarget || rawTitle)
        .replace(/^grp[:_]/i, "")
        .replace(/^(guruh|группа|group):?\s*/i, "")
        .trim()
        .toLowerCase()
    ).replace(/["']/g, "");
    if (!resolvedGrp) return null;
    for (const elist of Object.values(snap.events)) {
      for (const e of elist) {
        if (Number(e.d) === targetDay && Number(e.s) === slotId) {
          const eg = String(e.g || e.grp || "").replace(/["']/g, "").toLowerCase();
          if (eg && (eg.includes(resolvedGrp) || resolvedGrp.includes(eg))) {
            return e;
          }
        }
      }
    }
    return null;
  };

  // 1. CLASS REMINDERS (leadTime ± 8 min before pair starts, Monday to Saturday)
  const activeSubs = Object.values(db.subscriptions || {});
  checkedSubs = activeSubs.length;
  if (day >= 1 && day <= 6) {
    for (const sub of activeSubs) {
      const subChatId = sub && (sub.chat_id || (/^\d+$/.test(String(sub.uid || "")) ? String(sub.uid) : ""));
      if (!sub || !subChatId || sub.notify === false || isUserBlocked(sub.uid) || isUserBlocked(subChatId)) continue;
      const mUser = (db.moodle_users && db.moodle_users[sub.uid]) || {};
      if (mUser.notify_classes === false) continue;
      const leadTime = Number(mUser.lead_time_mins) || 20;

      for (const slot of SLOT_CONFIG) {
        const diff = slot.startMins - curMins;
        if (diff >= Math.max(1, leadTime - 8) && diff <= leadTime + 8) {
          const notifyKey = `${todayStr}_slot_${slot.id}`;
          if (sub.last_notified_slot === notifyKey) continue;

          const matchedEvent = findSlotEventForSub(sub, day, slot.id);
          if (matchedEvent) {
            const lang = sub.lang || (db.users && db.users[sub.uid] && db.users[sub.uid].preferred_lang) || "ru";
            const msg =
              lang === "uz"
                ? `🔔 <b>Dars eslatmasi (taxminan ${diff} daqiqadan sõng)!</b>\n\n` +
                  `📚 <b>${matchedEvent.t || "Dars"}</b>\n` +
                  `🚪 Xona: <b>${matchedEvent.r || "—"}</b>\n` +
                  `👨‍🏫 Õqituvçi: <i>${matchedEvent.i || "—"}</i>\n` +
                  `⏰ Vaqt: <code>${slot.start} – ${slot.end}</code> (${slot.id}-para)\n\n` +
                  `📍 <i>Darsga keçikmang! Moodle materiallarini tekşiring.</i>`
                : `🔔 <b>Напоминание о паре (через ${diff} мин)!</b>\n\n` +
                  `📚 <b>${matchedEvent.t || "Занятие"}</b>\n` +
                  `🚪 Аудитория: <b>${matchedEvent.r || "—"}</b>\n` +
                  `👨‍🏫 Преподаватель: <i>${matchedEvent.i || "—"}</i>\n` +
                  `⏰ Время: <code>${slot.start} – ${slot.end}</code> (${slot.id}-я пара)\n\n` +
                  `📍 <i>Хорошей пары! Проверьте материалы в Moodle.</i>`;

            await tgSender("sendMessage", {
              chat_id: subChatId,
              text: msg,
              parse_mode: "HTML",
            });
            sub.last_notified_slot = notifyKey;
            dbDirty = true;
            dispatchedCount++;
          }
        }
      }
    }
  }

  // 2. DAILY DIGEST AT USER'S CHOSEN TIME (default 07:45 Tashkent time, customizable per user!)
  if (day >= 1 && day <= 6) {
    for (const sub of activeSubs) {
      if (!sub || !sub.chat_id || sub.last_morning_digest === todayStr || isUserBlocked(sub.uid) || isUserBlocked(sub.chat_id)) continue;
      const mUser = (db.moodle_users && db.moodle_users[sub.uid]) || {};
      if (mUser.morning_digest === false) continue;

      const digestTimeStr =
        typeof mUser.morning_digest_time === "string" && /^\d{2}:\d{2}$/.test(mUser.morning_digest_time)
          ? mUser.morning_digest_time
          : "07:45";
      const [dH, dM] = digestTimeStr.split(":").map((n) => parseInt(n, 10) || 0);
      const targetMins = dH * 60 + dM;
      if (curMins < targetMins || curMins > targetMins + 18) continue;

      const leadTime = Number(mUser.lead_time_mins) || 20;
      const todayClasses = [];
      for (const slot of SLOT_CONFIG) {
        const foundEv = findSlotEventForSub(sub, day, slot.id);
        if (foundEv) {
          todayClasses.push({ slot: slot.id, time: `${slot.start}–${slot.end}`, title: foundEv.t, room: foundEv.r });
        }
      }

      if (todayClasses.length > 0 || (Array.isArray(mUser.deadlines) && mUser.deadlines.length > 0)) {
        const lang = sub.lang || (db.users && db.users[sub.uid] && db.users[sub.uid].preferred_lang) || "ru";
        const nowSec = Math.floor(Date.now() / 1000);
        const soonDl = (mUser.deadlines || []).filter((d) => d.time && d.time > nowSec && d.time - nowSec <= 48 * 3600);
        const classLines = todayClasses.length
          ? todayClasses.map((c) => `• <code>${c.time}</code> (${c.slot}-пара): <b>${c.title}</b> (Ауд. <b>${c.room || "—"}</b>)`).join("\n")
          : (lang === "uz" ? "• Bugun darslar yõq" : "• Сегодня пар нет");
        const dlBlock = soonDl.length
          ? (lang === "uz" ? "\n\n📌 <b>Yaqin 48 soatdagi Moodle dedlaynlari:</b>\n" : "\n\n📌 <b>Дедлайны Moodle в ближайшие 48ч:</b>\n") +
            soonDl.slice(0, 5).map((d) => `• ⏰ <b>${d.name || d.title || "Задание"}</b> (${d.course || "Moodle"})`).join("\n")
          : "";
        const msg =
          lang === "uz"
            ? `🌅 <b>Kunlik xulosa (${todayStr} · ${digestTimeStr}):</b>\n\n${classLines}${dlBlock}\n\n🔔 <i>Har bir darsdan ${leadTime} daqiqa oldin eslatma yuboramiz!</i>`
            : `🌅 <b>Сводка на сегодня (${todayStr} · ${digestTimeStr}):</b>\n\n${classLines}${dlBlock}\n\n🔔 <i>Бот предупредит за ${leadTime} мин до начала каждой пары!</i>`;

        await tgSender("sendMessage", {
          chat_id: sub.chat_id,
          text: msg,
          parse_mode: "HTML",
        });
        sub.last_morning_digest = todayStr;
        dbDirty = true;
        dispatchedCount++;
      }
    }
  }

  // 3. LIVE MOODLE REFRESH + DEADLINE & GRADE ALERTS
  const nowSecAll = Math.floor(Date.now() / 1000);
  const nowMsAll = Date.now();
  const moodleUsersList = Object.values(db.moodle_users || {});
  checkedMoodle = moodleUsersList.length;

  for (const mUser of moodleUsersList) {
    const mChatId = mUser && (mUser.chat_id || (/^\d+$/.test(String(mUser.uid || "")) ? String(mUser.uid) : ""));
    if (!mUser || !mChatId || !/^\d+$/.test(String(mChatId)) || isUserBlocked(mUser.uid) || isUserBlocked(mChatId)) continue;

    // Poll Moodle live at most every 20 minutes per user (or immediately on forceRefresh)
    if (mUser.token && (forceRefresh || nowMsAll - (mUser.last_moodle_poll_ts || 0) >= 20 * 60 * 1000)) {
      const okRef = await refreshMoodleForUser(mUser);
      if (okRef) {
        refreshedMoodle++;
        dbDirty = true;
      }
    }

    const lang =
      (db.users && db.users[mUser.uid] && db.users[mUser.uid].preferred_lang) ||
      (db.subscriptions && db.subscriptions[mUser.uid] && db.subscriptions[mUser.uid].lang) ||
      "ru";

    // 3A. MOODLE DEADLINE ALERTS (<48h, <24h, and <3h warnings, deduplicated)
    if (mUser.notify_deadlines !== false) {
      if (!mUser.notified_deadlines) mUser.notified_deadlines = {};
      for (const dl of mUser.deadlines || []) {
        if (!dl || !dl.time) continue;
        const secsLeft = dl.time - nowSecAll;
        if (secsLeft <= 0 || secsLeft > 48 * 3600) continue;
        const bucket = secsLeft <= 3 * 3600 ? "3h" : secsLeft <= 24 * 3600 ? "24h" : "48h";
        const dlKey = `${dl.id || dl.name}_${dl.time}_${bucket}`;
        if (mUser.notified_deadlines[dlKey]) continue;
        const hrs = Math.max(1, Math.round(secsLeft / 3600));
        const dlDt = new Date((dl.time + 5 * 3600) * 1000).toISOString().replace("T", " ").slice(5, 16);
        const msg =
          lang === "uz"
            ? `⏳ <b>Moodle dedlayn eslatmasi (${hrs} soat qoldi)!</b>\n\n📝 <b>${dl.name || dl.title || "Topşiriq"}</b>\n📚 Kurs: <i>${dl.course || "Moodle"}</i>\n🕒 Muddat: <code>${dlDt}</code>`
            : `⏳ <b>Скоро дедлайн в Moodle (осталось ~${hrs} ч.)!</b>\n\n📝 <b>${dl.name || dl.title || "Задание"}</b>\n📚 Курс: <i>${dl.course || "Moodle"}</i>\n🕒 Срок: <code>${dlDt}</code>`;
        const replyMarkup = dl.url
          ? { inline_keyboard: [[{ text: lang === "uz" ? "🔗 Moodle'da oçiş" : "🔗 Открыть в Moodle", url: dl.url }]] }
          : undefined;
        await tgSender("sendMessage", { chat_id: mChatId, text: msg, parse_mode: "HTML", reply_markup: replyMarkup });
        mUser.notified_deadlines[dlKey] = nowSecAll;
        dbDirty = true;
        dispatchedCount++;
      }
    }

    // 3B. MOODLE GRADE CHANGE ALERTS (handles both nested {course, items} and flat formats)
    if (mUser.notify_grades !== false && Array.isArray(mUser.grades) && mUser.grades.length > 0) {
      const curFlat = normalizeMoodleGrades(mUser.grades);
      const prevFlat = normalizeMoodleGrades(mUser.last_grades || []);
      const prevMap = new Map();
      for (const g of prevFlat) {
        prevMap.set(`${g.course}|${g.item}`, g.score);
      }

      if (prevFlat.length === 0) {
        // First baseline snapshot — save without spamming old grades
        mUser.last_grades = curFlat;
        dbDirty = true;
      } else {
        const changed = [];
        for (const g of curFlat) {
          const k = `${g.course}|${g.item}`;
          const val = String(g.score || "").trim();
          if (!val || val === "-" || val === "—") continue;
          const prevVal = prevMap.has(k) ? String(prevMap.get(k) || "").trim() : "";
          if (prevVal !== val) {
            changed.push({ course: g.course, item: g.item, prev: prevVal || "—", next: val });
          }
        }
        if (changed.length > 0) {
          const lines = changed
            .slice(0, 8)
            .map((c) => `• <b>${c.course}</b> — ${c.item}: <code>${c.next}</code>${c.prev && c.prev !== "—" && c.prev !== "-" ? ` (было ${c.prev})` : ""}`)
            .join("\n");
          const msg =
            lang === "uz"
              ? `🎓 <b>Moodle'da yangi baho qõyildi!</b>\n\n${lines}`
              : `🎓 <b>Новая оценка в Moodle!</b>\n\n${lines}`;
          await tgSender("sendMessage", { chat_id: mChatId, text: msg, parse_mode: "HTML" });
          mUser.last_grades = curFlat;
          dbDirty = true;
          dispatchedCount++;
        }
      }
    }
  }

  // 4. HEMIS EXAM REMINDERS (24h and 2h before exam)
  const hemisUsers = Object.values(db.hemis_users || {});
  const nowEpochSec = Math.floor(Date.now() / 1000);
  for (const hUser of hemisUsers) {
    const hChatId = hUser && (hUser.chat_id || (/^\d+$/.test(String(hUser.uid || "")) ? String(hUser.uid) : ""));
    if (!hChatId || !Array.isArray(hUser.exams) || !hUser.exams.length) continue;
    if (isUserBlocked(hUser.uid) || isUserBlocked(hChatId)) continue;
    if (!hUser.notified_exams) hUser.notified_exams = {};
    const lang = (db.users && db.users[hUser.uid] && db.users[hUser.uid].preferred_lang) || "ru";
    for (const ex of hUser.exams) {
      if (!ex || !ex.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(ex.date))) continue;
      const tStr = ex.time && /^\d{2}:\d{2}/.test(String(ex.time)) ? String(ex.time).slice(0, 5) : "09:00";
      const exTsMs = Date.parse(`${ex.date}T${tStr}:00+05:00`);
      if (isNaN(exTsMs)) continue;
      const secsLeft = Math.floor(exTsMs / 1000) - nowEpochSec;
      if (secsLeft <= 0 || secsLeft > 26 * 3600) continue;
      const bucket = secsLeft <= 3 * 3600 ? "2h" : "24h";
      const exKey = `${ex.subject || "exam"}_${ex.date}_${tStr}_${bucket}`;
      if (hUser.notified_exams[exKey]) continue;
      const hrs = Math.max(1, Math.round(secsLeft / 3600));
      const msg =
        lang === "uz"
          ? `📝 <b>Imtihon eslatmasi (taxminan ${hrs} soat qoldi)!</b>\n\n📚 <b>${ex.subject || "Imtihon"}</b>\n📅 Sana: <code>${ex.date} ${tStr}</code>${ex.room ? `\n🚪 Xona: <b>${ex.room}</b>` : ""}${ex.teacher ? `\n👨‍🏫 Õqituvçi: <i>${ex.teacher}</i>` : ""}`
          : `📝 <b>Напоминание об экзамене (через ~${hrs} ч.)!</b>\n\n📚 <b>${ex.subject || "Экзамен"}</b>\n📅 Дата: <code>${ex.date} ${tStr}</code>${ex.room ? `\n🚪 Аудитория: <b>${ex.room}</b>` : ""}${ex.teacher ? `\n👨‍🏫 Преподаватель: <i>${ex.teacher}</i>` : ""}`;
      await tgSender("sendMessage", { chat_id: hChatId, text: msg, parse_mode: "HTML" });
      hUser.notified_exams[exKey] = nowEpochSec;
      dbDirty = true;
      dispatchedCount++;
    }
  }

  if (dbDirty) {
    await saveDb(db, true);
  }
  return { count: dispatchedCount, checked_subs: checkedSubs, checked_moodle: checkedMoodle, refreshed_moodle: refreshedMoodle };
}

module.exports = {
  loadDb,
  saveDb,
  recordTelemetry,
  adminControlUser,
  adminManageChannels,
  syncTrackedChannels,
  adminSetMaintenance,
  loadSnapshotFromDb,
  saveSnapshotToDb,
  checkAndDispatchAlerts,
};
