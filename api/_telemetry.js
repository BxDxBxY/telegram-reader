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

    // 5. Personal Schedule Subscription
    if (subscription && subscription.target_id) {
      if (subscription.remove) {
        delete db.subscriptions[uid];
      } else {
        db.subscriptions[uid] = {
          uid,
          chat_id: user.chat_id || uid,
          kind: subscription.kind || "STUDENT",
          target_id: String(subscription.target_id),
          title: String(subscription.title || ""),
          lang: subscription.lang || existing.preferred_lang || existing.language_code || "uz",
          notify: subscription.notify !== false,
          updated_at: nowIso,
        };
      }
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
      feedback || room_report || subscription || campus_event || event_attendance
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
      if (parsed && (parsed.slots || parsed.rooms || parsed.teachers)) {
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
};
