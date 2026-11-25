const crypto = require("crypto");
const https = require("https");
const {
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
} = require("./_telemetry");

const BOT_TOKEN =
  process.env.UWED_HELPDESK_TOKEN || "9214404778:AAE45Ty8GF45qKluBfFkuOpQxGiih42nYeE";
const ADMIN_ID = "6906730753";
const ADMIN_USERNAME = "bxdxbxy";

function getAdminSecretKey() {
  return crypto
    .createHmac("sha256", BOT_TOKEN)
    .update(`uwed_admin_${ADMIN_ID}_${ADMIN_USERNAME}`)
    .digest("hex")
    .slice(0, 32);
}

function sendTelegramMessage(chatId, text, replyMarkup = null) {
  return new Promise((resolve) => {
    const payloadObj = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) payloadObj.reply_markup = replyMarkup;
    const body = JSON.stringify(payloadObj);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        port: 443,
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (_) {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.write(body);
    req.end();
  });
}

function sendTelegramDocument(chatId, filename, contentStr, captionHtml) {
  return new Promise((resolve) => {
    const boundary = "----UWEDBotBoundary" + Date.now().toString(16);
    const parts = [];
    const addField = (name, val) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
          "utf-8"
        )
      );
    };
    addField("chat_id", String(chatId));
    addField("parse_mode", "HTML");
    if (captionHtml) addField("caption", String(captionHtml).slice(0, 950));

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: text/calendar; charset=utf-8\r\n\r\n`,
        "utf-8"
      )
    );
    parts.push(Buffer.from(String(contentStr || ""), "utf-8"));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"));

    const bodyBuf = Buffer.concat(parts);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        port: 443,
        path: `/bot${BOT_TOKEN}/sendDocument`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": bodyBuf.length,
        },
        timeout: 9000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (_) {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.write(bodyBuf);
    req.end();
  });
}

function escapeIcsText(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildScheduleIcs({ title, period, baseDateStr, events = [], attendingEvents = [] }) {
  const SLOT_TIMES = {
    1: ["083000", "094000", "08:30–09:40"],
    2: ["095500", "110500", "09:55–11:05"],
    3: ["112000", "123000", "11:20–12:30"],
    4: ["124500", "135500", "12:45–13:55"],
    5: ["143000", "154000", "14:30–15:40"],
    6: ["155500", "170500", "15:55–17:05"],
    7: ["172000", "183000", "17:20–18:30"],
    8: ["184500", "195500", "18:45–19:55"],
  };
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UWED Helpdesk//Schedule Export 2.0//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText("UWED - " + title)}`,
    "X-WR-TIMEZONE:Asia/Tashkent",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Tashkent",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0500",
    "TZOFFSETTO:+0500",
    "TZNAME:UZT",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  const baseDt = baseDateStr ? new Date(`${baseDateStr}T12:00:00Z`) : new Date(Date.now() + 5 * 3600 * 1000);
  const rawWday = baseDt.getUTCDay(); // 0=Sun, 1=Mon..6=Sat
  const targetWday = rawWday === 0 ? 1 : rawWday;
  const diffToMon = rawWday === 0 ? 1 : 1 - rawWday; // If Sun, jump to upcoming Monday

  const seen = new Set();
  const summaryLines = [];
  let count = 0;
  for (const ev of events) {
    const wday = Number(ev.week_day || ev.d || 0);
    const sid = Number(ev.slot_id || ev.s || 0);
    if (!wday || !sid || !SLOT_TIMES[sid]) continue;
    if (period === "daily" && wday !== targetWday) continue;
    const key = `${wday}_${sid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const d = new Date(baseDt);
    d.setUTCDate(baseDt.getUTCDate() + diffToMon + (wday - 1));
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
    const [st, et, timeLabel] = SLOT_TIMES[sid];
    const subjRaw = String(ev.title || ev.t || ev.lesson_name || ev.ln || "UWED Class").trim();
    const rmRaw = String(ev.room_number || ev.r || "UWED").trim();
    const instrRaw = String(ev.instructor || ev.i || "").trim();
    const descParts = [instrRaw, ev.code || ev.c, ev.groups || ev.grp || ev.g, ev.lesson_name || ev.ln].filter(Boolean);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:uwed-${period}-${wday}-${sid}-${ymd}@uwed.uz`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;TZID=Asia/Tashkent:${ymd}T${st}`);
    lines.push(`DTEND;TZID=Asia/Tashkent:${ymd}T${et}`);
    if (period === "monthly") {
      lines.push("RRULE:FREQ=WEEKLY;COUNT=4");
    }
    lines.push("STATUS:CONFIRMED");
    lines.push(`SUMMARY:${escapeIcsText(`${subjRaw} (${rmRaw})`)}`);
    lines.push(`LOCATION:${escapeIcsText(`UWED Room ${rmRaw}`)}`);
    if (descParts.length) {
      lines.push(`DESCRIPTION:${escapeIcsText(descParts.join(" | "))}`);
    }
    lines.push("END:VEVENT");
    count++;
    if (summaryLines.length < 10) {
      summaryLines.push(`• <code>${timeLabel}</code> <b>${subjRaw}</b> (${rmRaw})`);
    }
  }

  // Also include user's registered Campus Events inside the .ics file
  for (const cev of attendingEvents || []) {
    if (!cev || !cev.date) continue;
    if (period === "daily" && baseDateStr && cev.date !== baseDateStr) continue;
    const ymd = String(cev.date).replace(/-/g, "");
    if (!/^\d{8}$/.test(ymd)) continue;
    const cleanHm = String(cev.time || "14:00").replace(":", "").replace(/\D/g, "");
    const st = `${cleanHm.padEnd(4, "0").slice(0, 4)}00`;
    const hr = Math.min(23, (parseInt(cleanHm.slice(0, 2), 10) || 14) + 1);
    const et = `${String(hr).padStart(2, "0")}${cleanHm.slice(2, 4).padEnd(2, "0")}00`;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:uwed-ev-${String(cev.id || count).replace(/[^a-zA-Z0-9_-]/g, "")}@uwed.uz`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;TZID=Asia/Tashkent:${ymd}T${st}`);
    lines.push(`DTEND;TZID=Asia/Tashkent:${ymd}T${et}`);
    lines.push("STATUS:CONFIRMED");
    lines.push(`SUMMARY:${escapeIcsText(`[EVENT] ${cev.title || ""}`)}`);
    lines.push(`LOCATION:${escapeIcsText(cev.location || "UWED")}`);
    lines.push(`DESCRIPTION:${escapeIcsText(`Telegram Post: ${cev.tg_link || ""}`)}`);
    lines.push("END:VEVENT");
    count++;
  }

  lines.push("END:VCALENDAR");
  return { ics: lines.join("\r\n") + "\r\n", count, summaryLines };
}

function verifyTelegramInitData(initDataRaw) {
  if (!initDataRaw) return null;
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (computedHash !== hash) return null;
    const userStr = params.get("user");
    return userStr ? JSON.parse(userStr) : null;
  } catch (_) {
    return null;
  }
}

function isAuthorizedAdminRequest(req) {
  const key = req.query.key || req.headers["x-admin-key"] || (req.body && req.body.admin_key) || "";
  if (key && key === getAdminSecretKey()) {
    return true;
  }
  const initData =
    req.headers["x-tg-init-data"] || req.query.initData || (req.body && req.body.initData) || "";
  const tgUser = verifyTelegramInitData(initData);
  if (
    tgUser &&
    (String(tgUser.id) === ADMIN_ID ||
      String(tgUser.username || "").toLowerCase() === ADMIN_USERNAME)
  ) {
    return true;
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tg-Init-Data, X-Admin-Key");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Test & verify personal alerts right now (sends immediate summary of today's classes + upcoming Moodle deadlines to the user's Telegram!)
  if (req.query.action === "test_my_alerts" || (req.body && req.body.action === "test_my_alerts")) {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const initDataHdr = req.headers["x-tg-init-data"] || b.initData || "";
    const verifiedTgUser = verifyTelegramInitData(initDataHdr);
    const uidStr = String((verifiedTgUser && verifiedTgUser.id) || (b.user && b.user.id) || req.query.uid || "").trim();
    if (!/^\d+$/.test(uidStr)) {
      return res.status(200).json({ success: false, error: "telegram_user_required" });
    }
    const db = await loadDb(true);
    const sub = db.subscriptions && db.subscriptions[uidStr] ? db.subscriptions[uidStr] : null;
    const mUser = db.moodle_users && db.moodle_users[uidStr] ? db.moodle_users[uidStr] : null;
    const nowTash = new Date(Date.now() + 5 * 3600 * 1000);
    const todayDay = nowTash.getUTCDay();
    const nowSec = Math.floor(Date.now() / 1000);
    const SLOT_TIMES = { 1: "08:30–09:40", 2: "09:55–11:05", 3: "11:20–12:30", 4: "12:45–13:55", 5: "14:30–15:40", 6: "15:55–17:05", 7: "17:20–18:30", 8: "18:45–19:55" };

    const todayEvs = (sub && Array.isArray(sub.cached_events) ? sub.cached_events : [])
      .filter((e) => Number(e.d) === todayDay)
      .sort((a, b) => Number(a.s) - Number(b.s));
    const soonDls = (mUser && Array.isArray(mUser.deadlines) ? mUser.deadlines : [])
      .filter((d) => d.time && d.time > nowSec)
      .slice(0, 5);

    const lines = [
      `✅ <b>Тест уведомлений UWED Helpdesk пройден!</b>`,
      ``,
      `📅 <b>Подписка на расписание:</b> ${sub ? `✅ ${sub.title} (${(sub.cached_events || []).length} пар в кэше)` : "⚠️ Не закреплено (выберите себя в Mini App)"}`,
      `🎓 <b>Moodle:</b> ${mUser && mUser.token ? `✅ ${mUser.fullname || mUser.username}` : "⚠️ Не подключён"}`,
      `⏰ <b>Сводка:</b> ${(mUser && mUser.morning_digest_time) || "07:45"} · <b>О паре за:</b> ${(mUser && mUser.lead_time_mins) || 20} мин`,
    ];
    if (todayEvs.length) {
      lines.push(``, `📚 <b>Пары сегодня:</b>`);
      todayEvs.forEach((e) => lines.push(`• <code>${SLOT_TIMES[e.s] || `${e.s}-пара`}</code> <b>${e.t}</b> (${e.r || "—"})`));
    }
    if (soonDls.length) {
      lines.push(``, `⏳ <b>Ближайшие дедлайны Moodle:</b>`);
      soonDls.forEach((d) => {
        const hrs = Math.max(1, Math.round((d.time - nowSec) / 3600));
        lines.push(`• <b>${d.name}</b> (${d.course || "Moodle"}) — через ~${hrs} ч.`);
      });
    }
    const tgRes = await sendTelegramMessage(uidStr, lines.join("\n"));
    return res.status(200).json({ success: Boolean(tgRes && tgRes.ok), has_sub: Boolean(sub), cached_classes: (sub && sub.cached_events ? sub.cached_events.length : 0), has_moodle: Boolean(mUser && mUser.token) });
  }

  // Proactive background alerts check (classes in 15-30 min, morning digest, Moodle deadlines & grades)
  if (req.query.action === "cron_alerts" || (req.body && req.body.action === "cron_alerts")) {
    const forceRefresh = req.query.force === "1" || Boolean(req.body && req.body.force);
    const snap = await loadSnapshotFromDb();
    const result = await checkAndDispatchAlerts(
      snap,
      (method, payload) => {
        if (method === "sendMessage") {
          return sendTelegramMessage(payload.chat_id, payload.text, payload.reply_markup);
        }
        return Promise.resolve({ ok: true });
      },
      { forceRefresh }
    );
    return res.status(200).json({
      success: true,
      alerts_dispatched: result.count,
      checked_subs: result.checked_subs || 0,
      checked_moodle: result.checked_moodle || 0,
      refreshed_moodle: result.refreshed_moodle || 0,
    });
  }

  // Moodle session & settings sync from Mini App (verifies X-Tg-Init-Data so Bot & Mini App ALWAYS share the same Telegram UID!)
  if (req.query.action === "sync_moodle" || (req.body && req.body.action === "sync_moodle")) {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const initDataHdr = req.headers["x-tg-init-data"] || b.initData || "";
    const verifiedTgUser = verifyTelegramInitData(initDataHdr);
    const rawUser = b.user || {};
    const mergedUser = {
      ...rawUser,
      ...(verifiedTgUser
        ? {
            id: verifiedTgUser.id,
            first_name: verifiedTgUser.first_name || rawUser.first_name || "",
            last_name: verifiedTgUser.last_name || rawUser.last_name || "",
            username: verifiedTgUser.username || rawUser.username || "",
            language_code: verifiedTgUser.language_code || rawUser.language_code || "",
          }
        : {}),
    };
    const uidStr = String(mergedUser.id || "").trim();
    if (!/^\d+$/.test(uidStr)) {
      return res.status(200).json({ success: false, synced: false, error: "telegram_user_required" });
    }
    const moodle = b.moodle || {};
    await recordTelemetry({ user: mergedUser, action: "sync_moodle", detail: moodle.fullname || moodle.username || "prefs", moodle, source: "miniapp" });
    return res.status(200).json({ success: true, synced: true, uid: uidStr });
  }

  // HEMIS summary sync from Mini App to Bot (NEVER stores passwords — only GPA, attendance, exams, contract)
  if (req.query.action === "sync_hemis" || (req.body && req.body.action === "sync_hemis")) {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const initDataHdr = req.headers["x-tg-init-data"] || b.initData || "";
    const verifiedTgUser = verifyTelegramInitData(initDataHdr);
    const rawUser = b.user || {};
    const mergedUser = {
      ...rawUser,
      ...(verifiedTgUser
        ? {
            id: verifiedTgUser.id,
            first_name: verifiedTgUser.first_name || rawUser.first_name || "",
            last_name: verifiedTgUser.last_name || rawUser.last_name || "",
            username: verifiedTgUser.username || rawUser.username || "",
            language_code: verifiedTgUser.language_code || rawUser.language_code || "",
          }
        : {}),
    };
    const uidStr = String(mergedUser.id || "").trim();
    if (!/^\d+$/.test(uidStr)) {
      return res.status(200).json({ success: false, synced: false, error: "telegram_user_required" });
    }
    const hemis = b.hemis || {};
    await recordTelemetry({ user: mergedUser, action: "sync_hemis", detail: hemis.full_name || "hemis", hemis, source: "miniapp" });
    return res.status(200).json({ success: true, synced: true, uid: uidStr });
  }


  // Set / Register Campus Server Relay URL
  if (req.query.action === "set_relay_url" || (req.body && req.body.action === "set_relay_url")) {
    if (!isAuthorizedAdminRequest(req)) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }
    const b = req.body || {};
    const relayUrl = String(b.relay_url || req.query.relay_url || "").trim().replace(/\/+$/, "");
    const db = await loadDb(true);
    db.campus_relay_url = relayUrl;
    db.campus_relay_updated_at = Date.now();
    await saveDb(db, true);
    return res.status(200).json({ success: true, campus_relay_url: relayUrl });
  }

  // Get current Campus Relay URL
  if (req.query.action === "get_relay_url") {
    const db = await loadDb();
    return res.status(200).json({
      success: true,
      campus_relay_url: db.campus_relay_url || null,
      updated_at: db.campus_relay_updated_at || null,
    });
  }

  // Polling endpoint for Campus Agent on Office PC
  if (req.method === "GET" && req.query.action === "check_sync_request") {
    if (!isAuthorizedAdminRequest(req)) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }
    const db = await loadDb();
    const pendingReq = db.pending_sync_request || null;
    return res.status(200).json({
      success: true,
      pending: Boolean(pendingReq),
      requested_at: pendingReq ? pendingReq.requested_at : null,
      last_snapshot_meta: db.campus_snapshot_meta || null,
    });
  }

  // Public safe state for Mini App (crowd-sourced room statuses, campus events & block check)
  if (req.method === "GET" && req.query.action === "public_state") {
    const db = await loadDb(true);
    const initDataHdr = req.headers["x-tg-init-data"] || req.query.initData || "";
    const tgUser = verifyTelegramInitData(initDataHdr);
    const uid = String((tgUser && tgUser.id) || req.query.uid || "");
    const qUid = String(req.query.uid || "");
    const userRecord = (uid && db.users && db.users[uid]) || (qUid && db.users && db.users[qUid]) || null;
    const isAdminUser =
      uid === ADMIN_ID ||
      qUid === ADMIN_ID ||
      (userRecord && String(userRecord.username || "").toLowerCase() === ADMIN_USERNAME) ||
      isAuthorizedAdminRequest(req);
    const isBlocked = Boolean(!isAdminUser && userRecord && userRecord.blocked);

    if (isBlocked) {
      return res.status(200).json({
        success: true,
        is_blocked: true,
        is_admin: false,
        room_reports: {},
        campus_events: [],
        attending_events: [],
      });
    }

    // Auto-refresh tracked Telegram channels every 10 minutes non-blockingly
    if (
      !Array.isArray(db.channel_posts) ||
      db.channel_posts.length === 0 ||
      Date.now() - (db.last_channel_sync_ms || 0) > 10 * 60 * 1000
    ) {
      if (!Array.isArray(db.channel_posts) || db.channel_posts.length === 0) {
        await syncTrackedChannels(db, false);
      } else {
        syncTrackedChannels(db, false).catch(() => {});
      }
    }

    const safeReports = {};
    for (const [rm, rep] of Object.entries(db.room_reports || {})) {
      safeReports[rm] = {
        room: rep.room,
        status: rep.status,
        note: rep.note || "",
        ts: rep.ts,
        updated_ms: rep.updated_ms,
        expires_at: rep.expires_at,
      };
    }
    const manualEvents = (db.campus_events || []).filter((e) => e.approved !== false || isAdminUser);
    const channelPosts = Array.isArray(db.channel_posts) ? db.channel_posts : [];
    const mergedEvents = [...channelPosts, ...manualEvents];

    const myMoodleRaw = (uid && db.moodle_users && db.moodle_users[uid]) || (qUid && db.moodle_users && db.moodle_users[qUid]) || null;
    const myMoodleSafe = myMoodleRaw
      ? {
          connected: Boolean(myMoodleRaw.token),
          username: myMoodleRaw.username || "",
          fullname: myMoodleRaw.fullname || "",
          notify_classes: myMoodleRaw.notify_classes !== false,
          notify_deadlines: myMoodleRaw.notify_deadlines !== false,
          notify_grades: myMoodleRaw.notify_grades !== false,
          morning_digest: myMoodleRaw.morning_digest !== false,
          morning_digest_time: myMoodleRaw.morning_digest_time || "07:45",
          lead_time_mins: Number(myMoodleRaw.lead_time_mins) || 20,
          updated_at: myMoodleRaw.updated_at || null,
        }
      : { connected: false };

    return res.status(200).json({
      success: true,
      maintenance_mode: Boolean(db.maintenance_mode !== false),
      is_blocked: isBlocked,
      is_admin: isAdminUser,
      is_pro: Boolean(userRecord && userRecord.is_pro),
      preferred_lang: userRecord && userRecord.preferred_lang ? userRecord.preferred_lang : null,
      tracked_channels: db.tracked_channels || ["uwed_official"],
      refresh_interval_mins: 10,
      last_channel_sync_ms: db.last_channel_sync_ms || Date.now(),
      room_reports: safeReports,
      campus_events: mergedEvents,
      attending_events: userRecord && Array.isArray(userRecord.attending_events) ? userRecord.attending_events : [],
      my_subscription: uid && db.subscriptions ? db.subscriptions[uid] || null : null,
      my_moodle: myMoodleSafe,
      campus_snapshot_meta: db.campus_snapshot_meta || {
        updated_at: 1793715471368,
        source: "system",
        slots_count: 8,
        rooms_count: 233,
        teachers_count: 546,
      },
    });
  }

  if (req.method === "GET") {
    // Strictly visible ONLY to @bxdxbxy (6906730753). Silent 404 for everyone else.
    if (!isAuthorizedAdminRequest(req)) {
      return res.status(404).end();
    }

    const db = await loadDb(true);
    const usersList = Object.values(db.users || {})
      .filter((u) => String(u.id) !== "12345")
      .sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));

    const moodleUsersSafe = {};
    for (const [mUid, mRec] of Object.entries(db.moodle_users || {})) {
      if (!mRec) continue;
      moodleUsersSafe[mUid] = {
        connected: Boolean(mRec.token),
        username: mRec.username || "",
        fullname: mRec.fullname || "",
        courses_count: Array.isArray(mRec.courses) ? mRec.courses.length : 0,
        deadlines_count: Array.isArray(mRec.deadlines) ? mRec.deadlines.length : 0,
        notify_classes: mRec.notify_classes !== false,
        notify_deadlines: mRec.notify_deadlines !== false,
        notify_grades: mRec.notify_grades !== false,
        updated_at: mRec.updated_at || null,
      };
    }

    return res.status(200).json({
      success: true,
      summary: {
        maintenance_mode: Boolean(db.maintenance_mode !== false),
        total_users: usersList.length,
        blocked_users: usersList.filter((u) => u.blocked).length,
        pro_users: usersList.filter((u) => u.is_pro).length,
        total_events: (db.events || []).length,
        total_feedbacks: (db.feedbacks || []).length,
        active_room_reports: Object.keys(db.room_reports || {}).length,
        total_subscriptions: Object.keys(db.subscriptions || {}).length,
        moodle_connected: Object.values(moodleUsersSafe).filter((m) => m.connected).length,
      },
      users: usersList,
      moodle_users: moodleUsersSafe,
      campus_relay_url: db.campus_relay_url || null,
      campus_relay_updated_at: db.campus_relay_updated_at || null,
      campus_snapshot_meta: db.campus_snapshot_meta || null,
      counters: db.counters || {},
      feedbacks: db.feedbacks || [],
      room_reports: db.room_reports || {},
      subscriptions: db.subscriptions || {},
      tracked_channels: db.tracked_channels || ["uwed_official"],
      channel_posts: db.channel_posts || [],
      campus_events: db.campus_events || [],
      events: (db.events || []).slice(0, 120),
    });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const targetAction = req.query.action || body.action || "";

    // A. Campus Snapshot Sync from Office PC / Campus Agent
    if (targetAction === "sync_snapshot") {
      if (!isAuthorizedAdminRequest(req)) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const snapshot = body.snapshot || body;
      const source = body.source || "office_pc";
      const saved = await saveSnapshotToDb(snapshot, source);
      if (!saved) {
        return res.status(400).json({ success: false, error: "Invalid snapshot data" });
      }

      const db = await loadDb(true);
      db.pending_sync_request = null;
      await saveDb(db, true);

      await recordTelemetry({
        user: { id: ADMIN_ID, username: ADMIN_USERNAME, first_name: "Admin Office PC" },
        action: "campus_snapshot_sync",
        detail: `Synced ${saved.rooms.length} rooms, ${saved.teachers.length} teachers, ${Object.keys(saved.events).length} events from ${source}`,
        source: "campus_agent",
      });

      return res.status(200).json({
        success: true,
        updated_at: saved.updated_at,
        source: saved.source,
        counts: {
          slots: saved.slots.length,
          rooms: saved.rooms.length,
          teachers: saved.teachers.length,
          events: Object.keys(saved.events).length,
        },
      });
    }

    // Remote trigger from Telegram Bot or Mini App: "Синхронизировать сейчас"
    if (targetAction === "request_sync") {
      if (!isAuthorizedAdminRequest(req)) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const db = await loadDb(true);
      db.pending_sync_request = {
        requested_at: Date.now(),
        requested_by: "admin",
      };
      await saveDb(db, true);
      return res.status(200).json({
        success: true,
        message: "Remote sync signal dispatched to campus office PC",
      });
    }

    // B. Crowd-Sourced Student Relay (When students open Mini App on campus Wi-Fi)
    if (targetAction === "relay_sync") {
      const partial = body.data || body;
      if (!partial || typeof partial !== "object") {
        return res.status(400).json({ success: false });
      }
      const db = await loadDb();
      const lastUpdate = (db.campus_snapshot_meta && db.campus_snapshot_meta.updated_at) || 0;
      if (Date.now() - lastUpdate > 45 * 60 * 1000 && (partial.rooms || partial.slots)) {
        const cur = await loadSnapshotFromDb();
        const merged = {
          ...cur,
          updated_at: Date.now(),
          source: "student_campus_relay",
          slots: Array.isArray(partial.slots) && partial.slots.length ? partial.slots : cur.slots,
          rooms: Array.isArray(partial.rooms) && partial.rooms.length ? partial.rooms : cur.rooms,
          teachers: Array.isArray(partial.teachers) && partial.teachers.length ? partial.teachers : cur.teachers,
          events:
            partial.events && typeof partial.events === "object"
              ? { ...cur.events, ...partial.events }
              : cur.events,
        };
        await saveSnapshotToDb(merged, "student_campus_relay");
        return res.status(200).json({ success: true, updated: true });
      }
      return res.status(200).json({ success: true, updated: false, cached: true });
    }

    // 1. Send Daily / Weekly / Monthly Schedule directly inside Telegram Bot (iOS & Android compatible .ics + readable summary!)
    if (body.action === "send_schedule_to_bot") {
      const initDataHdr = req.headers["x-tg-init-data"] || body.initData || "";
      const verifiedTgUser = verifyTelegramInitData(initDataHdr);
      const u = { ...(body.user || {}), ...(verifiedTgUser ? { id: verifiedTgUser.id } : {}) };
      const uid = String(u.id || "").trim();
      if (!/^\d+$/.test(uid)) {
        return res.status(400).json({ success: false, error: "Telegram chat required" });
      }
      const period = ["daily", "weekly", "monthly"].includes(body.period) ? body.period : "weekly";
      const title = String(body.title || "UWED Schedule");
      const baseDateStr = String(body.date || new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10));
      const events = Array.isArray(body.events) ? body.events : [];
      const lang = body.lang || "ru";
      const db = await loadDb();
      const userRec = db.users && db.users[uid] ? db.users[uid] : null;
      const attendingEvents = userRec && Array.isArray(userRec.attending_events) ? userRec.attending_events : [];

      const { ics: icsContent, count: icsCount, summaryLines } = buildScheduleIcs({
        title,
        period,
        baseDateStr,
        events,
        attendingEvents,
      });

      const periodLabel =
        period === "daily"
          ? `📅 ${lang === "uz" ? "Kunlik" : "На день"} (${baseDateStr})`
          : period === "monthly"
          ? `🗓 ${lang === "uz" ? "Oylik (4 hafta)" : "На месяц (4 недели)"}`
          : `📆 ${lang === "uz" ? "Haftalik (Du–Şa)" : "На неделю (Пн–Сб)"}`;

      if (icsCount === 0) {
        const emptyMsg =
          lang === "uz"
            ? `🏛 <b>UWED Helpdesk — ${periodLabel}</b>\n👤 <b>${title}</b>\n\nℹ️ Tanlangan davr uçun darslar topilmadi. Boshqa kunni yoki haftalik jadvalni tanlab kõring.`
            : `🏛 <b>UWED Helpdesk — ${periodLabel}</b>\n👤 <b>${title}</b>\n\nℹ️ На выбранный период занятий не найдено. Выберите другой день или экспорт на неделю.`;
        await sendTelegramMessage(uid, emptyMsg);
        return res.status(200).json({ success: true, empty: true });
      }

      const summaryBlock = summaryLines.length
        ? `\n\n${summaryLines.join("\n")}${icsCount > summaryLines.length ? `\n<i>+${icsCount - summaryLines.length} ещё...</i>` : ""}`
        : "";

      const caption = [
        `🏛 <b>UWED Helpdesk — ${periodLabel}</b>`,
        `👤 <b>${title}</b> (${icsCount} ${lang === "uz" ? "ta dars" : "занятий"})`,
        summaryBlock,
        ``,
        lang === "uz"
          ? `📥 Faylni bosib Apple / Google / Outlook kalendariga qõşing.`
          : `📥 Нажмите на файл <code>.ics</code>, чтобы добавить в Apple / Google / Outlook Календарь.`,
      ].join("\n");

      const tgRes = await sendTelegramDocument(
        uid,
        `uwed_${period}_schedule.ics`,
        icsContent,
        caption
      );

      await recordTelemetry({
        user: u,
        action: "bot_export_schedule",
        detail: `${period}:${title}`,
        source: "miniapp",
      });

      return res.status(200).json({
        success: Boolean(tgRes && tgRes.ok),
        count: icsCount,
      });
    }

    // 2. Toggle Event Attendance ("Notify Me & Add to My Schedule") + Send Bot Reminder Confirmation
    if (body.action === "toggle_event_attendance" && body.event_attendance) {
      const u = body.user || {};
      const uid = String(u.id || "").trim();
      const ev = body.event_attendance;
      const db = await recordTelemetry({
        user: u,
        action: ev.remove ? "unattend_event" : "attend_event",
        detail: ev.title || ev.id,
        source: "miniapp",
        event_attendance: ev,
      });

      if (!ev.remove && /^\d+$/.test(uid)) {
        const msg = [
          `🔔 <b>UWED Helpdesk — Event Added to Your Schedule!</b>`,
          ``,
          `📌 <b>${ev.title}</b>`,
          `📅 Date: <b>${ev.date || "TBA"}</b> · ⏰ <b>${ev.time || "14:00"}</b>`,
          `📍 Location: <b>${ev.location || "UWED"}</b>`,
          `📡 Channel: <b>${ev.channel_name || "@uwed_official"}</b>`,
          ``,
          `✅ <i>This event now appears inside your personal schedule in UWED Helpdesk on ${ev.date || "that day"}!</i>`,
        ].join("\n");
        const kb = ev.tg_link
          ? {
              inline_keyboard: [
                [{ text: "🔗 Exact Post in Telegram", url: String(ev.tg_link) }],
              ],
            }
          : null;
        await sendTelegramMessage(uid, msg, kb);
      }

      const updatedUser = db && db.users && db.users[uid] ? db.users[uid] : null;
      return res.status(200).json({
        success: true,
        attending_events: updatedUser && Array.isArray(updatedUser.attending_events) ? updatedUser.attending_events : [],
      });
    }

    // Admin-only user & channel control actions (strictly locked to @bxdxbxy)
    if (
      body.action === "admin_toggle_maintenance" ||
      body.action === "admin_toggle_block" ||
      body.action === "admin_toggle_pro" ||
      body.action === "admin_send_message" ||
      body.action === "admin_set_note" ||
      body.action === "admin_add_channel" ||
      body.action === "admin_remove_channel" ||
      body.action === "admin_sync_channels"
    ) {
      if (!isAuthorizedAdminRequest(req)) {
        return res.status(404).end();
      }

      if (body.action === "admin_toggle_maintenance") {
        const enabled = Boolean(body.enabled);
        const db = await adminSetMaintenance({ enabled });
        return res.status(200).json({
          success: true,
          maintenance_mode: db.maintenance_mode,
        });
      }

      if (body.action === "admin_add_channel") {
        const db = await adminManageChannels({ action: "add", channel: body.channel });
        return res.status(200).json({
          success: true,
          tracked_channels: db.tracked_channels,
          channel_posts: db.channel_posts || [],
        });
      }

      if (body.action === "admin_remove_channel") {
        const db = await adminManageChannels({ action: "remove", channel: body.channel });
        return res.status(200).json({
          success: true,
          tracked_channels: db.tracked_channels,
          channel_posts: db.channel_posts || [],
        });
      }

      if (body.action === "admin_sync_channels") {
        const db = await adminManageChannels({ action: "sync" });
        return res.status(200).json({
          success: true,
          tracked_channels: db.tracked_channels,
          channel_posts: db.channel_posts || [],
        });
      }

      if (body.action === "admin_toggle_block") {
        const targetUid = String(body.target_uid || "").trim();
        const setBlocked = Boolean(body.blocked);
        const db = await adminControlUser({
          target_uid: targetUid,
          set_blocked: setBlocked,
        });
        return res.status(200).json({
          success: true,
          blocked: setBlocked,
          user: db.users[targetUid] || null,
        });
      }

      if (body.action === "admin_toggle_pro") {
        const targetUid = String(body.target_uid || "").trim();
        const setPro = Boolean(body.is_pro);
        const db = await adminControlUser({
          target_uid: targetUid,
          set_pro: setPro,
        });
        return res.status(200).json({
          success: true,
          is_pro: setPro,
          user: db.users[targetUid] || null,
        });
      }

      if (body.action === "admin_set_note") {
        const targetUid = String(body.target_uid || "").trim();
        const db = await adminControlUser({
          target_uid: targetUid,
          admin_note: String(body.note || ""),
        });
        return res.status(200).json({
          success: true,
          user: db.users[targetUid] || null,
        });
      }

      if (body.action === "admin_send_message") {
        const targetUid = String(body.target_uid || "").trim();
        const text = String(body.text || "").trim();
        if (!text) return res.status(400).json({ success: false, error: "Empty text" });

        if (targetUid === "ALL") {
          const db = await loadDb(true);
          const allTgIds = Object.keys(db.users || {}).filter((id) => /^\d+$/.test(id));
          const tgIds = allTgIds.filter((id) => !(db.users[id] && db.users[id].blocked));
          const skippedBlocked = allTgIds.length - tgIds.length;
          let delivered = 0;
          await Promise.all(
            tgIds.map(async (id) => {
              const r = await sendTelegramMessage(id, `📢 <b>UWED Helpdesk:</b>\n\n${text}`);
              if (r && r.ok) delivered++;
            })
          );
          return res.status(200).json({ success: true, delivered, total: tgIds.length, skipped_blocked: skippedBlocked });
        } else {
          const tgRes = await sendTelegramMessage(
            targetUid,
            `💬 <b>UWED Helpdesk:</b>\n\n${text}`
          );
          await adminControlUser({
            target_uid: targetUid,
            sent_message: text,
          });
          return res.status(200).json({
            success: Boolean(tgRes && tgRes.ok),
            tg_response: tgRes,
          });
        }
      }
    }

    // Strict block check before processing any regular user telemetry/action
    const postInitData = req.headers["x-tg-init-data"] || body.initData || "";
    const postTgUser = verifyTelegramInitData(postInitData);
    const postUid = String((postTgUser && postTgUser.id) || (body.user && body.user.id) || "");
    if (postUid && postUid !== ADMIN_ID) {
      const checkDb = await loadDb();
      if (checkDb && checkDb.users && checkDb.users[postUid] && checkDb.users[postUid].blocked) {
        return res.status(403).json({ success: false, is_blocked: true, error: "Access Restricted" });
      }
    }

    const db = await recordTelemetry({
      user: { ...(body.user || {}), ...(postTgUser ? { id: postTgUser.id, first_name: postTgUser.first_name || (body.user && body.user.first_name) || "", username: postTgUser.username || (body.user && body.user.username) || "" } : {}) },
      action: body.action || "app_event",
      detail: body.detail || "",
      meta: body.meta || {},
      source: body.source || "miniapp",
      feedback: body.feedback || null,
      room_report: body.room_report || null,
      subscription: body.subscription || null,
      campus_event: body.campus_event || null,
      event_attendance: body.event_attendance || null,
      moodle: body.moodle || null,
    });
    return res.status(200).json({
      success: true,
      room_reports: db ? db.room_reports : {},
      campus_events: db
        ? [...(db.channel_posts || []), ...(db.campus_events || []).filter((e) => e.approved !== false)]
        : [],
    });
  }

  return res.status(404).end();
};
module.exports.getAdminSecretKey = getAdminSecretKey;
module.exports.ADMIN_ID = ADMIN_ID;
module.exports.ADMIN_USERNAME = ADMIN_USERNAME;
