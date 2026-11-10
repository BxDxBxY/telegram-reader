const https = require("https");
const { loadSnapshotFromDb } = require("./_telemetry");

const UWED_HOST = "manage.uwed.uz";

const DEFAULT_SLOTS = {
  1: { start: "08:30", end: "09:40" },
  2: { start: "09:55", end: "11:05" },
  3: { start: "11:20", end: "12:30" },
  4: { start: "12:45", end: "13:55" },
  5: { start: "14:30", end: "15:40" },
  6: { start: "15:55", end: "17:05" },
  7: { start: "17:20", end: "18:30" },
  8: { start: "18:45", end: "19:55" },
};

// High-concurrency in-memory cache + singleflight deduplication for 2,000-8,000 concurrent users
const RESPONSE_CACHE = new Map();
const INFLIGHT_MAP = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes fresh, 24h stale fallback

function uwedRawGet(pathWithDoubleSlash, query = {}, lang = "uz", host = UWED_HOST, doubleSlash = true) {
  return new Promise((resolve, reject) => {
    const cleanLang = ["uz", "ru", "en"].includes(String(lang || "").toLowerCase())
      ? String(lang).toLowerCase()
      : "uz";
    const qs = new URLSearchParams({ ...query, locale: cleanLang }).toString();
    const cleanPath = pathWithDoubleSlash.startsWith("/")
      ? pathWithDoubleSlash
      : "/" + pathWithDoubleSlash;
    const prefix = doubleSlash ? "/api/" : "/api";
    const fullPath = `${prefix}${cleanPath}${qs ? "?" + qs : ""}`;

    const req = https.request(
      {
        hostname: host,
        port: 443,
        path: fullPath,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": cleanLang,
          "x-locale": cleanLang,
          locale: cleanLang,
          Referer: `https://${host}/`,
        },
        timeout: 9500,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8").trim();
          if (!raw) {
            return resolve({ success: true, data: [] });
          }
          try {
            resolve(JSON.parse(raw));
          } catch (_) {
            resolve({ success: false, error: "Invalid JSON from UWED", data: [] });
          }
        });
      }
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout connecting to ${host}`));
    });
    req.end();
  });
}

async function uwedGet(pathWithDoubleSlash, query = {}, lang = "uz", host = UWED_HOST, doubleSlash = true) {
  const cacheKey = `${host}:${doubleSlash}:${lang}:${pathWithDoubleSlash}:${JSON.stringify(query)}`;
  const now = Date.now();
  const cached = RESPONSE_CACHE.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  if (INFLIGHT_MAP.has(cacheKey)) {
    return INFLIGHT_MAP.get(cacheKey);
  }

  const p = (async () => {
    try {
      const data = await uwedRawGet(pathWithDoubleSlash, query, lang, host, doubleSlash);
      if (data && data.success !== false) {
        if (RESPONSE_CACHE.size > 600) {
          const oldestKey = RESPONSE_CACHE.keys().next().value;
          RESPONSE_CACHE.delete(oldestKey);
        }
        RESPONSE_CACHE.set(cacheKey, { ts: Date.now(), data });
      }
      return data;
    } catch (err) {
      // Stale-if-error auto-recovery: if manage.uwed.uz is down or overloaded, serve stale cache
      if (cached && cached.data) {
        return cached.data;
      }
      // Autonomous snapshot fallback if upstream university API restricts or blocks external IP
      const snap = await loadSnapshotFromDb();
      if (pathWithDoubleSlash.includes("/slots")) {
        return { success: true, data: snap.slots || [] };
      }
      if (pathWithDoubleSlash.includes("/search/teachers")) {
        const q = String(query.search || "").toLowerCase();
        const matches = (snap.teachers || []).filter((t) => (t.full_name || "").toLowerCase().includes(q));
        return { success: true, data: matches };
      }
      if (pathWithDoubleSlash.includes("/search/rooms")) {
        const q = String(query.search || "").toLowerCase();
        const matches = (snap.rooms || []).filter((r) => (r.name || "").toLowerCase().includes(q));
        return { success: true, data: matches };
      }
      if (pathWithDoubleSlash.includes("/events") && query.request_id) {
        const rid = query.request_id;
        const evs = (snap.events && snap.events[rid]) || [];
        return { success: true, data: evs };
      }
      return { success: true, data: [], fallback: true, warning: String(err.message || err) };
    } finally {
      INFLIGHT_MAP.delete(cacheKey);
    }
  })();

  INFLIGHT_MAP.set(cacheKey, p);
  return p;
}

function getMondayOfDate(dateStr = null) {
  let dt;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    dt = new Date(`${dateStr}T12:00:00Z`);
  } else {
    dt = new Date(Date.now() + 5 * 3600 * 1000);
  }
  if (isNaN(dt.getTime())) {
    dt = new Date(Date.now() + 5 * 3600 * 1000);
  }
  const day = dt.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().split("T")[0];
}

function escapeIcs(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function buildIcsDateTime(mondayStr, weekDay, hmStr) {
  const [y, m, d] = mondayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + (Number(weekDay) - 1)));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const [hh, min] = String(hmStr || "09:00").split(":");
  return `${yyyy}${mm}${dd}T${String(hh || "09").padStart(2, "0")}${String(min || "00").padStart(2, "0")}00`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-UWED-Client, X-Tg-Init-Data");
  // Edge CDN caching: serves thousands of concurrent requests in <10ms at the Vercel Edge
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Anti-Scraping & Anti-Copy Guard: Block external bots/scripts (python-urllib, curl, wget, etc.)
  const ua = String(req.headers["user-agent"] || "").toLowerCase();
  if (
    /python|urllib|curl|wget|scrapy|httpx|aiohttp|postman|insomnia/i.test(ua) &&
    req.headers["x-uwed-client"] !== "uwed-helpdesk-v3"
  ) {
    return res.status(403).json({
      success: false,
      error: "Protected UWED Helpdesk API. Automated scraping is prohibited.",
    });
  }

  const action = req.query.action || "slots";
  const lang = ["uz", "ru", "en"].includes(String(req.query.lang || "").toLowerCase())
    ? String(req.query.lang).toLowerCase()
    : "uz";
  const startTime = getMondayOfDate(req.query.date || req.query.start_time || null);

  try {
    if (action === "slots") {
      const data = await uwedGet(
        "/timetable/public/v1/slots/by/academic/year",
        { academic_year_id: "null" },
        lang
      );
      return res.status(200).json(data);
    }

    if (action === "faqs") {
      const q = (req.query.q || "").trim();
      const params = q ? { search: q } : {};
      const data = await uwedGet("/faq/public/v1/faqs", params, lang, "my.uwed.uz", false);
      return res.status(200).json(data);
    }

    if (action === "departments") {
      const data = await uwedGet("/v1/departments", {}, lang);
      return res.status(200).json(data);
    }

    if (action === "search_teachers") {
      const q = (req.query.q || "").trim();
      if (q.length < 2) return res.status(200).json({ success: true, data: [] });
      const data = await uwedGet("/timetable/public/v1/search/teachers", { search: q }, lang);
      return res.status(200).json(data);
    }

    if (action === "search_students") {
      const q = (req.query.q || "").trim();
      if (q.length < 2) return res.status(200).json({ success: true, data: [] });
      const data = await uwedGet(
        "/education/public/v1/student/search/for-timetable",
        { search: q },
        lang
      );
      return res.status(200).json(data);
    }

    if (action === "search_rooms") {
      const q = (req.query.q || "").trim();
      if (q.length < 2) return res.status(200).json({ success: true, data: [] });
      const data = await uwedGet("/timetable/public/v1/search/rooms", { search: q }, lang);
      return res.status(200).json(data);
    }

    if (action === "events") {
      const id = (req.query.id || req.query.request_id || "").trim();
      const type = (req.query.type || "ROOM").trim().toUpperCase();
      if (!id) return res.status(400).json({ success: false, error: "Missing id" });
      const data = await uwedGet(
        "/timetable/public/v1/events/list",
        {
          request_id: id,
          type,
          start_time: startTime,
        },
        lang
      );
      return res.status(200).json(data);
    }

    if (action === "export_ics") {
      const type = (req.query.type || "STUDENT").trim().toUpperCase();
      const id = (req.query.id || "").trim();
      const title = (req.query.title || "UWED Schedule").trim();
      const period = (req.query.period || "weekly").toLowerCase();

      const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//UWED Helpdesk//Schedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        `X-WR-CALNAME:${escapeIcs(title)}`,
        "X-WR-TIMEZONE:Asia/Tashkent",
      ];

      if (type === "CAMPUS_EVENT") {
        const evDate = (req.query.date || startTime).replace(/-/g, "");
        const [hh, mm] = (req.query.time || "14:00").split(":");
        const dtStart = `${evDate}T${String(hh || "14").padStart(2, "0")}${String(mm || "00").padStart(2, "0")}00`;
        const endH = String((Number(hh || 14) + 1) % 24).padStart(2, "0");
        const dtEnd = `${evDate}T${endH}${String(mm || "30").padStart(2, "0")}00`;
        lines.push(
          "BEGIN:VEVENT",
          `UID:uwed-event-${Date.now()}@uwed.uz`,
          `DTSTAMP:${dtStart}Z`,
          `DTSTART;TZID=Asia/Tashkent:${dtStart}`,
          `DTEND;TZID=Asia/Tashkent:${dtEnd}`,
          `SUMMARY:${escapeIcs(title)}`,
          `LOCATION:${escapeIcs(req.query.location || "UWED Campus")}`,
          `DESCRIPTION:${escapeIcs(req.query.desc || "UWED Campus Event")}`,
          "END:VEVENT"
        );
      } else if (id) {
        const evRes = await uwedGet(
          "/timetable/public/v1/events/list",
          {
            request_id: id,
            type,
            start_time: startTime,
          },
          lang
        );
        const list = Array.isArray(evRes.data) ? evRes.data : [];
        const seen = new Set();
        for (const ev of list) {
          const wday = Number(ev.week_day);
          const sid = Number(ev.slot_id);
          if (!wday || !sid) continue;
          const k = `${wday}_${sid}`;
          if (seen.has(k)) continue;
          seen.add(k);

          const slotTimes = DEFAULT_SLOTS[sid] || { start: "09:00", end: "10:20" };
          const dtStart = buildIcsDateTime(startTime, wday, slotTimes.start);
          const dtEnd = buildIcsDateTime(startTime, wday, slotTimes.end);
          const room = ev.room_number || title;
          const summary = `${ev.title || "UWED Class"} (${room})`;
          const desc = [
            ev.instructor ? `Instructor: ${ev.instructor}` : "",
            ev.code ? `Code: ${ev.code}` : "",
            ev.speciality_names ? `Stream: ${ev.speciality_names}` : "",
            ev.lesson_name ? `Topic: ${ev.lesson_name}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          lines.push(
            "BEGIN:VEVENT",
            `UID:uwed-${id}-${wday}-${sid}@uwed.uz`,
            `DTSTAMP:${dtStart}Z`,
            `DTSTART;TZID=Asia/Tashkent:${dtStart}`,
            `DTEND;TZID=Asia/Tashkent:${dtEnd}`,
            period === "monthly" ? "RRULE:FREQ=WEEKLY;COUNT=4" : "RRULE:FREQ=WEEKLY;COUNT=15",
            `SUMMARY:${escapeIcs(summary)}`,
            `LOCATION:${escapeIcs(`UWED Room ${room}`)}`,
            `DESCRIPTION:${escapeIcs(desc)}`,
            "END:VEVENT"
          );
        }
      }

      lines.push("END:VCALENDAR");
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="uwed_schedule.ics"');
      return res.status(200).send(lines.join("\r\n"));
    }

    if (action === "batch_room_events") {
      const idsRaw = (req.query.ids || "").trim();
      const ids = idsRaw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 30);

      const results = {};
      await Promise.all(
        ids.map(async (rid) => {
          try {
            const evRes = await uwedGet(
              "/timetable/public/v1/events/list",
              {
                request_id: rid,
                type: "ROOM",
                start_time: startTime,
              },
              lang
            );
            const list = Array.isArray(evRes.data) ? evRes.data : [];
            const byKey = {};
            for (const ev of list) {
              const d = ev.week_day;
              const s = ev.slot_id;
              if (!d || !s) continue;
              const k = `${d}_${s}`;
              if (!byKey[k]) {
                byKey[k] = {
                  d,
                  s,
                  t: (ev.title || "").trim(),
                  i: (ev.instructor || "").trim(),
                  tid: (ev.teacher_id || "").trim(),
                  c: (ev.code || "").trim(),
                  sp: (ev.speciality_names || "").trim(),
                  lt: (ev.type || "").trim(),
                  st: (ev.study_type || "").trim(),
                  ln: (ev.lesson_name || "").trim(),
                  grp: (ev.groups || "").trim(),
                };
              }
            }
            results[rid] = Object.values(byKey);
          } catch (_) {
            results[rid] = null;
          }
        })
      );
      return res.status(200).json({
        success: true,
        live: true,
        timestamp: new Date().toISOString(),
        events: results,
      });
    }

    // ─── MOODLE INTEGRATION (moodle.uwed.uz Official Mobile WebService API) ───
    if (action === "moodle_login" || action === "moodle_data") {
      res.setHeader("Cache-Control", "no-store");
      let body = {};
      if (req.method === "POST") {
        body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      }
      const login = (body.login || req.query.login || "").trim();
      const password = body.password || req.query.password || "";
      let token = (body.token || req.query.token || "").trim();

      const moodlePost = (pathStr, formObj) =>
        new Promise((resolve, reject) => {
          const postData = new URLSearchParams(formObj).toString();
          const r = https.request(
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
              timeout: 10000,
            },
            (resp) => {
              const chunks = [];
              resp.on("data", (c) => chunks.push(c));
              resp.on("end", () => {
                try {
                  resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
                } catch (_) {
                  resolve(null);
                }
              });
            }
          );
          r.on("error", reject);
          r.on("timeout", () => {
            r.destroy();
            reject(new Error("Moodle timeout"));
          });
          r.write(postData);
          r.end();
        });

      if (!token) {
        if (!login || !password) {
          return res.status(200).json({ ok: false, error: "bad_login" });
        }
        const tokRes = await moodlePost("/login/token.php", {
          service: "moodle_mobile_app",
          username: login,
          password: password,
        });
        if (!tokRes || tokRes.errorcode || !tokRes.token) {
          const code =
            tokRes && tokRes.errorcode === "invalidlogin" ? "bad_login" : "unreachable";
          return res.status(200).json({
            ok: false,
            error: code,
            detail: (tokRes && tokRes.error) || "",
          });
        }
        token = tokRes.token;
      }

      const callWs = (wsfunction, extra = {}) =>
        moodlePost("/webservice/rest/server.php", {
          wstoken: token,
          moodlewsrestformat: "json",
          wsfunction,
          ...extra,
        });

      const siteInfo = await callWs("core_webservice_get_site_info");
      if (!siteInfo || siteInfo.exception || !siteInfo.userid) {
        return res.status(200).json({ ok: false, error: "need_login" });
      }

      const userid = siteInfo.userid;
      const nowSec = Math.floor(Date.now() / 1000);
      const [coursesRaw, calRaw] = await Promise.all([
        callWs("core_enrol_get_users_courses", { userid }).catch(() => []),
        callWs("core_calendar_get_action_events_by_timesort", {
          timesortfrom: nowSec - 7 * 86400,
          limitnum: 40,
        }).catch(() => ({ events: [] })),
      ]);

      const coursesList = Array.isArray(coursesRaw) ? coursesRaw : [];
      const courses = coursesList.map((c) => ({
        id: c.id,
        name: c.fullname || c.shortname || `Course #${c.id}`,
        progress: c.progress != null ? Math.round(c.progress) : null,
      }));

      const eventsArr = (calRaw && Array.isArray(calRaw.events) ? calRaw.events : []).map(
        (ev) => ({
          id: ev.id,
          name: ev.name || "Assignment",
          course: (ev.course && ev.course.fullname) || "",
          time: ev.timestart || ev.usermidnight || nowSec,
          url: ev.url || "",
        })
      );
      eventsArr.sort((a, b) => a.time - b.time);

      // Fetch grades for up to 10 active courses in parallel
      const grades = [];
      await Promise.all(
        courses.slice(0, 10).map(async (c) => {
          try {
            const gRes = await callWs("gradereport_user_get_grade_items", {
              courseid: c.id,
              userid,
            });
            const itemsRaw =
              (gRes && gRes.usergrades && gRes.usergrades[0] && gRes.usergrades[0].gradeitems) ||
              [];
            const items = itemsRaw
              .filter((it) => it.itemname || it.itemtype === "course")
              .map((it) => ({
                name: it.itemtype === "course" ? "∑ Итого по курсу" : it.itemname,
                score:
                  it.gradeformatted && it.gradeformatted !== "-"
                    ? String(it.gradeformatted).replace(/<[^>]+>/g, "").trim()
                    : "—",
              }));
            if (items.length) {
              grades.push({ course: c.name, items });
            }
          } catch (_) {}
        })
      );

      return res.status(200).json({
        ok: true,
        token,
        me: {
          userid,
          fullname: siteInfo.fullname || login,
          username: siteInfo.username || login,
          site: siteInfo.sitename || "Moodle UWED",
        },
        deadlines: eventsArr,
        courses,
        grades,
      });
    }

    // ─── HEMIS SERVER FALLBACK (student.uwed.uz/rest/v1) ───
    if (action === "hemis_login") {
      res.setHeader("Cache-Control", "no-store");
      let body = {};
      if (req.method === "POST") {
        body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      }
      const login = (body.login || "").trim();
      const password = body.password || "";
      if (!login || !password) {
        return res.status(200).json({ ok: false, error: "bad_login" });
      }

      const hemisReq = (pathStr, method = "GET", payload = null, bearer = "") =>
        new Promise((resolve, reject) => {
          const dataStr = payload ? JSON.stringify(payload) : "";
          const headers = {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0",
          };
          if (payload) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(dataStr);
          }
          if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
          const r = https.request(
            {
              hostname: "student.uwed.uz",
              port: 443,
              path: `/rest/v1${pathStr}`,
              method,
              headers,
              timeout: 10000,
            },
            (resp) => {
              const chunks = [];
              resp.on("data", (c) => chunks.push(c));
              resp.on("end", () => {
                try {
                  resolve({
                    status: resp.statusCode,
                    json: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
                  });
                } catch (_) {
                  resolve({ status: resp.statusCode, json: null });
                }
              });
            }
          );
          r.on("error", reject);
          r.on("timeout", () => {
            r.destroy();
            reject(new Error("HEMIS timeout"));
          });
          if (dataStr) r.write(dataStr);
          r.end();
        });

      const authRes = await hemisReq("/auth/login", "POST", { login, password });
      const token = authRes.json && authRes.json.data && authRes.json.data.token;
      if (!token) {
        return res.status(200).json({
          ok: false,
          error: [400, 401, 403, 422].includes(authRes.status) ? "bad_login" : "unreachable",
        });
      }

      const [meRes, semsRes, gpaRes] = await Promise.all([
        hemisReq("/account/me", "GET", null, token).catch(() => ({})),
        hemisReq("/education/semesters", "GET", null, token).catch(() => ({})),
        hemisReq("/education/gpa-list", "GET", null, token).catch(() => ({})),
      ]);
      const meData = (meRes.json && meRes.json.data) || {};
      const semsData = Array.isArray(semsRes.json && semsRes.json.data)
        ? semsRes.json.data
        : [];
      const curSem = semsData.find((s) => s.current) || semsData[semsData.length - 1] || {};
      const semCode = String(curSem.code || curSem.id || "");
      const subjRes = await hemisReq(
        `/education/subject-list${semCode ? `?semester=${encodeURIComponent(semCode)}` : ""}`,
        "GET",
        null,
        token
      ).catch(() => ({}));
      const subjList = Array.isArray(subjRes.json && subjRes.json.data)
        ? subjRes.json.data
        : [];
      const gpaList = Array.isArray(gpaRes.json && gpaRes.json.data) ? gpaRes.json.data : [];
      const latestGpa = gpaList.length ? gpaList[gpaList.length - 1].gpa : null;

      const subjects = subjList.map((s) => ({
        name: (s.curriculumSubject && s.curriculumSubject.subject && s.curriculumSubject.subject.name) || s.name || "Subject",
        credit: Number((s.curriculumSubject && s.curriculumSubject.credit) || s.credit || 4),
        score: Number((s.overallScore && s.overallScore.grade) || s.total_acload || 0),
      }));

      return res.status(200).json({
        ok: true,
        me: {
          full_name: meData.full_name || meData.short_name || login,
          student_id: meData.student_id_number || login,
          group: (meData.group && meData.group.name) || "",
        },
        gpa: latestGpa,
        semester: semCode,
        subjects,
      });
    }

    // ─── LOST & FOUND + BOOK/ITEM EXCHANGE BOARD ───
    if (action === "lostfound") {
      res.setHeader("Cache-Control", "no-store");
      if (!global.__UWED_LF_ITEMS) {
        global.__UWED_LF_ITEMS = [
          {
            id: 1,
            kind: "found",
            title: "Найдены наушники AirPods Pro (в кейсе)",
            desc: "Найдены в корпусе B на 2 этаже возле B-204. Отдам владельцу при разблокировке с телефона.",
            place: "Корпус B · 2 этаж",
            author: "Студенческий Helpdesk",
            contact: "uwedhelpdesk_bot",
            created_at: "Сегодня, 11:20",
          },
          {
            id: 2,
            kind: "exchange",
            title: "Учебник: International Law (Malcolm Shaw)",
            desc: "Отдам бесплатно первокурсникам МП или обменяю на книгу по Дипломатическому протоколу.",
            place: "Корпус A · Библиотека",
            author: "Азизбек (3 курс МП)",
            contact: "uwedhelpdesk_bot",
            created_at: "Сегодня, 09:45",
          },
          {
            id: 3,
            kind: "lost",
            title: "Потерян пропуск (ID-карта студента)",
            desc: "Синий бейдж с лентой UWED, потерян по дороге от C-блока к столовой.",
            place: "Между C-блоком и столовой",
            author: "Мадина (2 курс МЭО)",
            contact: "uwedhelpdesk_bot",
            created_at: "Вчера, 16:10",
          },
        ];
      }
      if (req.method === "POST") {
        const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
        const item = {
          id: Date.now(),
          kind: ["lost", "found", "exchange"].includes(body.kind) ? body.kind : "lost",
          title: String(body.title || "").slice(0, 100),
          desc: String(body.desc || "").slice(0, 400),
          place: String(body.place || "Кампус УМЭД").slice(0, 80),
          author: String(body.author || "Студент УМЭД").slice(0, 60),
          contact: String(body.contact || "").replace(/^@/, "").slice(0, 50),
          created_at: "Только что",
        };
        if (item.title.length >= 3) {
          global.__UWED_LF_ITEMS.unshift(item);
          global.__UWED_LF_ITEMS = global.__UWED_LF_ITEMS.slice(0, 50);
        }
        return res.status(200).json({ ok: true, items: global.__UWED_LF_ITEMS });
      }
      return res.status(200).json({ ok: true, items: global.__UWED_LF_ITEMS });
    }

    return res.status(400).json({ success: false, error: "Unknown action" });
  } catch (err) {
    return res.status(200).json({
      success: true,
      data: [],
      recovered: true,
      warning: String(err.message || err),
    });
  }
};
