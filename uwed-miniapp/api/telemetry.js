const crypto = require("crypto");
const https = require("https");
const {
  loadDb,
  recordTelemetry,
  adminControlUser,
  adminManageChannels,
  syncTrackedChannels,
  adminSetMaintenance,
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

function buildScheduleIcs({ title, period, baseDateStr, events = [], attendingEvents = [] }) {
  const SLOT_TIMES = {
    1: ["090000", "102000"],
    2: ["103000", "115000"],
    3: ["120000", "132000"],
    4: ["140000", "152000"],
    5: ["153000", "165000"],
    6: ["170000", "182000"],
  };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UWED Helpdesk//Schedule Export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:UWED - ${title}`,
    "X-WR-TIMEZONE:Asia/Tashkent",
  ];

  const baseDt = baseDateStr ? new Date(`${baseDateStr}T00:00:00Z`) : new Date(Date.now() + 5 * 3600 * 1000);
  let targetWday = baseDt.getUTCDay();
  if (targetWday === 0) targetWday = 1;
  const diffToMon = targetWday === 0 ? -6 : 1 - targetWday;

  const seen = new Set();
  for (const ev of events) {
    const wday = Number(ev.week_day);
    const sid = Number(ev.slot_id);
    if (!wday || !sid || !SLOT_TIMES[sid]) continue;
    if (period === "daily" && wday !== targetWday) continue;
    const key = `${wday}_${sid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const d = new Date(baseDt);
    d.setUTCDate(baseDt.getUTCDate() + diffToMon + (wday - 1));
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
    const [st, et] = SLOT_TIMES[sid];
    const subj = String(ev.title || ev.lesson_name || "UWED Class").replace(/[\r\n,;]/g, " ");
    const rm = String(ev.room_number || "UWED").replace(/[\r\n,;]/g, " ");
    const desc = [ev.instructor, ev.code, ev.groups].filter(Boolean).join(" | ").replace(/[\r\n,;]/g, " ");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:uwed_${period}_${wday}_${sid}_${ymd}@uwed.uz`);
    lines.push(`DTSTART;TZID=Asia/Tashkent:${ymd}T${st}`);
    lines.push(`DTEND;TZID=Asia/Tashkent:${ymd}T${et}`);
    if (period === "monthly") {
      lines.push("RRULE:FREQ=WEEKLY;COUNT=4");
    }
    lines.push(`SUMMARY:${subj} (${rm})`);
    lines.push(`LOCATION:UWED Room ${rm}`);
    lines.push(`DESCRIPTION:${desc}`);
    lines.push("END:VEVENT");
  }

  // Also include user's registered Campus Events inside the .ics file
  for (const cev of attendingEvents || []) {
    if (!cev || !cev.date) continue;
    if (period === "daily" && baseDateStr && cev.date !== baseDateStr) continue;
    const ymd = String(cev.date).replace(/-/g, "");
    const cleanHm = String(cev.time || "14:00").replace(":", "");
    const st = `${cleanHm.padEnd(4, "0")}00`;
    const hr = Math.min(23, ( parseInt(cleanHm.slice(0, 2), 10) || 14 ) + 1);
    const et = `${String(hr).padStart(2, "0")}${cleanHm.slice(2, 4) || "00"}00`;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:uwed_ev_${cev.id}@uwed.uz`);
    lines.push(`DTSTART;TZID=Asia/Tashkent:${ymd}T${st}`);
    lines.push(`DTEND;TZID=Asia/Tashkent:${ymd}T${et}`);
    lines.push(`SUMMARY:[EVENT] ${String(cev.title || "").replace(/[\r\n,;]/g, " ")}`);
    lines.push(`LOCATION:${String(cev.location || "UWED").replace(/[\r\n,;]/g, " ")}`);
    lines.push(`DESCRIPTION:Telegram Post: ${cev.tg_link || ""}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
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

  // Public safe state for Mini App (crowd-sourced room statuses, campus events & block check)
  if (req.method === "GET" && req.query.action === "public_state") {
    const db = await loadDb();
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
    const uid = String(req.query.uid || "");
    const userRecord = uid && db.users ? db.users[uid] : null;
    const isBlocked = Boolean(userRecord && userRecord.blocked && uid !== ADMIN_ID);
    const isAdminUser =
      uid === ADMIN_ID ||
      (userRecord && String(userRecord.username || "").toLowerCase() === ADMIN_USERNAME) ||
      isAuthorizedAdminRequest(req);

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
      },
      users: usersList,
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

    // 1. Send Daily / Weekly / Monthly Schedule directly inside Telegram Bot (No Vercel links exposed!)
    if (body.action === "send_schedule_to_bot") {
      const u = body.user || {};
      const uid = String(u.id || "").trim();
      if (!/^\d+$/.test(uid)) {
        return res.status(400).json({ success: false, error: "Telegram chat required" });
      }
      const period = ["daily", "weekly", "monthly"].includes(body.period) ? body.period : "weekly";
      const title = String(body.title || "UWED Schedule");
      const baseDateStr = String(body.date || new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10));
      const events = Array.isArray(body.events) ? body.events : [];
      const db = await loadDb();
      const userRec = db.users && db.users[uid] ? db.users[uid] : null;
      const attendingEvents = userRec && Array.isArray(userRec.attending_events) ? userRec.attending_events : [];

      const icsContent = buildScheduleIcs({
        title,
        period,
        baseDateStr,
        events,
        attendingEvents,
      });

      const periodLabel =
        period === "daily"
          ? `📅 Daily (${baseDateStr})`
          : period === "monthly"
          ? "🗓 Monthly (4 Weeks)"
          : "📆 Weekly (Mon–Sat)";

      const caption = [
        `🏛 <b>UWED Helpdesk — ${periodLabel}</b>`,
        `👤 <b>${title}</b>`,
        ``,
        `📥 Tap the attached <code>.ics</code> file above to add directly to Apple / Google / Outlook Calendar.`,
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
          const tgIds = Object.keys(db.users || {}).filter((id) => /^\d+$/.test(id));
          let delivered = 0;
          await Promise.all(
            tgIds.map(async (id) => {
              const r = await sendTelegramMessage(id, `📢 <b>UWED Helpdesk:</b>\n\n${text}`);
              if (r && r.ok) delivered++;
            })
          );
          return res.status(200).json({ success: true, delivered, total: tgIds.length });
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

    const db = await recordTelemetry({
      user: body.user || {},
      action: body.action || "app_event",
      detail: body.detail || "",
      meta: body.meta || {},
      source: body.source || "miniapp",
      feedback: body.feedback || null,
      room_report: body.room_report || null,
      subscription: body.subscription || null,
      campus_event: body.campus_event || null,
      event_attendance: body.event_attendance || null,
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
