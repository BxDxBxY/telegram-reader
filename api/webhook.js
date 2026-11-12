function cyrToLat(str) {
  if (!str) return "";
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
    ў: "o'", ғ: "g'", ҳ: "h", қ: "q",
  };
  return String(str).toLowerCase().split("").map((c) => map[c] || c).join("");
}

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
  checkAndDispatchAlerts,
} = require("./_telemetry");
const { getAdminSecretKey, ADMIN_ID, ADMIN_USERNAME } = require("./telemetry");

const BOT_TOKEN =
  process.env.UWED_HELPDESK_TOKEN || "9214404778:AAE45Ty8GF45qKluBfFkuOpQxGiih42nYeE";
const UWED_HOST = "manage.uwed.uz";

const BLOCK_FLOORS = {
  A: [1, 2, 3, 4],
  B: [1, 2, 3, 4, 5, 6, 7],
  D: [1, 2, 3, 4],
};
const CLASSROOM_TYPES = new Set(["PRACTICE", "LECTURE", "LANGUAGE_LAB", "COMPUTER"]);
const SNAPSHOT = require("../public/snapshot.json");

function isAdminUser(from) {
  if (!from) return false;
  return (
    String(from.id) === ADMIN_ID ||
    String(from.username || "").toLowerCase() === ADMIN_USERNAME ||
    String(from.id) === "6906730753" ||
    String(from.username || "").toLowerCase() === "bxdxbxy"
  );
}

function getMaintenanceMessage(lang = "uz") {
  if (lang === "ru") {
    return (
      `🛠 <b>UWED Helpdesk • Технические работы</b>\n\n` +
      `Уважаемые студенты и пользователи!\n\n` +
      `В настоящий момент на серверах сервиса проводятся <b>плановые технические работы и обновление системы</b>.\n` +
      `В связи с этим бот временно приостановил ответы на запросы.\n\n` +
      `⏳ Совсем скоро бот вернётся в полноценный режим работы с обновлёнными функциями.\n` +
      `<i>Приносим извинения за временные неудобства и благодарим за понимание!</i>\n\n` +
      `⚡️ <b>Служба технической поддержки UWED Helpdesk</b>`
    );
  }
  if (lang === "en") {
    return (
      `🛠 <b>UWED Helpdesk • Scheduled Maintenance</b>\n\n` +
      `Dear students and users!\n\n` +
      `We are currently performing <b>scheduled system maintenance and upgrades</b>.\n` +
      `During this period, bot responses are temporarily paused.\n\n` +
      `⏳ The service will resume shortly with enhanced features.\n` +
      `<i>We apologize for any inconvenience and appreciate your patience!</i>\n\n` +
      `⚡️ <b>UWED Helpdesk Operations</b>`
    );
  }
  return (
    `🛠 <b>UWED Helpdesk • Texnik profilaktika</b>\n\n` +
    `Hurmatli talabalar va foydalanuvçilar!\n\n` +
    `Hozirda servis serverlarida <b>rejaviy texnik sozlaş hamda tizimni yangilaş ishlari</b> olib borilmoqda.\n` +
    `Şu sababli bot faoliyati vaqtinça çeklangan.\n\n` +
    `⏳ Tez orada yangilangan imkoniyatlar bilan to‘liq formatda qayta işga tuşiriladi.\n` +
    `<i>Keltirilgan vaqtinçalik noqulayliklar uçun uzr sõraymiz va sabringiz uçun rahmat!</i>\n\n` +
    `⚡️ <b>UWED Helpdesk Texnik Xizmati</b>`
  );
}

function toNewUz(str, lang = "uz") {
  if (!str || lang !== "uz") return str;
  return String(str)
    .replace(/O['‘ʻʼ`]/g, "Õ")
    .replace(/o['‘ʻʼ`]/g, "õ")
    .replace(/G['‘ʻʼ`]/g, "Ğ")
    .replace(/g['‘ʻʼ`]/g, "ğ")
    .replace(/Sh/g, "Ş")
    .replace(/SH/g, "Ş")
    .replace(/sh/g, "ş")
    .replace(/Ch/g, "Ç")
    .replace(/CH/g, "Ç")
    .replace(/ch/g, "ç")
    .replace(/Ꞑ/g, "NG")
    .replace(/ꞑ/g, "ng");
}

const L10N = {
  uz: {
    openApp: "📱 UWED Helpdesk (Mini App)",
    findRoomsBtn: "🟢 Bõş xonalarni topiş",
    eventsBtn: "🗓 Tadbirlar (Events)",
    overlapBtn: "🤝 Umumiy bõş vaqt",
    mySchedBtn: "🔔 Mening jadvalim",
    teacherBtn: "👨‍🏫 Õqituvçi",
    studentBtn: "🎓 Talaba",
    helpBtn: "ℹ️ Yordam",
    shareContactBtn: "📞 Kontakt ulasiş",
    feedbackBtn: "💬 Taklif va Fikr",
    homeTitle: "✨ <b>UWED Helpdesk • JIDU</b>",
    homeStats: (freeTotal, aFree, bFree, dFree) =>
      `🟢 Hozir universitetda <b>${freeTotal} ta bõş auditoriya</b> bor:\n` +
      `   <code>A blok: ${aFree}</code>  ·  <code>B blok: ${bFree}</code>  ·  <code>D blok: ${dFree}</code>`,
    homeHint: "👇 <i>Kerakli bõlimni tanlang yoki xona / ustoz / talaba ID raqamini yozing:</i>",
    helpText:
      `ℹ️ <b>Qisqa qõllanma (UWED Helpdesk):</b>\n\n` +
      `1️⃣ <b>Mini App</b> — «📱 UWED Helpdesk» tugmasini bosing (xonalar, ustoz radari, umumiy oyna, tadbirlar).\n` +
      `2️⃣ <b>Bõş xona</b> — «🟢 Bõş xonalarni topiş» tugmasidan A, B yoki D blokni tanlang.\n` +
      `3️⃣ <b>Tezkor qidiruv</b> — Çatga xona (<code>B-705</code>), õqituvçi (<code>Abdunabiev</code>) yoki talaba ID (<code>3502311...</code>) yozing.\n` +
      `4️⃣ <b>Buyruqlar</b> — /events (Tadbirlar), /my (Mening jadvalim), <code>!fikr matn</code> (Fikr qoldiriş).`,
    pickBlockTitle: "🏢 <b>Qaysi õquv binosini kõramiz?</b>\n<i>Blokni tanlang:</i>",
    bestPicksHdr: "🔥 <b>ENG QULAY (kun oxirigaça bõş):</b>",
    floorHdr: (fl, freeCnt, total) => `🪜 <b>${fl}-QAVAT</b>  ·  🟢 <b>${freeCnt}</b> / ${total} bõş`,
    blockViewTitle: (b, flTitle) => `🏢 <b>${b} BLOK  ·  ${flTitle}</b>`,
    allFloorsRange: (maxFl) => `1–${maxFl} qavatlar`,
    floorNum: (fl) => `${fl}-qavat`,
    freeBusyCount: (f, b) => `🟢 Bõş: <b>${f}</b>   🔴 Band: <b>${b}</b>`,
    freeRoomsHdr: (n) => `🟢 <b>BÕŞ XONALAR (${n}):</b>`,
    busyRoomsHdr: (n) => `🔴 <b>BAND XONALAR (${n}):</b>`,
    noFreeOnFloor: "Bõş õquv xonalari yõq",
    seats: "õrin",
    freeAllDay: "Kun bõyi bõş",
    freeEndDay: "Kun oxirigaça",
    freeUntil: (t, n) => `${t} gaça (${n} j.)`,
    allFlBtn: "Barça qav.",
    nowBtn: "⚡ Hozir",
    backHomeBtn: "← Asosiy menyu",
    backBlockBtn: "← Bloklar",
    pairWord: (id) => `${id}-juftlik`,
    pairShort: (id, t) => `${id}-j (${t})`,
    roomTitle: (name, b, fl) => `🚪 <b>Auditoriya <code>${name}</code></b> (${b} blok, ${fl}-qavat)`,
    freeCaps: "BÕŞ",
    ongoing: (id, st, et) => `Hozir ${id}-juftlik (${st}–${et})`,
    next: (id, st, et) => `Keyingi: ${id}-juftlik (${st}–${et})`,
    ended: (d, st) => `Darslar tugadi • ${d}, 1-juftlik (${st})`,
    notFound: (q) => `😕 «<b>${q}</b>» topilmadi.\nMisol: <code>B-705</code>, <code>Abdunabiev</code> yoki <code>3502311...</code>`,
    searchResults: (q) => `🔎 «<b>${q}</b>» bõyiça natijalar (ustiga bosing):`,
    teacherPrompt: "👨‍🏫 <b>Õqituvçi radari va qidiruvi</b>\n\nÕqituvçining familiyasi yoki ismini çatga yozing (masalan: <code>Abdunabiev</code>, <code>Nosirov</code>):",
    studentPrompt: "🎓 <b>Talaba jadvali</b>\n\nTalaba HEMIS ID raqamini çatga yozing (masalan: <code>350231100133</code>):",
    studentWord: "Talaba",
    teacherWord: "Õqituvçi",
    contactSaved: "✅ Rahmat! Telefon raqamingiz saqlandi.",
    feedbackPrompt:
      "💬 <b>Taklif va Fikr-mulohaza</b>\n\nXabaringizni <code>!fikr ...</code> kõrinişida yozing yoki Mini App içidagi <b>Fikrlar</b> bõlimidan yuboring!",
    feedbackSaved: "✅ Rahmat! Fikringiz saqlandi.",
    radarBusy: (slot, et, rm, subj) => `📍 <b>HOZIR DARSDA (${slot}-j., ${et} gaça):</b> <code>${rm}</code> · ${toNewUz(subj, "uz")}`,
    radarFreeNext: (slot, st, rm, subj) => `☕ <b>HOZIR BÕŞ (OYNA)</b> · Keyingi: ${slot}-j. (${st}) <code>${rm}</code> (${toNewUz(subj, "uz")})`,
    radarDone: "🏠 <b>Bugun boşqa darslar yõq</b> (kun oxirigaça bõş)",
    subBtn: "🔔 Mening jadvalim qiliş",
    subSaved: "✅ Jadval saqlandi! Endi /my orqali 1 bosişda oçişingiz mumkin.",
    noMySched: "🔔 Siz hali şaxsiy jadvalingizni tanlamagansiz.\n\nÇatga <b>HEMIS ID</b> raqamingizni yoki familiyangizni yozing va <b>«🔔 Mening jadvalim qiliş»</b> tugmasini bosing!",
    icsBtn: "📅 Kalendarga yuklaş (.ics)",
    crowdOpen: "✅ Oçiq",
    crowdBusy: "👥 Talabalar",
    crowdLocked: "🔒 Qulflangan",
    eventsTitle: "🗓 <b>JIDU Tadbirlari va E’lonlar (Telegram Channels):</b>",
    daysShort: { 1: "Du", 2: "Se", 3: "Ço", 4: "Pa", 5: "Ju", 6: "Şa" },
    daysFull: {
      1: "Duşanba",
      2: "Seşanba",
      3: "Çorşanba",
      4: "Payşanba",
      5: "Juma",
      6: "Şanba",
    },
    typesShort: {
      LECTURE: "Ma’ruza",
      PRACTICE: "Amaliy",
      COMPUTER: "Komp.",
      LANGUAGE_LAB: "Ling.",
      OFFICE: "Ofis",
      SPORT_CENTER: "Sport",
      UNIMPORTANT: "Xona",
    },
  },
  ru: {
    openApp: "📱 UWED Helpdesk (Mini App)",
    findRoomsBtn: "🟢 Найти пустую аудиторию",
    eventsBtn: "🗓 Мероприятия (Афиша)",
    overlapBtn: "🤝 Общие окна с другом",
    mySchedBtn: "🔔 Моё расписание",
    teacherBtn: "👨‍🏫 Преподаватель",
    studentBtn: "🎓 Студент",
    helpBtn: "ℹ️ Помощь",
    shareContactBtn: "📞 Поделиться контактом",
    feedbackBtn: "💬 Оставить отзыв",
    homeTitle: "✨ <b>UWED Helpdesk • УМЭД</b>",
    homeStats: (freeTotal, aFree, bFree, dFree) =>
      `🟢 Сейчас свободно <b>${freeTotal} учебных аудиторий</b>:\n` +
      `   <code>Блок A: ${aFree}</code>  ·  <code>Блок B: ${bFree}</code>  ·  <code>Блок D: ${dFree}</code>`,
    homeHint: "👇 <i>Выберите действие ниже или просто напишите номер кабинета / фамилию / ID:</i>",
    helpText:
      `ℹ️ <b>Как пользоваться UWED Helpdesk:</b>\n\n` +
      `1️⃣ <b>Mini App</b> — нажмите «📱 UWED Helpdesk» (аудитории, радар преподавателей, общие окна, афиша).\n` +
      `2️⃣ <b>Пустые кабинеты</b> — нажмите «🟢 Найти пустую аудиторию» и выберите корпус A, B или D.\n` +
      `3️⃣ <b>Быстрый поиск</b> — напишите в чат кабинет (<code>B-705</code>), фамилию учителя (<code>Abdunabiev</code>) или ID студента (<code>3502311...</code>).\n` +
      `4️⃣ <b>Команды</b> — /events (Мероприятия), /my (Моё расписание), <code>!отзыв текст</code>.`,
    pickBlockTitle: "🏢 <b>Какой корпус проверяем?</b>\n<i>Выберите блок:</i>",
    bestPicksHdr: "🔥 <b>ЛУЧШИЕ ВАРИАНТЫ (свободны до конца дня):</b>",
    floorHdr: (fl, freeCnt, total) => `🪜 <b>${fl} ЭТАЖ</b>  ·  🟢 <b>${freeCnt}</b> из ${total} своб.`,
    blockViewTitle: (b, flTitle) => `🏢 <b>БЛОК ${b}  ·  ${flTitle}</b>`,
    allFloorsRange: (maxFl) => `1–${maxFl} этажи`,
    floorNum: (fl) => `${fl} этаж`,
    freeBusyCount: (f, b) => `🟢 Свободно: <b>${f}</b>   🔴 Занято: <b>${b}</b>`,
    freeRoomsHdr: (n) => `🟢 <b>СВОБОДНЫЕ АУДИТОРИИ (${n}):</b>`,
    busyRoomsHdr: (n) => `🔴 <b>ЗАНЯТЫЕ АУДИТОРИИ (${n}):</b>`,
    noFreeOnFloor: "Нет свободных учебных аудиторий",
    seats: "м.",
    freeAllDay: "Весь день",
    freeEndDay: "До конца дня",
    freeUntil: (t, n) => `до ${t} (${n} п.)`,
    allFlBtn: "Все эт.",
    nowBtn: "⚡ Сейчас",
    backHomeBtn: "← Главное меню",
    backBlockBtn: "← К блокам",
    pairWord: (id) => `${id}-пара`,
    pairShort: (id, t) => `${id}п (${t})`,
    roomTitle: (name, b, fl) => `🚪 <b>Аудитория <code>${name}</code></b> (Блок ${b}, ${fl} этаж)`,
    freeCaps: "СВОБОДНО",
    ongoing: (id, st, et) => `Идёт ${id}-пара (${st}–${et})`,
    next: (id, st, et) => `Следующая: ${id}-пара (${st}–${et})`,
    ended: (d, st) => `Пары закончились • ${d}, 1-пара (${st})`,
    notFound: (q) => `😕 «<b>${q}</b>» не найдено.\nПример: <code>B-705</code>, <code>Abdunabiev</code> или <code>3502311...</code>`,
    searchResults: (q) => `🔎 Найдено по запросу «<b>${q}</b>» (нажмите):`,
    teacherPrompt: "👨‍🏫 <b>Радар и поиск преподавателя</b>\n\nНапишите фамилию или имя преподавателя в чат (например: <code>Abdunabiev</code>, <code>Nosirov</code>):",
    studentPrompt: "🎓 <b>Расписание студента</b>\n\nНапишите HEMIS ID студента в чат (например: <code>350231100133</code>):",
    studentWord: "Студент",
    teacherWord: "Преподаватель",
    contactSaved: "✅ Спасибо! Ваш номер телефона сохранён.",
    feedbackPrompt:
      "💬 <b>Отзывы и Предложения</b>\n\nНапишите <code>!отзыв ваш текст</code> или откройте вкладку <b>Отзыв</b> в Mini App!",
    feedbackSaved: "✅ Спасибо! Ваш отзыв сохранён.",
    radarBusy: (slot, et, rm, subj) => `📍 <b>СЕЙЧАС НА ПАРЕ (${slot}-пара, до ${et}):</b> ауд. <code>${rm}</code> · ${subj}`,
    radarFreeNext: (slot, st, rm, subj) => `☕ <b>СЕЙЧАС ОКНО (свободен)</b> · След. пара: ${slot}-пара (${st}) в <code>${rm}</code> (${subj})`,
    radarDone: "🏠 <b>На сегодня пар больше нет</b> (свободен до конца дня)",
    subBtn: "🔔 Сделать моим расписанием",
    subSaved: "✅ Расписание закреплено! Теперь оно доступно в 1 клик по команде /my.",
    noMySched: "🔔 У вас ещё не закреплено личное расписание.\n\nНапишите свой <b>HEMIS ID</b> или фамилию в чат и нажмите <b>«🔔 Сделать моим расписанием»</b>!",
    icsBtn: "📅 В календарь телефона (.ics)",
    crowdOpen: "✅ Открыто",
    crowdBusy: "👥 Сидят студенты",
    crowdLocked: "🔒 Закрыто",
    eventsTitle: "🗓 <b>Афиша и Мероприятия УМЭД (из ТГ-каналов):</b>",
    daysShort: { 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб" },
    daysFull: {
      1: "Понедельник",
      2: "Вторник",
      3: "Среда",
      4: "Четверг",
      5: "Пятница",
      6: "Суббота",
    },
    typesShort: {
      LECTURE: "Лекц.",
      PRACTICE: "Практ.",
      COMPUTER: "Комп.",
      LANGUAGE_LAB: "Линг.",
      OFFICE: "Офис",
      SPORT_CENTER: "Спорт",
      UNIMPORTANT: "Пом.",
    },
  },
  en: {
    openApp: "📱 UWED Helpdesk (Mini App)",
    findRoomsBtn: "🟢 Find Free Classroom",
    eventsBtn: "🗓 Campus Events",
    overlapBtn: "🤝 Friend Overlap Finder",
    mySchedBtn: "🔔 My Schedule",
    teacherBtn: "👨‍🏫 Teacher",
    studentBtn: "🎓 Student",
    helpBtn: "ℹ️ Help",
    shareContactBtn: "📞 Share Contact",
    feedbackBtn: "💬 Send Feedback",
    homeTitle: "✨ <b>UWED Helpdesk • Smart Campus</b>",
    homeStats: (freeTotal, aFree, bFree, dFree) =>
      `🟢 Currently <b>${freeTotal} classrooms available</b>:\n` +
      `   <code>Block A: ${aFree}</code>  ·  <code>Block B: ${bFree}</code>  ·  <code>Block D: ${dFree}</code>`,
    homeHint: "👇 <i>Choose an option below or type any room code / surname / student ID:</i>",
    helpText:
      `ℹ️ <b>Quick Guide (UWED Bot):</b>\n\n` +
      `1️⃣ <b>Mini App</b> — Tap "📱 Open Smart App" for rooms, teacher radar, friend overlap & events.\n` +
      `2️⃣ <b>Free Rooms</b> — Tap "🟢 Find Free Classroom" and select Block A, B, or D.\n` +
      `3️⃣ <b>Instant Search</b> — Type a room (<code>B-705</code>), teacher (<code>Abdunabiev</code>), or student ID (<code>3502311...</code>) directly in chat.\n` +
      `4️⃣ <b>Commands</b> — /events (Campus Events), /my (My Schedule), <code>!feedback idea</code>.`,
    pickBlockTitle: "🏢 <b>Select a Campus Building:</b>",
    bestPicksHdr: "🔥 <b>BEST PICKS (free for the rest of the day):</b>",
    floorHdr: (fl, freeCnt, total) => `🪜 <b>FLOOR ${fl}</b>  ·  🟢 <b>${freeCnt}</b> of ${total} free`,
    blockViewTitle: (b, flTitle) => `🏢 <b>BLOCK ${b}  ·  ${flTitle}</b>`,
    allFloorsRange: (maxFl) => `Floors 1–${maxFl}`,
    floorNum: (fl) => `Floor ${fl}`,
    freeBusyCount: (f, b) => `🟢 Available: <b>${f}</b>   🔴 Occupied: <b>${b}</b>`,
    freeRoomsHdr: (n) => `🟢 <b>AVAILABLE ROOMS (${n}):</b>`,
    busyRoomsHdr: (n) => `🔴 <b>OCCUPIED ROOMS (${n}):</b>`,
    noFreeOnFloor: "No available classrooms",
    seats: "seats",
    freeAllDay: "Free all day",
    freeEndDay: "Rest of day",
    freeUntil: (t, n) => `until ${t} (${n} sl.)`,
    allFlBtn: "All fl.",
    nowBtn: "⚡ Now",
    backHomeBtn: "← Main Menu",
    backBlockBtn: "← Buildings",
    pairWord: (id) => `Slot ${id}`,
    pairShort: (id, t) => `S${id} (${t})`,
    roomTitle: (name, b, fl) => `🚪 <b>Room <code>${name}</code></b> (Block ${b}, Floor ${fl})`,
    freeCaps: "AVAILABLE",
    ongoing: (id, st, et) => `Ongoing: Slot ${id} (${st}–${et})`,
    next: (id, st, et) => `Next: Slot ${id} (${st}–${et})`,
    ended: (d, st) => `Classes ended • ${d}, Slot 1 (${st})`,
    notFound: (q) => `😕 No match for "<b>${q}</b>".\nTry: <code>B-705</code>, <code>Abdunabiev</code>, or <code>3502311...</code>`,
    searchResults: (q) => `🔎 Results for "<b>${q}</b>" (tap to view):`,
    teacherPrompt: "👨‍🏫 <b>Teacher Radar & Search</b>\n\nType the teacher's surname or name in chat (e.g., <code>Abdunabiev</code>, <code>Nosirov</code>):",
    studentPrompt: "🎓 <b>Student Schedule</b>\n\nType the student's HEMIS ID in chat (e.g., <code>350231100133</code>):",
    studentWord: "Student",
    teacherWord: "Teacher",
    contactSaved: "✅ Thank you! Your phone number has been saved.",
    feedbackPrompt:
      "💬 <b>Feedback & Ideas</b>\n\nSend <code>!feedback your text</code> or use the <b>Feedback</b> tab inside the Mini App!",
    feedbackSaved: "✅ Thank you! Your feedback has been saved.",
    radarBusy: (slot, et, rm, subj) => `📍 <b>IN CLASS NOW (Slot ${slot}, until ${et}):</b> Room <code>${rm}</code> · ${subj}`,
    radarFreeNext: (slot, st, rm, subj) => `☕ <b>CURRENTLY FREE (WINDOW)</b> · Next: Slot ${slot} (${st}) in <code>${rm}</code> (${subj})`,
    radarDone: "🏠 <b>No more classes today</b> (free for the rest of the day)",
    subBtn: "🔔 Pin as My Schedule",
    subSaved: "✅ Schedule pinned! Access it anytime with 1 tap via /my.",
    noMySched: "🔔 You haven't pinned a personal schedule yet.\n\nType your <b>HEMIS ID</b> or surname in chat and tap <b>\"🔔 Pin as My Schedule\"</b>!",
    icsBtn: "📅 Export to Calendar (.ics)",
    crowdOpen: "✅ Open",
    crowdBusy: "👥 Students",
    crowdLocked: "🔒 Locked",
    eventsTitle: "🗓 <b>UWED Campus Events (from Telegram Channels):</b>",
    daysShort: { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" },
    daysFull: {
      1: "Monday",
      2: "Tuesday",
      3: "Wednesday",
      4: "Thursday",
      5: "Friday",
      6: "Saturday",
    },
    typesShort: {
      LECTURE: "Lect.",
      PRACTICE: "Sem.",
      COMPUTER: "Comp.",
      LANGUAGE_LAB: "Lang.",
      OFFICE: "Office",
      SPORT_CENTER: "Sport",
      UNIMPORTANT: "Room",
    },
  },
};

function getTashkentNow() {
  return new Date(Date.now() + 5 * 3600 * 1000);
}

function getTashkentMonday() {
  const now = getTashkentNow();
  const day = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  now.setUTCDate(now.getUTCDate() + diff);
  return now.toISOString().split("T")[0];
}

function fallbackSnapshotForPath(apiPath, query = {}) {
  const cleanPath = String(apiPath || "").toLowerCase();
  const snap = SNAPSHOT || { slots: [], rooms: [], teachers: [], events: {} };

  if (cleanPath.includes("/slots")) {
    return { success: true, data: snap.slots || [], fallback: true };
  }
  if (cleanPath.includes("/search/teachers")) {
    const q = String(query.search || "").toLowerCase().trim();
    const qLat = cyrToLat(q);
    const matches = (snap.teachers || []).filter((t) => {
      const fn = (t.full_name || "").toLowerCase();
      return fn.includes(q) || (qLat && fn.includes(qLat));
    });
    return { success: true, data: matches.slice(0, 20), fallback: true };
  }
  if (cleanPath.includes("/search/rooms")) {
    const q = String(query.search || "").toLowerCase().trim();
    const qClean = q.replace(/[-\s]/g, "");
    const matches = (snap.rooms || []).filter((r) => {
      const name = (r.name || r.room_name || "").toLowerCase();
      const num = (r.number || r.room_number || "").toLowerCase();
      const bld = (r.building || "").toLowerCase();
      const nameClean = name.replace(/[-\s]/g, "");
      return name.includes(q) || num.includes(q) || bld === q || (qClean && nameClean.includes(qClean));
    }).map((r) => ({
      ...r,
      name: r.name || r.room_name || "",
      room_name: r.name || r.room_name || "",
      number: r.number || r.room_number || "",
      room_number: r.number || r.room_number || "",
      type: r.type || r.room_type || "PRACTICE",
      room_type: r.type || r.room_type || "PRACTICE",
    }));
    return { success: true, data: matches.slice(0, 20), fallback: true };
  }
    if (cleanPath.includes("/student/search") || cleanPath.includes("/for-timetable")) {
    const q = String(query.search || "").toLowerCase().trim();
    const qLat = cyrToLat(q);
    const matches = [];
    const seen = new Set();

    if (Array.isArray(snap.students)) {
      for (const s of snap.students) {
        const fn = (s.full_name || "").toLowerCase();
        const grp = (s.group || s.group_name || "").toLowerCase();
        if (fn.includes(q) || (qLat && fn.includes(qLat)) || (grp && grp.includes(q))) {
          matches.push(s);
          if (matches.length >= 20) break;
        }
      }
    }

    if (snap.events) {
      for (const elist of Object.values(snap.events)) {
        for (const ev of elist) {
          if (ev.g) {
            const parts = String(ev.g).match(/[A-Za-z0-9\-]+/g) || [];
            for (const part of parts) {
              const pClean = part.trim();
              if (pClean.length >= 2 && pClean.toLowerCase().includes(q)) {
                const pKey = pClean.toLowerCase();
                if (!seen.has(pKey)) {
                  seen.add(pKey);
                  matches.push({
                    id: `grp:${pClean}`,
                    full_name: `Guruh ${pClean} (Группа ${pClean})`,
                    group: pClean,
                    is_group: true,
                  });
                }
              }
            }
          }
        }
      }
    }
    return { success: true, data: matches.slice(0, 20), fallback: true };
  }
  if (cleanPath.includes("/events")) {
    const rid = query.request_id || query.id;
    const qType = String(query.type || "ROOM").toUpperCase();

    if (qType === "ROOM") {
      const evs = (snap.events && snap.events[rid]) || [];
      const normalized = evs.map((e, idx) => ({
        id: `snap_${rid}_${idx}`,
        week_day: e.d,
        slot_id: e.s,
        title: e.t,
        instructor: e.i,
        room_number: e.r,
        groups: e.g,
        type: "PRACTICE",
        study_type: "LESSON",
      }));
      return { success: true, data: normalized, fallback: true };
    }

    if (qType === "TEACHER") {
      const t = (snap.teachers || []).find((x) => x.id === rid);
      const tName = t ? (t.full_name || "").toLowerCase() : "";
      const matches = [];
      if (tName && snap.events) {
        for (const elist of Object.values(snap.events)) {
          for (const e of elist) {
            if (e.i && e.i.toLowerCase().includes(tName)) {
              matches.push({
                week_day: e.d,
                slot_id: e.s,
                title: e.t,
                instructor: e.i,
                room_number: e.r,
                groups: e.g,
                type: "PRACTICE",
                study_type: "LESSON",
              });
            }
          }
        }
      }
      return { success: true, data: matches, fallback: true };
    }

    // Student / Group
    const matches = [];
    if (snap.events) {
      for (const elist of Object.values(snap.events)) {
        for (const e of elist) {
          if (e.g && rid && (e.g.includes(rid) || rid.includes(e.g))) {
            matches.push({
              week_day: e.d,
              slot_id: e.s,
              title: e.t,
              instructor: e.i,
              room_number: e.r,
              groups: e.g,
              type: "PRACTICE",
              study_type: "LESSON",
            });
          }
        }
      }
    }
    return { success: true, data: matches, fallback: true };
  }
  return { success: true, data: [], fallback: true };
}

function probeUwedHost() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: UWED_HOST,
        port: 443,
        path: "/api/timetable/public/v1/slots/by/academic/year?academic_year_id=null",
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 2500,
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function moodlePost(pathStr, formObj) {
  return new Promise((resolve, reject) => {
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
        timeout: 9000,
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
}

function moodleWsCall(token, wsfunction, extra = {}) {
  return moodlePost("/webservice/rest/server.php", {
    wstoken: token,
    moodlewsrestformat: "json",
    wsfunction,
    ...extra,
  });
}

function uwedGet(apiPath, query = {}, lang = "uz") {
  return new Promise((resolve) => {
    const cleanLang = ["uz", "ru", "en"].includes(String(lang || "").toLowerCase())
      ? String(lang).toLowerCase()
      : "uz";
    const qs = new URLSearchParams({ ...query, locale: cleanLang }).toString();
    const clean = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
    const fullPath = `/api/${clean}${qs ? "?" + qs : ""}`;
    const req = https.request(
      {
        hostname: UWED_HOST,
        port: 443,
        path: fullPath,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "application/json",
          "Accept-Language": cleanLang,
          "x-locale": cleanLang,
          locale: cleanLang,
        },
        timeout: 4500,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf-8").trim();
            if (res.statusCode >= 400) {
              return resolve(fallbackSnapshotForPath(apiPath, query));
            }
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && parsed.success !== false && (Array.isArray(parsed.data) || Array.isArray(parsed))) {
              return resolve(parsed);
            }
            resolve(fallbackSnapshotForPath(apiPath, query));
          } catch (_) {
            resolve(fallbackSnapshotForPath(apiPath, query));
          }
        });
      }
    );
    req.on("error", () => resolve(fallbackSnapshotForPath(apiPath, query)));
    req.on("timeout", () => {
      req.destroy();
      resolve(fallbackSnapshotForPath(apiPath, query));
    });
    req.end();
  });
}

function tgApi(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(
      {
        hostname: "api.telegram.org",
        port: 443,
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (_) {
            resolve({});
          }
        });
      }
    );
    req.on("error", () => resolve({}));
    req.write(body);
    req.end();
  });
}

function detectCurrentSlotAndDay(slots, lang = "uz") {
  const tr = L10N[lang] || L10N.uz;
  const now = getTashkentNow();
  let wday = now.getUTCDay();
  if (wday === 0) wday = 1;
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const curHM = `${hh}:${mm}`;

  for (const s of slots) {
    if (curHM >= s.start_time && curHM <= s.end_time) {
      return { day: wday, slot: Number(s.id), note: tr.ongoing(s.id, s.start_time, s.end_time) };
    }
  }
  for (const s of slots) {
    if (curHM < s.start_time) {
      return { day: wday, slot: Number(s.id), note: tr.next(s.id, s.start_time, s.end_time) };
    }
  }
  const nextDay = wday < 6 ? wday + 1 : 1;
  const s0 = slots[0];
  return {
    day: nextDay,
    slot: Number(s0.id),
    note: tr.ended(tr.daysShort[nextDay], s0.start_time),
  };
}

function isTeachingRoom(snap, r) {
  if (CLASSROOM_TYPES.has(r.type)) return true;
  const evs = snap.events[r.id];
  return Array.isArray(evs) && evs.length > 0;
}

function getRoomDayEvents(snap, roomId, day) {
  const list = snap.events[roomId] || [];
  const map = {};
  for (const ev of list) {
    if (Number(ev.d) === Number(day)) map[Number(ev.s)] = ev;
  }
  return map;
}

function getFreeScoreAndText(snap, roomId, day, curSlot, lang = "uz") {
  const tr = L10N[lang] || L10N.uz;
  const dayMap = getRoomDayEvents(snap, roomId, day);
  for (const s of snap.slots) {
    const sid = Number(s.id);
    if (sid > curSlot && dayMap[sid]) {
      const diff = sid - curSlot;
      return { score: diff, isFullDay: false, text: tr.freeUntil(s.start_time, diff) };
    }
  }
  const full = Object.keys(dayMap).length === 0;
  return { score: 99, isFullDay: true, text: full ? tr.freeAllDay : tr.freeEndDay };
}

function queryFloorStatus(snap, building, floor, day, slot, incOff, lang = "uz") {
  const pool = snap.rooms.filter((r) => {
    if (building !== "ALL" && r.building !== building) return false;
    if (floor !== null && Number(r.floor) !== Number(floor)) return false;
    return true;
  });
  let candidates = pool.filter((r) => incOff || isTeachingRoom(snap, r));
  if (candidates.length === 0 && pool.length > 0) candidates = pool;

  const free = [];
  const busy = [];
  for (const r of candidates) {
    const dayMap = getRoomDayEvents(snap, r.id, day);
    if (dayMap[slot]) {
      busy.push([r, dayMap[slot]]);
    } else {
      const info = getFreeScoreAndText(snap, r.id, day, slot, lang);
      free.push([r, info.text, info.score, info.isFullDay]);
    }
  }
  free.sort((a, b) => b[2] - a[2] || a[0].name.localeCompare(b[0].name));
  return { free, busy, total: candidates.length };
}

function buildReplyKeyboard(baseWebappUrl, lang = "uz") {
  const tr = L10N[lang] || L10N.uz;
  const moodleBtn = lang === "ru" ? "🎓 Moodle & Оценки" : lang === "en" ? "🎓 Moodle & Grades" : "🎓 Moodle & Baholar";
  const restartBtn = lang === "ru" ? "🔄 Перезапуск / Статус" : lang === "en" ? "🔄 System Status / Fix" : "🔄 Qayta yuklash / Holat";
  return {
    keyboard: [
      [{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
      [{ text: tr.findRoomsBtn }, { text: tr.eventsBtn }],
      [{ text: tr.mySchedBtn }, { text: moodleBtn }],
      [{ text: restartBtn }, { text: tr.helpBtn }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function formatHomeHub(snap, lang, baseWebappUrl) {
  const tr = L10N[lang] || L10N.uz;
  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  const aFree = queryFloorStatus(snap, "A", null, cur.day, cur.slot, false, lang).free.length;
  const bFree = queryFloorStatus(snap, "B", null, cur.day, cur.slot, false, lang).free.length;
  const dFree = queryFloorStatus(snap, "D", null, cur.day, cur.slot, false, lang).free.length;
  const totalFree = aFree + bFree + dFree;

  const text = [
    tr.homeTitle,
    `⏱ <b>${cur.note}</b>`,
    "",
    tr.homeStats(totalFree, aFree, bFree, dFree),
    "",
    tr.homeHint,
  ].join("\n");

  const kb = {
    inline_keyboard: [
      [{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
      [{ text: tr.findRoomsBtn, callback_data: `m:pick:${lang}` }],
      [
        {
          text: lang === "ru" ? "🎓 Moodle · Дедлайны" : lang === "en" ? "🎓 Moodle · Deadlines" : "🎓 Moodle · Dedlayn",
          web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=moodle` },
        },
        {
          text: lang === "ru" ? "🧮 GPA · HEMIS" : lang === "en" ? "🧮 GPA · HEMIS" : "🧮 GPA · HEMIS",
          web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=gpa` },
        },
      ],
      [
        {
          text: lang === "ru" ? "🗺 3D Карта УМЭД" : lang === "en" ? "🗺 3D Campus Map" : "🗺 3D Xarita",
          web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=map` },
        },
        {
          text: lang === "ru" ? "📦 Обмен · Lost&Found" : lang === "en" ? "📦 Swap · Lost&Found" : "📦 Almashinuv · Topilma",
          web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=lf` },
        },
      ],
      [
        { text: tr.teacherBtn, callback_data: `m:tprompt:${lang}` },
        { text: tr.studentBtn, callback_data: `m:sprompt:${lang}` },
      ],
      [
        { text: tr.eventsBtn, callback_data: `m:events:${lang}` },
        { text: tr.mySchedBtn, callback_data: `m:my:${lang}` },
      ],
      [
        { text: tr.overlapBtn, web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=overlap` } },
        {
          text: lang === "ru" ? "🚀 Гранты (9)" : lang === "en" ? "🚀 Grants (9)" : "🚀 Grantlar (9)",
          web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=opps` },
        },
      ],
      ["uz", "ru", "en"].map((l) => ({
        text: `${lang === l ? "✓ " : ""}${l.toUpperCase()}`,
        callback_data: `m:home:${l}`,
      })),
    ],
  };
  return { text, kb };
}

function formatBlockPicker(snap, lang, baseWebappUrl) {
  const tr = L10N[lang] || L10N.uz;
  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  const aRes = queryFloorStatus(snap, "A", null, cur.day, cur.slot, false, lang);
  const bRes = queryFloorStatus(snap, "B", null, cur.day, cur.slot, false, lang);
  const dRes = queryFloorStatus(snap, "D", null, cur.day, cur.slot, false, lang);

  const text = [
    tr.pickBlockTitle,
    `⏱ <b>${cur.note}</b>`,
    "",
    `• <b>A blok</b> (1–4): 🟢 <b>${aRes.free.length}</b> / ${aRes.total}`,
    `• <b>B blok</b> (1–7): 🟢 <b>${bRes.free.length}</b> / ${bRes.total}`,
    `• <b>D blok</b> (1–4): 🟢 <b>${dRes.free.length}</b> / ${dRes.total}`,
  ].join("\n");

  const kb = {
    inline_keyboard: [
      [
        { text: `🅰️ A (${aRes.free.length})`, callback_data: `v:${lang}:A:A:${cur.day}:${cur.slot}:0` },
        { text: `🅱️ B (${bRes.free.length})`, callback_data: `v:${lang}:B:A:${cur.day}:${cur.slot}:0` },
        { text: `🇩 D (${dRes.free.length})`, callback_data: `v:${lang}:D:A:${cur.day}:${cur.slot}:0` },
      ],
      [{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
      [{ text: tr.backHomeBtn, callback_data: `m:home:${lang}` }],
    ],
  };
  return { text, kb };
}

function encodeState(st) {
  const lang = st.lang || "uz";
  const fl = st.floor === null ? "A" : String(st.floor);
  return `v:${lang}:${st.building}:${fl}:${st.day}:${st.slot}:${st.offices ? 1 : 0}`;
}

function buildBlockInlineKb(snap, st, baseWebappUrl, roomButtons = null) {
  const lang = st.lang || "uz";
  const tr = L10N[lang] || L10N.uz;
  const rows = [];

  rows.push(
    ["A", "B", "D"].map((bCode) => ({
      text: `${st.building === bCode ? "✓ " : ""}${bCode} blok`,
      callback_data: encodeState({ ...st, building: bCode, floor: null }),
    }))
  );

  if (BLOCK_FLOORS[st.building]) {
    const floors = BLOCK_FLOORS[st.building];
    const flBtns = [
      {
        text: `${st.floor === null ? "✓ " : ""}${tr.allFlBtn}`,
        callback_data: encodeState({ ...st, floor: null }),
      },
    ];
    for (const fl of floors) {
      flBtns.push({
        text: `${st.floor === fl ? "✓ " : ""}${fl}`,
        callback_data: encodeState({ ...st, floor: fl }),
      });
    }
    for (let i = 0; i < flBtns.length; i += 4) rows.push(flBtns.slice(i, i + 4));
  }

  const dayRow = [];
  for (let d = 1; d <= 6; d++) {
    dayRow.push({
      text: `${st.day === d ? "✓" : ""}${tr.daysShort[d]}`,
      callback_data: encodeState({ ...st, day: d }),
    });
  }
  rows.push(dayRow);

  const sRow1 = [];
  const sRow2 = [];
  for (const s of snap.slots.slice(0, 6)) {
    const sid = Number(s.id);
    const btn = {
      text: `${st.slot === sid ? "✓" : ""}${sid} (${s.start_time})`,
      callback_data: encodeState({ ...st, slot: sid }),
    };
    if (sid <= 3) sRow1.push(btn);
    else sRow2.push(btn);
  }
  rows.push(sRow1, sRow2);

  if (roomButtons && roomButtons.length) {
    const rBtns = roomButtons.slice(0, 8).map((rm) => ({
      text: `🚪 ${rm.name}`,
      callback_data: `rm:${lang}:${rm.name}:${st.day}`,
    }));
    for (let i = 0; i < rBtns.length; i += 4) rows.push(rBtns.slice(i, i + 4));
  }

  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  rows.push([
    { text: tr.backHomeBtn, callback_data: `m:home:${lang}` },
    { text: tr.nowBtn, callback_data: encodeState({ ...st, day: cur.day, slot: cur.slot }) },
  ]);

  return { inline_keyboard: rows };
}

function formatStateMessage(snap, st, baseWebappUrl) {
  const lang = st.lang || "uz";
  const tr = L10N[lang] || L10N.uz;
  const b = st.building === "ALL" ? "B" : st.building;
  st.building = b;
  const slotInfo = snap.slots.find((x) => Number(x.id) === Number(st.slot)) || snap.slots[0];
  const floors = BLOCK_FLOORS[b];
  const flTitle = st.floor ? tr.floorNum(st.floor) : tr.allFloorsRange(floors[floors.length - 1]);
  const res = queryFloorStatus(snap, b, st.floor, st.day, st.slot, st.offices, lang);

  const lines = [
    tr.blockViewTitle(b, flTitle),
    `📅 <b>${tr.daysFull[st.day]}</b>  ·  ⏰ <b>${tr.pairWord(st.slot)} (${slotInfo.start_time}–${slotInfo.end_time})</b>`,
    tr.freeBusyCount(res.free.length, res.busy.length),
    "",
  ];

  let roomBtns = null;
  if (!st.floor) {
    const topPicks = res.free.filter((x) => x[3]).slice(0, 5);
    if (topPicks.length) {
      lines.push(tr.bestPicksHdr);
      lines.push(
        "  " +
          topPicks
            .map(([rm]) => `🟢 <code>${rm.name}</code> (${rm.capacity || "?"})`)
            .join("   ")
      );
      lines.push("");
    }

    for (const fl of floors) {
      const flRes = queryFloorStatus(snap, b, fl, st.day, st.slot, st.offices, lang);
      lines.push(tr.floorHdr(fl, flRes.free.length, flRes.total));
      if (flRes.free.length) {
        const pills = flRes.free.map(
          ([rm, until]) => `  <code>${rm.name}</code> — <b>${until}</b> <i>(${tr.typesShort[rm.type] || ""}, ${rm.capacity || "?"})</i>`
        );
        lines.push(...pills);
      } else {
        lines.push(`  <i>${tr.noFreeOnFloor}</i>`);
      }
      lines.push("");
    }
  } else {
    lines.push(tr.freeRoomsHdr(res.free.length));
    if (res.free.length) {
      for (const [rm, until] of res.free) {
        lines.push(
          `  🟢 <code>${rm.name}</code> — <b>${until}</b>  <i>(${tr.typesShort[rm.type] || ""} · ${rm.capacity || "?"} ${tr.seats})</i>`
        );
      }
    } else {
      lines.push(`  <i>${tr.noFreeOnFloor}</i>`);
    }
    if (res.busy.length) {
      lines.push("");
      lines.push(tr.busyRoomsHdr(res.busy.length));
      for (const [rm, ev] of res.busy) {
        lines.push(
          `  🔴 <code>${rm.name}</code> — ${toNewUz(ev.t || "—", lang)}${ev.i ? " <i>(" + toNewUz(ev.i, lang) + ")</i>" : ""}`
        );
      }
    }
    roomBtns = [...res.free.map(([r]) => r), ...res.busy.map(([r]) => r)];
  }

  return { text: lines.join("\n"), kb: buildBlockInlineKb(snap, st, baseWebappUrl, roomBtns) };
}

function buildPersonRadarLine(snap, eventsList, lang = "uz") {
  const tr = L10N[lang] || L10N.uz;
  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  const todayMap = {};
  for (const ev of eventsList || []) {
    if (Number(ev.week_day) === Number(cur.day) && ev.slot_id && !todayMap[Number(ev.slot_id)]) {
      todayMap[Number(ev.slot_id)] = ev;
    }
  }
  const curSlotObj = snap.slots.find((s) => Number(s.id) === Number(cur.slot)) || snap.slots[0];
  if (todayMap[cur.slot]) {
    const ev = todayMap[cur.slot];
    return tr.radarBusy(cur.slot, curSlotObj.end_time, ev.room_number || "?", ev.title || "—");
  }
  for (const s of snap.slots) {
    const sid = Number(s.id);
    if (sid > cur.slot && todayMap[sid]) {
      const nxt = todayMap[sid];
      return tr.radarFreeNext(sid, s.start_time, nxt.room_number || "?", nxt.title || "—");
    }
  }
  return tr.radarDone;
}

async function formatCampusEventsMessage(lang, baseWebappUrl) {
  const tr = L10N[lang] || L10N.uz;
  const db = await loadDb();
  if (
    !Array.isArray(db.channel_posts) ||
    db.channel_posts.length === 0 ||
    Date.now() - (db.last_channel_sync_ms || 0) > 15 * 60 * 1000
  ) {
    await syncTrackedChannels(db, false);
  }
  const merged = [
    ...(db.channel_posts || []),
    ...(db.campus_events || []).filter((e) => e.approved !== false),
  ].slice(0, 7);

  const trackedStr = (db.tracked_channels || ["uwed_official"]).map((c) => `@${c}`).join(", ");
  const lines = [tr.eventsTitle, `📡 <i>${trackedStr}</i>`, ""];
  for (const ev of merged) {
    const title = toNewUz(ev[`title_${lang}`] || ev.title_uz || ev.title || "", lang);
    const desc = toNewUz(ev[`desc_${lang}`] || ev.desc_uz || "", lang);
    lines.push(
      `📌 <b>${title}</b>\n` +
        `   📅 <code>${ev.date || ""}</code> · ⏰ <code>${ev.time || ""}</code> · 📍 <b>${ev.location || "UWED"}</b>\n` +
        (desc ? `   <i>${desc.slice(0, 140)}</i>\n` : "") +
        `   🔗 <a href="${ev.tg_link || "https://t.me/uwed_official"}">${ev.channel_name || "Telegram Post"}</a>`
    );
    lines.push("");
  }
  const kb = {
    inline_keyboard: [
      [{ text: `🗓 ${tr.openApp}`, web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=events` } }],
      [{ text: tr.backHomeBtn, callback_data: `m:home:${lang}` }],
    ],
  };
  return { text: lines.join("\n"), kb };
}

async function formatRoomDetailView(snap, rm, day, lang, baseWebappUrl) {
  const tr = L10N[lang] || L10N.uz;
  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  const db = await loadDb();
  const rep = db.room_reports && db.room_reports[rm.name];
  let dayMap = getRoomDayEvents(snap, rm.id, day);

  if (!dayMap || Object.keys(dayMap).length === 0) {
    try {
      const liveRes = await uwedGet(
        "/timetable/public/v1/events/list",
        { request_id: rm.id, type: "ROOM", start_time: getTashkentMonday() },
        lang
      );
      if (Array.isArray(liveRes.data) && liveRes.data.length > 0) {
        dayMap = {};
        for (const ev of liveRes.data) {
          if (Number(ev.week_day) === Number(day) && ev.slot_id) {
            dayMap[Number(ev.slot_id)] = {
              d: ev.week_day,
              s: ev.slot_id,
              t: ev.title,
              i: ev.instructor,
              g: ev.groups,
              r: ev.room_number,
            };
          }
        }
      }
    } catch (_) {}
  }

  const lines = [
    tr.roomTitle(rm.name, rm.building, rm.floor || "?"),
    `📅 <b>${tr.daysFull[day]}</b>`,
  ];

  if (rep) {
    const badge =
      rep.status === "open"
        ? tr.crowdOpen
        : rep.status === "busy_students"
        ? tr.crowdBusy
        : tr.crowdLocked;
    lines.push(`👥 Live Status: <b>${badge}</b>`);
  }
  lines.push("");

  for (const s of snap.slots.slice(0, 8)) {
    const sid = Number(s.id);
    const isNow = day === cur.day && sid === cur.slot ? " 👈" : "";
    const ev = dayMap[sid];
    if (ev) {
      lines.push(
        `🔴 <code>${s.start_time}–${s.end_time}</code> (${tr.pairWord(sid)})${isNow}\n     <b>${toNewUz(ev.t, lang)}</b> · <i>${toNewUz(ev.i || "", lang)}</i>`
      );
    } else {
      lines.push(
        `🟢 <code>${s.start_time}–${s.end_time}</code> (${tr.pairWord(sid)}) — <b>${tr.freeCaps}</b>${isNow}`
      );
    }
  }

  const dayBtns = [1, 2, 3, 4, 5, 6].map((d) => ({
    text: `${day === d ? "✓" : ""}${tr.daysShort[d]}`,
    callback_data: `rm:${lang}:${rm.name}:${d}`,
  }));
  const crowdRow = [
    { text: tr.crowdOpen, callback_data: `cr:${lang}:${rm.name}:open` },
    { text: tr.crowdBusy, callback_data: `cr:${lang}:${rm.name}:busy_students` },
    { text: tr.crowdLocked, callback_data: `cr:${lang}:${rm.name}:locked` },
  ];

  const kb = {
    inline_keyboard: [
      dayBtns,
      crowdRow,
      [{ text: `← ${rm.building} blok`, callback_data: `v:${lang}:${rm.building}:${rm.floor || "A"}:${day}:${cur.slot}:0` }],
    ],
  };
  return { text: lines.join("\n"), kb };
}

async function formatPersonScheduleView(snap, pCode, id, day, lang, baseWebappUrl) {
  const tr = L10N[lang] || L10N.uz;
  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  const type = pCode === "T" ? "TEACHER" : "STUDENT";
  const tMatch = snap.teachers.find((t) => t.id === id);
  const label = tMatch
    ? toNewUz(tMatch.full_name, lang)
    : type === "TEACHER"
    ? tr.teacherWord
    : `${tr.studentWord} (${id.slice(0, 8)})`;

  const evRes = await uwedGet(
    "/timetable/public/v1/events/list",
    {
      request_id: id,
      type,
      start_time: getTashkentMonday(),
    },
    lang
  );
  const list = Array.isArray(evRes.data) ? evRes.data : [];
  const radarLine = buildPersonRadarLine(snap, list, lang);

  const bySlot = {};
  for (const ev of list) {
    if (Number(ev.week_day) === day && ev.slot_id && !bySlot[ev.slot_id]) {
      bySlot[ev.slot_id] = ev;
    }
  }

  const lines = [
    `👤 <b>${label}</b>`,
    radarLine,
    "",
    `📅 <b>${tr.daysFull[day]}</b>  ·  🟢 Live manage.uwed.uz`,
    "",
  ];

  for (const s of snap.slots.slice(0, 8)) {
    const sid = Number(s.id);
    const isNow = day === cur.day && sid === cur.slot ? " 👈" : "";
    const ev = bySlot[sid];
    if (ev) {
      const isMidterm = ev.study_type === "MIDTERM" || /oraliq|midterm/i.test(ev.lesson_name || "");
      const badge = isMidterm ? "📝 [MIDTERM] " : "";
      const meta = [
        `🚪 <code>${ev.room_number || "?"}</code>`,
        ev.code,
        toNewUz(ev.speciality_names, lang),
        toNewUz(ev.instructor, lang),
      ]
        .filter(Boolean)
        .join(" · ");
      const topicLine =
        ev.lesson_name && !/^\d+th lesson$/i.test(ev.lesson_name)
          ? `\n     <i>📖 ${toNewUz(ev.lesson_name, lang)}</i>`
          : "";
      lines.push(
        `📘 <code>${s.start_time}–${s.end_time}</code> (${tr.pairWord(sid)})${isNow}\n     ${badge}<b>${toNewUz(ev.title || "—", lang)}</b>${topicLine}\n     ${meta}`
      );
    } else {
      lines.push(`⚪ <code>${s.start_time}–${s.end_time}</code> (${tr.pairWord(sid)}) — —${isNow}`);
    }
  }

  const dayRow = [1, 2, 3, 4, 5, 6].map((d) => ({
    text: `${day === d ? "✓" : ""}${tr.daysShort[d]}`,
    callback_data: `p:${lang}:${pCode}:${id}:${d}`,
  }));

  const kb = {
    inline_keyboard: [
      dayRow,
      [{ text: tr.subBtn, callback_data: `sub:${lang}:${pCode}:${id}` }],
      [{ text: tr.icsBtn, callback_data: `ics:${lang}:${pCode}:${id}` }],
      [{ text: tr.backHomeBtn, callback_data: `m:home:${lang}` }],
    ],
  };

  return { text: lines.join("\n"), kb, label };
}

async function formatAdminOverview(baseWebappUrl) {
  const db = await loadDb(true);
  const usersList = Object.values(db.users || {})
    .filter((u) => String(u.id) !== "12345")
    .sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));

  const topRooms = Object.entries((db.counters && db.counters.rooms) || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `<code>${k}</code> (${v})`)
    .join(", ");
  const topSearches = Object.entries((db.counters && db.counters.searches) || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `<code>${k}</code> (${v})`)
    .join(", ");

  const recentUsersLines = usersList.slice(0, 12).map((u) => {
    const uname = u.username ? `@${u.username}` : "";
    const ph = u.phone ? ` 📞 <code>${u.phone}</code>` : "";
    const st = u.blocked ? "🚫" : "✅";
    return `${st} <b>${[u.first_name, u.last_name].filter(Boolean).join(" ") || "User"}</b> ${uname} [<code>${u.id}</code>]${ph} — <b>${u.actions_count || 1}</b> act.`;
  });

  const chList = (db.tracked_channels || ["uwed_official"]).map((c) => `<code>@${c}</code>`).join(", ");
  const isMaint = db.maintenance_mode !== false;
  const maintStatusStr = isMaint
    ? "🔴 <b>ТЕХ. РАБОТЫ ВКЛЮЧЕНЫ (Бот отвечает ТОЛЬКО админу)</b>"
    : "🟢 <b>ОТКРЫТ ДЛЯ ВСЕХ (Публичный режим)</b>";

  const text = [
    `🔒 <b>UWED Helpdesk • Admin Control (@bxdxbxy)</b>`,
    `⚙️ Режим бота: ${maintStatusStr}`,
    `👥 Users: <b>${usersList.length}</b> (🚫 Blocked: <b>${usersList.filter((u) => u.blocked).length}</b>)  ·  ⚡ Actions: <b>${(db.events || []).length}</b>`,
    `🔔 Subscriptions: <b>${Object.keys(db.subscriptions || {}).length}</b>  ·  💬 Feedbacks: <b>${(db.feedbacks || []).length}</b>`,
    `📡 Tracked Event Channels: ${chList}`,
    "",
    `🔥 <b>Top Rooms:</b> ${topRooms || "—"}`,
    `🔎 <b>Top Searches:</b> ${topSearches || "—"}`,
    "",
    `🛠 <b>Команды управления:</b>`,
    `• <code>/tech on</code> — Включить тех. работы (остановить бота для других)`,
    `• <code>/tech off</code> — Открыть бота для всех пользователей`,
    `• <code>/msg ID text</code> — Send message to user`,
    `• <code>/broadcast text</code> — Message all users`,
    `• <code>/block ID</code> or <code>/allow ID</code> — Block/Unblock user`,
    `• <code>/addchannel @name</code> / <code>/delchannel @name</code> — Track TG channel events`,
    "",
    `👤 <b>Click a user below to inspect actions, block/allow, or message:</b>`,
    ...(recentUsersLines.length ? recentUsersLines : ["  —"]),
  ].join("\n");

  const userBtns = usersList.slice(0, 10).map((u) => {
    const st = u.blocked ? "🚫" : "✅";
    const name = ([u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.id).slice(0, 18);
    return {
      text: `${st} ${name}`,
      callback_data: `adm:u:${u.id}`,
    };
  });

  const rows = [];
  const toggleMaintBtn = isMaint
    ? { text: "🟢 Открыть бота для всех (/tech off)", callback_data: "adm:maint:0" }
    : { text: "🛠 Включить тех. работы для всех (/tech on)", callback_data: "adm:maint:1" };
  rows.push([toggleMaintBtn]);

  for (let i = 0; i < userBtns.length; i += 2) {
    rows.push(userBtns.slice(i, i + 2));
  }
  const secretKey = getAdminSecretKey();
  rows.push([
    {
      text: "🔒 Open Full User Control Center (WebApp)",
      web_app: { url: `${baseWebappUrl}admin.html?key=${secretKey}` },
    },
  ]);

  return { text, kb: { inline_keyboard: rows } };
}

async function formatAdminUserCard(uid, baseWebappUrl) {
  const db = await loadDb(true);
  const u = (db.users && db.users[String(uid)]) || { id: uid, first_name: "Unknown", last_actions: [] };
  const statusStr = u.blocked ? "🚫 <b>BLOCKED (Доступ закрыт)</b>" : "✅ <b>ALLOWED (Доступ разрешён)</b>";
  const actionsLines = (u.last_actions || []).slice(0, 15).map((a) => {
    return `• <code>${(a.ts || "").slice(5, 16)}</code> — <b>${a.action}</b>${a.detail ? ": <code>" + a.detail + "</code>" : ""}`;
  });

  const text = [
    `👤 <b>User Control Card</b>`,
    `Name: <b>${[u.first_name, u.last_name].filter(Boolean).join(" ") || "Guest"}</b> ${u.username ? "(@" + u.username + ")" : ""}`,
    `ID: <code>${u.id}</code>  ·  Phone: <code>${u.phone || "—"}</code>  ·  Lang: <b>${u.preferred_lang || u.language_code || "uz"}</b>`,
    `Status: ${statusStr}`,
    `Total Actions: <b>${u.actions_count || 0}</b>  ·  Last Seen: <code>${u.last_seen || "—"}</code>`,
    "",
    `✉️ <b>To send a message to this user, copy & send:</b>`,
    `<code>/msg ${u.id} Привет! </code>`,
    "",
    `📜 <b>Recent Actions (${(u.last_actions || []).length}):</b>`,
    ...(actionsLines.length ? actionsLines : ["  <i>No actions logged yet</i>"]),
  ].join("\n");

  const toggleBtn = u.blocked
    ? { text: "✅ Разрешить доступ (Allow)", callback_data: `adm:blk:${u.id}:0` }
    : { text: "🚫 Заблокировать (Block)", callback_data: `adm:blk:${u.id}:1` };

  const kb = {
    inline_keyboard: [
      [toggleBtn],
      [{ text: "🔄 Обновить лог действий", callback_data: `adm:u:${u.id}` }],
      [{ text: "← Назад к списку пользователей", callback_data: `adm:list` }],
    ],
  };

  return { text, kb };
}


async function formatSystemFixCard(snap, lang, baseWebappUrl) {
  const isOnline = await probeUwedHost();
  const freshSnap = await loadSnapshotFromDb(true);
  const snapDate = freshSnap.updated_at
    ? new Date(freshSnap.updated_at + 5 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19)
    : "Bugun";

  const roomsCount = (freshSnap.rooms || []).length;
  const teachersCount = (freshSnap.teachers || []).length;
  const eventsCount = Object.keys(freshSnap.events || {}).length;

  if (lang === "ru") {
    const text = [
      `🔄 <b>UWED Helpdesk • Перезапуск и исправление системы</b>`,
      "",
      `✅ <b>Серверная служба:</b> Активна 24/7 (Vercel Edge Cloud)`,
      `📡 <b>Связь с кампусом:</b> ${isOnline ? "🟢 Онлайн (manage.uwed.uz)" : "⚡️ Автономный режим (Снэпшот)"}`,
      `📊 <b>База кампуса:</b>`,
      `   • Аудиторий: <b>${roomsCount}</b> (Корпуса A, B, D)`,
      `   • Преподавателей: <b>${teachersCount}</b>`,
      `   • Расписаний пар: <b>${eventsCount}</b> расписаний`,
      `   • Актуальность: <code>${snapDate}</code> (${freshSnap.source || "кампус PC"})`,
      "",
      `💡 <b>Что было сделано:</b>`,
      `• Очищен локальный и сетевой кэш`,
      `• Обновлена база данных из надежного резервного снэпшота`,
      `• Включен 100% автономный режим — бот и Mini App работают стабильно, даже если ваш ноутбук или офисный ПК в университете выключен или спит!`,
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [{ text: "📅 Пары на сегодня", callback_data: `m:today:${lang}` }],
        [{ text: "🎓 Moodle · Дедлайны & Оценки", callback_data: `m:moodle:${lang}` }],
        [{ text: "🔔 Настройки напоминаний", callback_data: `m:notify:${lang}` }],
        [{ text: "📱 Открыть UWED Mini App", web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
        [{ text: "← Главное меню", callback_data: `m:home:${lang}` }],
      ],
    };
    return { text, kb };
  }

  if (lang === "en") {
    const text = [
      `🔄 <b>UWED Helpdesk • System Restart & Diagnostics</b>`,
      "",
      `✅ <b>Cloud Service:</b> Active 24/7 (Vercel Edge Cloud)`,
      `📡 <b>Campus Connectivity:</b> ${isOnline ? "🟢 Online (manage.uwed.uz)" : "⚡️ Autonomous Mode (Snapshot Fallback)"}`,
      `📊 <b>Campus Database:</b>`,
      `   • Classrooms: <b>${roomsCount}</b> (Blocks A, B, D)`,
      `   • Instructors: <b>${teachersCount}</b>`,
      `   • Timetable slots: <b>${eventsCount}</b> active schedules`,
      `   • Freshness: <code>${snapDate}</code> (${freshSnap.source || "campus PC"})`,
      "",
      `💡 <b>Actions Completed:</b>`,
      `• Flushed memory and cache buffers`,
      `• Refreshed snapshot from database`,
      `• Full autonomous mode enabled — bot works seamlessly even when the campus PC is sleeping or offline!`,
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [{ text: "📅 Today's Classes", callback_data: `m:today:${lang}` }],
        [{ text: "🎓 Moodle · Deadlines & Grades", callback_data: `m:moodle:${lang}` }],
        [{ text: "🔔 Notification Settings", callback_data: `m:notify:${lang}` }],
        [{ text: "📱 Open UWED Mini App", web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
        [{ text: "← Main Menu", callback_data: `m:home:${lang}` }],
      ],
    };
    return { text, kb };
  }

  const text = [
    `🔄 <b>UWED Helpdesk • Tizimni qayta yuklash va tuzatish</b>`,
    "",
    `✅ <b>Server xizmati:</b> 24/7 Faol (Vercel Edge Cloud)`,
    `📡 <b>Kampus aloqasi:</b> ${isOnline ? "🟢 Onlayn (manage.uwed.uz)" : "⚡️ Avtonom rejim (Zaxira snepshot)"}`,
    `📊 <b>Kampus ma'lumotlar bazasi:</b>`,
    `   • Auditoriyalar: <b>${roomsCount} ta</b> (A, B, D bloklar)`,
    `   • O'qituvchilar: <b>${teachersCount} nafar</b>`,
    `   • Dars jadvallari: <b>${eventsCount} ta</b> reja`,
    `   • Yangilangan vaqt: <code>${snapDate}</code> (${freshSnap.source || "ofis PC"})`,
    "",
    `💡 <b>Bajarilgan ishlar:</b>`,
    `• Kesh tozalab yangilandi`,
    `• Kampus ma'lumotlari zaxiradan to'liq tiklandi`,
    `• 100% avtonom rejim yoqildi — hatto universitetdagi kompyuter õchirilgan bõlsa ham bot va Mini App tõxtovsiz ishlaydi!`,
  ].join("\n");

  const kb = {
    inline_keyboard: [
      [{ text: "📅 Bugungi darslar", callback_data: `m:today:${lang}` }],
      [{ text: "🎓 Moodle · Dedlayn & Baholar", callback_data: `m:moodle:${lang}` }],
      [{ text: "🔔 Eslatma sozlamalari", callback_data: `m:notify:${lang}` }],
      [{ text: "📱 UWED Mini App'ni ochish", web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
      [{ text: "← Asosiy menyu", callback_data: `m:home:${lang}` }],
    ],
  };
  return { text, kb };
}

async function formatMoodleDashboard(userMoodle, lang, baseWebappUrl) {
  if (!userMoodle || !userMoodle.token) {
    if (lang === "ru") {
      const text = [
        `🎓 <b>UWED Moodle • Личный кабинет студента</b>`,
        "",
        `⚠️ <b>Вы пока не подключили аккаунт Moodle (moodle.uwed.uz).</b>`,
        "",
        `✨ <b>Что даёт подключение:</b>`,
        `• 🔔 <b>Напоминания о парах</b> — за 15–30 минут до начала`,
        `• ⭐️ <b>Оценки от преподавателей</b> — мгновенное оповещение при выставлении баллов`,
        `• ⏳ <b>Дедлайны заданий</b> — список сроков сдачи эссе и тестов с обратным отсчётом`,
        `• 📅 <b>Расписание пар на сегодня</b> — прямо в Telegram чате`,
        "",
        `<b>Как подключить за 5 секунд:</b>`,
        `Отправьте логин и пароль от Moodle одной строкой:`,
        `<code>/login ваш_логин ваш_пароль</code>`,
        `<i>Например:</i> <code>/login s_karimova MyPass2026!</code>`,
        "",
        `🔒 <i>Пароль передаётся по защищённому SSL напрямую в moodle.uwed.uz. Также можно войти через Mini App 👇</i>`,
      ].join("\n");

      const kb = {
        inline_keyboard: [
          [{ text: "🔗 Войти в Moodle через Mini App", web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=moodle` } }],
          [{ text: "← Назад в меню", callback_data: `m:home:${lang}` }],
        ],
      };
      return { text, kb };
    }

    if (lang === "en") {
      const text = [
        `🎓 <b>UWED Moodle • Student Portal</b>`,
        "",
        `⚠️ <b>You have not connected your Moodle account yet.</b>`,
        "",
        `✨ <b>Features:</b>`,
        `• 🔔 <b>Class Alerts:</b> 15–30 minutes before each pair`,
        `• ⭐️ <b>New Grade Alerts:</b> Instant notification when professor posts grades`,
        `• ⏳ <b>Moodle Deadlines:</b> Track assignments and countdowns`,
        `• 📅 <b>Today's Schedule:</b> View daily pairs directly in Telegram`,
        "",
        `<b>Connect in seconds:</b>`,
        `Send: <code>/login username password</code>`,
        `<i>Example:</i> <code>/login s_karimova MyPass2026!</code>`,
      ].join("\n");

      const kb = {
        inline_keyboard: [
          [{ text: "🔗 Open Moodle in Mini App", web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=moodle` } }],
          [{ text: "← Main Menu", callback_data: `m:home:${lang}` }],
        ],
      };
      return { text, kb };
    }

    const text = [
      `🎓 <b>UWED Moodle • Talaba shaxsiy kabineti</b>`,
      "",
      `⚠️ <b>Siz hali Moodle (moodle.uwed.uz) hisobingizni ulamagansiz.</b>`,
      "",
      `✨ <b>Ulanish imkoniyatlari:</b>`,
      `• 🔔 <b>Dars eslatmalari</b> — dars boshlanishidan 15–30 daqiqa oldin xabar`,
      `• ⭐️ <b>Ustozlardan yangi baholar</b> — ustoz baho qõyishi bilan bildirishnoma`,
      `• ⏳ <b>Moodle dedlaynlari</b> — topshiriq va oraliqlar muddati va taymer`,
      `• 📅 <b>Bugungi darslar</b> — to'g'ridan-to'g'ri Telegramda`,
      "",
      `<b>Tezkor ulanish:</b>`,
      `Login va parolingizni yuboring:`,
      `<code>/login login parol</code>`,
      `<i>Masalan:</i> <code>/login s_karimova MyPass2026!</code>`,
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [{ text: "🔗 Mini App orqali Moodle'ga kirish", web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=moodle` } }],
        [{ text: "← Asosiy menyu", callback_data: `m:home:${lang}` }],
      ],
    };
    return { text, kb };
  }

  const coursesCnt = (userMoodle.courses || []).length;
  const deadlinesCnt = (userMoodle.deadlines || []).length;
  const leadTime = userMoodle.lead_time_mins || 20;

  if (lang === "ru") {
    const text = [
      `🎓 <b>UWED Moodle • Кабинет студента</b>`,
      "",
      `👤 Студент: <b>${userMoodle.fullname || "Студент"}</b> (<code>${userMoodle.username || "—"}</code>)`,
      `📚 Активных курсов: <b>${coursesCnt}</b>`,
      `⏳ Ближайших дедлайнов: <b>${deadlinesCnt}</b>`,
      "",
      `🔔 <b>Статус уведомлений:</b>`,
      `• Напоминания о парах: ${userMoodle.notify_classes !== false ? `✅ Включены (за ${leadTime} мин)` : "❌ Выключены"}`,
      `• Оценки от преподавателей: ${userMoodle.notify_grades !== false ? "✅ Мгновенно" : "❌ Выключены"}`,
      `• Сроки дедлайнов: ${userMoodle.notify_deadlines !== false ? "✅ Включены" : "❌ Выключены"}`,
      "",
      `<i>Выберите действие ниже:</i>`,
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [
          { text: "⏳ Горящие дедлайны", callback_data: `m:deadlines:${lang}` },
          { text: "⭐️ Мои оценки", callback_data: `m:grades:${lang}` },
        ],
        [
          { text: "📅 Пары на сегодня", callback_data: `m:today:${lang}` },
          { text: "🔔 Настройки напоминаний", callback_data: `m:notify:${lang}` },
        ],
        [
          { text: "🔄 Обновить данные", callback_data: `m:mrefresh:${lang}` },
          { text: "🚪 Выйти из Moodle", callback_data: `m:mlogout:${lang}` },
        ],
        [{ text: "← Главное меню", callback_data: `m:home:${lang}` }],
      ],
    };
    return { text, kb };
  }

  if (lang === "en") {
    const text = [
      `🎓 <b>UWED Moodle • Student Portal</b>`,
      "",
      `👤 Student: <b>${userMoodle.fullname || "Student"}</b> (<code>${userMoodle.username || "—"}</code>)`,
      `📚 Enrolled Courses: <b>${coursesCnt}</b>`,
      `⏳ Upcoming Deadlines: <b>${deadlinesCnt}</b>`,
      "",
      `🔔 <b>Alerts Status:</b>`,
      `• Class Reminders: ${userMoodle.notify_classes !== false ? `✅ Enabled (${leadTime} min prior)` : "❌ Disabled"}`,
      `• Grade Notifications: ${userMoodle.notify_grades !== false ? "✅ Instant" : "❌ Disabled"}`,
      `• Assignment Deadlines: ${userMoodle.notify_deadlines !== false ? "✅ Enabled" : "❌ Disabled"}`,
      "",
      `<i>Choose an action below:</i>`,
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [
          { text: "⏳ Deadlines", callback_data: `m:deadlines:${lang}` },
          { text: "⭐️ My Grades", callback_data: `m:grades:${lang}` },
        ],
        [
          { text: "📅 Today's Classes", callback_data: `m:today:${lang}` },
          { text: "🔔 Notification Settings", callback_data: `m:notify:${lang}` },
        ],
        [
          { text: "🔄 Refresh", callback_data: `m:mrefresh:${lang}` },
          { text: "🚪 Logout", callback_data: `m:mlogout:${lang}` },
        ],
        [{ text: "← Main Menu", callback_data: `m:home:${lang}` }],
      ],
    };
    return { text, kb };
  }

  const text = [
    `🎓 <b>UWED Moodle • Talaba shaxsiy kabineti</b>`,
    "",
    `👤 Talaba: <b>${userMoodle.fullname || "Talaba"}</b> (<code>${userMoodle.username || "—"}</code>)`,
    `📚 Faol fanlar: <b>${coursesCnt} ta</b>`,
    `⏳ Yaqin dedlaynlar: <b>${deadlinesCnt} ta</b>`,
    "",
    `🔔 <b>Bildirishnomalar holati:</b>`,
    `• Dars eslatmalari: ${userMoodle.notify_classes !== false ? `✅ Yoqilgan (${leadTime} daqiqa oldin)` : "❌ O'chirilgan"}`,
    `• Ustozlardan baholar: ${userMoodle.notify_grades !== false ? "✅ Tezkor xabar" : "❌ O'chirilgan"}`,
    `• Topshiriq muddatlari: ${userMoodle.notify_deadlines !== false ? "✅ Yoqilgan" : "❌ O'chirilgan"}`,
    "",
    `<i>Quyidagi bo'limlardan birini tanlang:</i>`,
  ].join("\n");

  const kb = {
    inline_keyboard: [
      [
        { text: "⏳ Dedlaynlar", callback_data: `m:deadlines:${lang}` },
        { text: "⭐️ Baholarim", callback_data: `m:grades:${lang}` },
      ],
      [
        { text: "📅 Bugungi darslar", callback_data: `m:today:${lang}` },
        { text: "🔔 Bildirishnoma sozlamalari", callback_data: `m:notify:${lang}` },
      ],
      [
        { text: "🔄 Yangilash", callback_data: `m:mrefresh:${lang}` },
        { text: "🚪 Hisobdan chiqish", callback_data: `m:mlogout:${lang}` },
      ],
      [{ text: "← Asosiy menyu", callback_data: `m:home:${lang}` }],
    ],
  };
  return { text, kb };
}

async function formatMoodleDeadlines(userMoodle, lang, baseWebappUrl) {
  if (!userMoodle || !userMoodle.token) {
    return formatMoodleDashboard(userMoodle, lang, baseWebappUrl);
  }

  let events = userMoodle.deadlines || [];
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const calRaw = await moodleWsCall(userMoodle.token, "core_calendar_get_action_events_by_timesort", {
      timesortfrom: nowSec - 3600,
      limitnum: 30,
    });
    if (calRaw && Array.isArray(calRaw.events)) {
      events = calRaw.events.map((ev) => ({
        id: ev.id,
        name: ev.name || "Assignment",
        course: (ev.course && ev.course.fullname) || "",
        time: ev.timestart || ev.usermidnight || nowSec,
        url: ev.url || "",
      }));
      events.sort((a, b) => a.time - b.time);
      userMoodle.deadlines = events;
    }
  } catch (_) {}

  const nowSec = Math.floor(Date.now() / 1000);
  const futureEvents = events.filter((e) => e.time >= nowSec - 86400).slice(0, 10);

  if (futureEvents.length === 0) {
    const text =
      lang === "ru"
        ? `⏳ <b>Moodle Дедлайны (moodle.uwed.uz)</b>\n\n🎉 <b>Отличные новости!</b>\nНа ближайшие дни горящих дедлайнов нет. Все задания сданы вовремя!`
        : lang === "en"
        ? `⏳ <b>Moodle Deadlines</b>\n\n🎉 <b>Great news!</b>\nNo pending assignment deadlines for the upcoming days.`
        : `⏳ <b>Moodle Dedlaynlari</b>\n\n🎉 <b>Ajoyib yangilik!</b>\nYaqin kunlarda topshirilishi kerak bo'lgan muddatlar yo'q. Barcha vazifalar bajarilgan!`;

    const kb = {
      inline_keyboard: [
        [{ text: lang === "ru" ? "⭐️ Мои оценки" : "⭐️ Baholarim", callback_data: `m:grades:${lang}` }],
        [{ text: "← Moodle", callback_data: `m:moodle:${lang}` }],
      ],
    };
    return { text, kb };
  }

  const lines = [
    lang === "ru" ? `⏳ <b>Горящие дедлайны Moodle UWED:</b>` : lang === "en" ? `⏳ <b>UWED Moodle Deadlines:</b>` : `⏳ <b>Moodle Dedlaynlari (UWED):</b>`,
    `👤 <b>${userMoodle.fullname || userMoodle.username}</b>`,
    "",
  ];

  for (const ev of futureEvents) {
    const diffSec = ev.time - nowSec;
    const dtObj = new Date(ev.time * 1000 + 5 * 3600 * 1000);
    const dateStr = dtObj.toISOString().slice(5, 10);
    const timeStr = dtObj.toISOString().slice(11, 16);

    let badge = "🟢";
    let countdownStr = "";
    if (diffSec < 0) {
      badge = "⚪️";
      countdownStr = lang === "ru" ? "Истёк" : "Muddati o'tgan";
    } else if (diffSec < 86400) {
      badge = "🔴";
      const h = Math.floor(diffSec / 3600);
      const m = Math.floor((diffSec % 3600) / 60);
      countdownStr = lang === "ru" ? `Осталось ${h}ч ${m}м` : `${h}soat ${m}daq qoldi`;
    } else {
      badge = "🟡";
      const d = Math.floor(diffSec / 86400);
      const h = Math.floor((diffSec % 86400) / 3600);
      countdownStr = lang === "ru" ? `Осталось ${d}д ${h}ч` : `${d}kun ${h}soat qoldi`;
    }

    lines.push(
      `${badge} <b>${ev.name}</b>\n` +
      `   📚 <i>${ev.course}</i>\n` +
      `   ⏰ <code>${dateStr} ${timeStr}</code> (${countdownStr})\n`
    );
  }

  const kb = {
    inline_keyboard: [
      [{ text: lang === "ru" ? "⭐️ Мои оценки" : "⭐️ Baholarim", callback_data: `m:grades:${lang}` }],
      [{ text: "🔄 " + (lang === "ru" ? "Обновить" : "Yangilash"), callback_data: `m:deadlines:${lang}` }],
      [{ text: "← Moodle", callback_data: `m:moodle:${lang}` }],
    ],
  };
  return { text: lines.join("\n"), kb };
}

async function formatMoodleGrades(userMoodle, lang, baseWebappUrl) {
  if (!userMoodle || !userMoodle.token) {
    return formatMoodleDashboard(userMoodle, lang, baseWebappUrl);
  }

  let courses = userMoodle.courses || [];
  let userGrades = userMoodle.grades || [];

  try {
    if (courses.length === 0) {
      const cRes = await moodleWsCall(userMoodle.token, "core_enrol_get_users_courses", { userid: userMoodle.userid });
      if (Array.isArray(cRes)) {
        courses = cRes.map((c) => ({ id: c.id, name: c.fullname || c.shortname || `Course #${c.id}` }));
        userMoodle.courses = courses;
      }
    }

    const fetchedGrades = [];
    await Promise.all(
      courses.slice(0, 8).map(async (c) => {
        try {
          const gRes = await moodleWsCall(userMoodle.token, "gradereport_user_get_grade_items", {
            courseid: c.id,
            userid: userMoodle.userid,
          });
          const rawItems = (gRes && gRes.usergrades && gRes.usergrades[0] && gRes.usergrades[0].gradeitems) || [];
          for (const it of rawItems) {
            if (it.itemname || it.itemtype === "course") {
              fetchedGrades.push({
                courseId: c.id,
                courseName: c.name,
                itemName: it.itemname || (lang === "ru" ? "Итоговый балл за курс" : "Yakuniy kurs bali"),
                grade: it.gradeformatted || it.graderaw || "-",
                percentage: it.percentageformatted || "",
                feedback: it.feedback ? it.feedback.replace(/<[^>]+>/g, "").trim() : "",
              });
            }
          }
        } catch (_) {}
      })
    );

    if (fetchedGrades.length > 0) {
      userGrades = fetchedGrades;
      userMoodle.grades = fetchedGrades;
      userMoodle.last_grades = fetchedGrades;
    }
  } catch (_) {}

  const lines = [
    lang === "ru" ? `⭐️ <b>Оценки и баллы в Moodle:</b>` : lang === "en" ? `⭐️ <b>Your Moodle Grades:</b>` : `⭐️ <b>Moodle'dagi baholar va ballar:</b>`,
    `👤 <b>${userMoodle.fullname || userMoodle.username}</b>`,
    "",
  ];

  if (userGrades.length === 0) {
    lines.push(lang === "ru" ? "<i>Оценки пока не выставлены преподавателями.</i>" : "<i>Ustozlar tomonidan hali baholar qõyilmagan.</i>");
  } else {
    const byCourse = {};
    for (const g of userGrades) {
      if (!byCourse[g.courseName]) byCourse[g.courseName] = [];
      byCourse[g.courseName].push(g);
    }

    for (const [cName, items] of Object.entries(byCourse)) {
      lines.push(`📖 <b>${cName}</b>`);
      for (const it of items.slice(0, 4)) {
        const val = it.grade && it.grade !== "-" ? `⭐️ <b>${it.grade}</b>` : "⏳ <i>Tekshirilmoqda</i>";
        const pct = it.percentage ? ` (${it.percentage})` : "";
        lines.push(`  • ${it.itemName}: ${val}${pct}`);
        if (it.feedback) {
          lines.push(`    💬 <i>«${it.feedback.slice(0, 100)}»</i>`);
        }
      }
      lines.push("");
    }
  }

  lines.push(
    lang === "ru"
      ? `💡 <i>Бот мгновенно оповестит вас в Telegram, как только преподаватель выставит новую оценку!</i>`
      : `💡 <i>Ustoz yangi baho qõyishi bilan bot sizga Telegramda tezkor xabar yuboradi!</i>`
  );

  const kb = {
    inline_keyboard: [
      [{ text: lang === "ru" ? "⏳ Дедлайны" : "⏳ Dedlaynlar", callback_data: `m:deadlines:${lang}` }],
      [{ text: "🔄 " + (lang === "ru" ? "Обновить оценки" : "Baholarni yangilash"), callback_data: `m:grades:${lang}` }],
      [{ text: "← Moodle", callback_data: `m:moodle:${lang}` }],
    ],
  };
  return { text: lines.join("\n"), kb };
}

async function formatTodayClasses(from, snap, db, lang, baseWebappUrl) {
  const tr = L10N[lang] || L10N.uz;
  const cur = detectCurrentSlotAndDay(snap.slots, lang);
  const sub = (db.subscriptions && db.subscriptions[String(from.id)]) || null;
  const mUser = (db.moodle_users && db.moodle_users[String(from.id)]) || null;

  let targetId = sub ? sub.target_id : null;
  let targetKind = sub ? sub.kind : "STUDENT";
  let targetTitle = sub ? sub.title : (mUser ? mUser.fullname : null);

  if (!targetId && mUser && mUser.fullname && snap.events) {
    const q = mUser.fullname.toLowerCase();
    for (const elist of Object.values(snap.events)) {
      for (const e of elist) {
        if (e.g && (e.g.toLowerCase().includes(q) || q.includes(e.g.toLowerCase()))) {
          targetId = e.g;
          targetKind = "STUDENT";
          targetTitle = e.g;
          break;
        }
      }
      if (targetId) break;
    }
  }

  const todayClasses = [];
  if (targetId && snap.events) {
    for (const s of snap.slots.slice(0, 8)) {
      const sid = Number(s.id);
      let foundEv = null;
      if (targetKind === "TEACHER") {
        const t = snap.teachers.find((x) => x.id === targetId);
        const tName = t ? t.full_name.toLowerCase() : (targetTitle || "").toLowerCase();
        for (const elist of Object.values(snap.events)) {
          for (const e of elist) {
            if (Number(e.d) === cur.day && Number(e.s) === sid && e.i && e.i.toLowerCase().includes(tName)) {
              foundEv = e;
              break;
            }
          }
          if (foundEv) break;
        }
      } else {
        const sTarget = (targetTitle || targetId).toLowerCase();
        for (const elist of Object.values(snap.events)) {
          for (const e of elist) {
            if (Number(e.d) === cur.day && Number(e.s) === sid) {
              if (e.g && (e.g.toLowerCase().includes(sTarget) || sTarget.includes(e.g.toLowerCase()))) {
                foundEv = e;
                break;
              }
            }
          }
          if (foundEv) break;
        }
      }
      if (foundEv) {
        todayClasses.push({ slot: sid, slotObj: s, ev: foundEv });
      }
    }
  }

  const dayName = tr.daysFull[cur.day] || "Bugun";
  const lines = [
    `📅 <b>${lang === "ru" ? "Расписание пар на сегодня" : "Bugungi darslar jadvali"} (${dayName})</b>`,
    targetTitle ? `👤 <b>${targetTitle}</b>` : `👤 <i>${lang === "ru" ? "Расписание студента" : "Talaba jadvali"}</i>`,
    "",
  ];

  if (todayClasses.length === 0) {
    lines.push(
      lang === "ru"
        ? `🟢 <b>На сегодня пар нет или расписание ещё не закреплено.</b>\n\nЧтобы бот показывал ваши пары и напоминал за 20 минут, найдите вашу группу в поиске или подключите Moodle (/moodle)!`
        : `🟢 <b>Bugun darslar yo'q yoki guruh jadvali biriktirilmagan.</b>\n\nDarslar chiqishi va 20 daqiqa oldin eslatma kelishi uchun guruhingizni qidiring yoki Moodle hisobingizni ulang (/moodle)!`
    );
  } else {
    for (const item of todayClasses) {
      const s = item.slotObj;
      const ev = item.ev;
      const isNow = cur.slot === item.slot ? (lang === "ru" ? " 👈 <b>СЕЙЧАС</b>" : " 👈 <b>HOZIR</b>") : "";
      lines.push(
        `${item.slot}️⃣ <code>${s.start_time} – ${s.end_time}</code> (${tr.pairWord(item.slot)})${isNow}\n` +
        `   📚 <b>${ev.t || ev.title}</b>\n` +
        `   🚪 ${lang === "ru" ? "Аудитория:" : "Xona:"} <b>${ev.r || ev.room_number || "—"}</b> · 👨‍🏫 <i>${ev.i || ev.instructor || "—"}</i>\n`
      );
    }
    lines.push(
      lang === "ru"
        ? `🔔 <i>Бот автоматически предупредит вас за 20 минут до начала каждого занятия!</i>`
        : `🔔 <i>Bot har bir dars boshlanishidan 20 daqiqa oldin sizga eslatma yuboradi!</i>`
    );
  }

  const kb = {
    inline_keyboard: [
      [{ text: "🗺 3D " + (lang === "ru" ? "Карта кампуса" : "Kampus xaritasi"), web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=map` } }],
      [{ text: "🎓 Moodle", callback_data: `m:moodle:${lang}` }],
      [{ text: "← " + (lang === "ru" ? "Главное меню" : "Asosiy menyu"), callback_data: `m:home:${lang}` }],
    ],
  };
  return { text: lines.join("\n"), kb };
}

function formatNotificationSettings(userMoodle, lang) {
  const m = userMoodle || {};
  const notifyClasses = m.notify_classes !== false;
  const notifyGrades = m.notify_grades !== false;
  const notifyDeadlines = m.notify_deadlines !== false;
  const morningDigest = m.morning_digest !== false;
  const leadTime = m.lead_time_mins || 20;

  if (lang === "ru") {
    const text = [
      `⚙️ <b>Настройки уведомлений UWED:</b>`,
      "",
      `1️⃣ <b>Напоминания о парах:</b> ${notifyClasses ? `🔔 Включены (за ${leadTime} мин)` : "⚪️ Выключены"}`,
      `2️⃣ <b>Оценки от преподавателей:</b> ${notifyGrades ? "🔔 Мгновенно" : "⚪️ Выключены"}`,
      `3️⃣ <b>Дедлайны Moodle:</b> ${notifyDeadlines ? "🔔 Включены" : "⚪️ Выключены"}`,
      `4️⃣ <b>Утренний дайджест пар:</b> ${morningDigest ? "🔔 Включен (в 08:00)" : "⚪️ Выключен"}`,
      "",
      `<i>Нажмите на кнопку ниже, чтобы переключить параметр:</i>`,
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [{ text: `🔔 Пары: ${notifyClasses ? `Вкл (${leadTime}м)` : "Выкл"}`, callback_data: `m:tgl:classes:${lang}` }],
        [{ text: `⭐️ Новые оценки: ${notifyGrades ? "Вкл" : "Выкл"}`, callback_data: `m:tgl:grades:${lang}` }],
        [{ text: `⏳ Дедлайны: ${notifyDeadlines ? "Вкл" : "Выкл"}`, callback_data: `m:tgl:deadlines:${lang}` }],
        [{ text: `🌅 Утренний дайджест: ${morningDigest ? "Вкл" : "Выкл"}`, callback_data: `m:tgl:digest:${lang}` }],
        [{ text: "← Назад в Moodle", callback_data: `m:moodle:${lang}` }],
      ],
    };
    return { text, kb };
  }

  const text = [
    `⚙️ <b>UWED Bildirishnoma sozlamalari:</b>`,
    "",
    `1️⃣ <b>Dars eslatmalari:</b> ${notifyClasses ? `🔔 Yoqilgan (${leadTime} daq oldin)` : "⚪️ O'chirilgan"}`,
    `2️⃣ <b>Ustozlardan baholar:</b> ${notifyGrades ? "🔔 Tezkor" : "⚪️ O'chirilgan"}`,
    `3️⃣ <b>Moodle dedlaynlari:</b> ${notifyDeadlines ? "🔔 Yoqilgan" : "⚪️ O'chirilgan"}`,
    `4️⃣ <b>Ertalabki darslar rejasi:</b> ${morningDigest ? "🔔 Yoqilgan (08:00 da)" : "⚪️ O'chirilgan"}`,
    "",
    `<i>O'zgartirish uchun kerakli tugmani bosing:</i>`,
  ].join("\n");

  const kb = {
    inline_keyboard: [
      [{ text: `🔔 Darslar: ${notifyClasses ? `Yoqilgan (${leadTime}m)` : "O'chirilgan"}`, callback_data: `m:tgl:classes:${lang}` }],
      [{ text: `⭐️ Yangi baholar: ${notifyGrades ? "Yoqilgan" : "O'chirilgan"}`, callback_data: `m:tgl:grades:${lang}` }],
      [{ text: `⏳ Dedlaynlar: ${notifyDeadlines ? "Yoqilgan" : "O'chirilgan"}`, callback_data: `m:tgl:deadlines:${lang}` }],
      [{ text: `🌅 Ertalabki reja: ${morningDigest ? "Yoqilgan" : "O'chirilgan"}`, callback_data: `m:tgl:digest:${lang}` }],
      [{ text: "← Moodle'ga qaytish", callback_data: `m:moodle:${lang}` }],
    ],
  };
  return { text, kb };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, status: "UWED Helpdesk Webhook is active 24/7" });
  }

  const snap = await loadSnapshotFromDb();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "uwed-miniapp.vercel.app";
  const baseWebappUrl = `https://${host}/`;
  const upd = req.body || {};

  try {
    const db = await loadDb();
    const incomingFrom =
      (upd.message && upd.message.from) || (upd.callback_query && upd.callback_query.from) || null;
    const uRec = incomingFrom && db.users ? db.users[String(incomingFrom.id)] : null;

    // Check if non-admin user is blocked by @bxdxbxy
    if (incomingFrom && !isAdminUser(incomingFrom) && uRec && uRec.blocked) {
      if (upd.callback_query) {
        await tgApi("answerCallbackQuery", {
          callback_query_id: upd.callback_query.id,
          text: "🚫 Access Restricted by Admin",
          show_alert: true,
        });
      }
      return res.status(200).json({ ok: true });
    }

    const resolveLang = (fromObj) => {
      if (uRec && uRec.preferred_lang && L10N[uRec.preferred_lang]) {
        return uRec.preferred_lang;
      }
      const lc = ((fromObj && fromObj.language_code) || "uz").slice(0, 2);
      return L10N[lc] ? lc : "uz";
    };

    // MAINTENANCE / WHITELIST MODE:
    // When enabled (default: true), the bot ONLY responds to the admin (@bxdxbxy / 6906730753).
    // All other users get a polite technical maintenance notification.
    const isMaintenance = db.maintenance_mode !== false;
    if (incomingFrom && !isAdminUser(incomingFrom) && isMaintenance) {
      if (upd.callback_query) {
        await tgApi("answerCallbackQuery", {
          callback_query_id: upd.callback_query.id,
          text: "🛠 Hozirda botda rejaviy texnik ishlar olib borilmoqda. / Ведутся технические работы.",
          show_alert: true,
        });
        return res.status(200).json({ ok: true });
      }

      if (upd.message) {
        const chatId = upd.message.chat.id;
        const userLang = resolveLang(incomingFrom);
        const maintMsg = getMaintenanceMessage(userLang);

        await Promise.all([
          recordTelemetry({
            user: incomingFrom,
            action: "bot_maintenance_blocked",
            detail: upd.message.text || (upd.message.contact ? "contact" : "msg"),
            source: "bot",
          }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: maintMsg,
            parse_mode: "HTML",
          }),
        ]);
        return res.status(200).json({ ok: true });
      }
    }

    if (upd.message && upd.message.contact) {
      const chatId = upd.message.chat.id;
      const from = upd.message.from || {};
      const contact = upd.message.contact;
      const lang = resolveLang(from);
      const tr = L10N[lang];

      await Promise.all([
        recordTelemetry({
          user: { ...from, phone_number: contact.phone_number },
          action: "bot_share_contact",
          detail: contact.phone_number,
          source: "bot",
        }),
        tgApi("sendMessage", {
          chat_id: chatId,
          text: tr.contactSaved,
          parse_mode: "HTML",
        }),
      ]);
      return res.status(200).json({ ok: true });
    }

    if (upd.message && upd.message.text) {
      const chatId = upd.message.chat.id;
      const from = upd.message.from || {};
      const text = upd.message.text.trim();
      const lang = resolveLang(from);
      const tr = L10N[lang];
      const cur = detectCurrentSlotAndDay(snap.slots, lang);

      // STRICT ADMIN SECURITY: Only @bxdxbxy (6906730753) gets a response. Silent ignore for everyone else.
      if (
        text.startsWith("/admin") ||
        text.startsWith("/stats") ||
        text.startsWith("/users") ||
        text.startsWith("/msg") ||
        text.startsWith("/broadcast") ||
        text.startsWith("/block") ||
        text.startsWith("/unblock") ||
        text.startsWith("/allow") ||
        text.startsWith("/addchannel") ||
        text.startsWith("/delchannel") ||
        text.startsWith("/channels") ||
        text.startsWith("/maintenance") ||
        text.startsWith("/maint") ||
        text.startsWith("/tech") ||
        text.startsWith("/sync") ||
        text.startsWith("/update") ||
        text.startsWith("/refresh")
      ) {
        if (!isAdminUser(from)) {
          return res.status(200).json({ ok: true });
        }

        if (
          text.startsWith("/maintenance") ||
          text.startsWith("/maint") ||
          text.startsWith("/tech")
        ) {
          const parts = text.split(/\s+/);
          const arg = (parts[1] || "").toLowerCase();
          if (arg === "on" || arg === "1" || arg === "start" || arg === "true") {
            await adminSetMaintenance({ enabled: true });
            await tgApi("sendMessage", {
              chat_id: chatId,
              text:
                `🛠 <b>Texnik rejim (Maintenance Mode) YOQILDI!</b>\n\n` +
                `🔴 Bot boshqa foydalanuvchilar uchun yopildi (ularga texnik profilaktika xabari yuboriladi).\n` +
                `👤 Faqat sizga (@bxdxbxy) to'liq javob beradi.\n\n` +
                `Barchaga qayta ochish uchun: <code>/tech off</code>`,
              parse_mode: "HTML",
            });
            return res.status(200).json({ ok: true });
          } else if (arg === "off" || arg === "0" || arg === "stop" || arg === "false") {
            await adminSetMaintenance({ enabled: false });
            await tgApi("sendMessage", {
              chat_id: chatId,
              text:
                `✅ <b>Ommaviy rejim (Public Mode) OCHILDI!</b>\n\n` +
                `🟢 Bot barcha talabalar va foydalanuvchilar uchun ochildi va to'liq ishlamoqda!\n\n` +
                `Qayta yopish uchun: <code>/tech on</code>`,
              parse_mode: "HTML",
            });
            return res.status(200).json({ ok: true });
          } else {
            const curDb = await loadDb(true);
            const isM = curDb.maintenance_mode !== false;
            await tgApi("sendMessage", {
              chat_id: chatId,
              text:
                `⚙️ <b>Texnik rejim holati:</b>\n\n` +
                `Status: ${isM ? "🔴 <b>YOQILGAN (Faqat admin uchun)</b>" : "🟢 <b>OCHIQ (Barcha foydalanuvchilar)</b>"}\n\n` +
                `<b>Boshqaruv buyruqlari:</b>\n` +
                `• <code>/tech on</code> — Botni boshqalar uchun yopish (faqat sizga javob beradi)\n` +
                `• <code>/tech off</code> — Botni barchaga ochish\n` +
                `• <code>/tech</code> yoki <code>/maintenance</code> — Holatni tekshirish`,
              parse_mode: "HTML",
            });
            return res.status(200).json({ ok: true });
          }
        }

        if (text.startsWith("/sync") || text.startsWith("/update") || text.startsWith("/refresh")) {
          const curDb = await loadDb(true);
          curDb.pending_sync_request = {
            requested_at: Date.now(),
            requested_by: from.username || from.id || "admin",
          };
          await saveDb(curDb, true);
          const meta = curDb.campus_snapshot_meta || {};
          const lastTime = meta.updated_at
            ? new Date(meta.updated_at + 5 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19)
            : "avvalroq";

          await tgApi("sendMessage", {
            chat_id: chatId,
            text:
              `📡 <b>Sinxronizatsiya buyrug'i qabul qilindi!</b>\n\n` +
              `🖥 Kampusdagi ofis kompyuteri signalni oldi va universitet ichki tarmog'idan (Wi-Fi) yangi ma'lumotlarni yuklab olmoqda.\n\n` +
              `⏳ <i>Odatda bu 5-15 soniya davom etadi. So'ngra barcha talabalar uchun yangilanadi!</i>\n\n` +
              `🕒 Oxirgi yangilanish: <code>${lastTime}</code> (${meta.source || "ofis PC"})\n` +
              `📊 Auditoriyalar: <b>${meta.rooms_count || 231}</b> | Ustozlar: <b>${meta.teachers_count || 477}</b>`,
            parse_mode: "HTML",
          });
          return res.status(200).json({ ok: true });
        }

        if (text.startsWith("/addchannel ") || text.startsWith("/delchannel ") || text.startsWith("/channels")) {
          if (text.startsWith("/addchannel ")) {
            const ch = text.replace(/^\/addchannel\s+/, "").trim();
            const updatedDb = await adminManageChannels({ action: "add", channel: ch });
            await tgApi("sendMessage", {
              chat_id: chatId,
              text: `✅ Channel added & synced!\n📡 <b>Tracked Channels:</b> ${(updatedDb.tracked_channels || []).map((c) => "<code>@" + c + "</code>").join(", ")}\n📰 <b>Fetched Posts:</b> ${(updatedDb.channel_posts || []).length}`,
              parse_mode: "HTML",
            });
            return res.status(200).json({ ok: true });
          }
          if (text.startsWith("/delchannel ")) {
            const ch = text.replace(/^\/delchannel\s+/, "").trim();
            const updatedDb = await adminManageChannels({ action: "remove", channel: ch });
            await tgApi("sendMessage", {
              chat_id: chatId,
              text: `🗑 Channel removed.\n📡 <b>Tracked Channels:</b> ${(updatedDb.tracked_channels || []).map((c) => "<code>@" + c + "</code>").join(", ")}`,
              parse_mode: "HTML",
            });
            return res.status(200).json({ ok: true });
          }
          const updatedDb = await adminManageChannels({ action: "sync" });
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `📡 <b>Tracked Telegram Channels:</b>\n${(updatedDb.tracked_channels || []).map((c) => "• <code>@" + c + "</code>").join("\n")}\n\nTo add: <code>/addchannel @channel_username</code>\nTo remove: <code>/delchannel @channel_username</code>`,
            parse_mode: "HTML",
          });
          return res.status(200).json({ ok: true });
        }

        if (text.startsWith("/msg ")) {
          const m = text.match(/^\/msg\s+(\S+)\s+([\s\S]+)$/);
          if (!m) {
            await tgApi("sendMessage", {
              chat_id: chatId,
              text: "Usage: <code>/msg USER_ID your message</code>",
              parse_mode: "HTML",
            });
            return res.status(200).json({ ok: true });
          }
          const targetId = m[1].trim();
          const msgBody = m[2].trim();
          const sendRes = await tgApi("sendMessage", {
            chat_id: targetId,
            text: `💬 <b>UWED Helpdesk:</b>\n\n${msgBody}`,
            parse_mode: "HTML",
          });
          await adminControlUser({ target_uid: targetId, sent_message: msgBody });
          await tgApi("sendMessage", {
            chat_id: chatId,
            text:
              sendRes && sendRes.ok
                ? `✅ Message delivered to <code>${targetId}</code>!`
                : `⚠️ Failed to deliver to <code>${targetId}</code>: ${(sendRes && sendRes.description) || "unknown error"}`,
            parse_mode: "HTML",
          });
          return res.status(200).json({ ok: true });
        }

        if (text.startsWith("/broadcast ")) {
          const msgBody = text.replace(/^\/broadcast\s+/, "").trim();
          const freshDb = await loadDb(true);
          const tgIds = Object.keys(freshDb.users || {}).filter((id) => /^\d+$/.test(id));
          let delivered = 0;
          await Promise.all(
            tgIds.map(async (uid) => {
              const r = await tgApi("sendMessage", {
                chat_id: uid,
                text: `📢 <b>UWED Helpdesk:</b>\n\n${msgBody}`,
                parse_mode: "HTML",
              });
              if (r && r.ok) delivered++;
            })
          );
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `✅ Broadcast delivered to <b>${delivered}</b> / ${tgIds.length} users.`,
            parse_mode: "HTML",
          });
          return res.status(200).json({ ok: true });
        }

        if (text.startsWith("/block ") || text.startsWith("/unblock ") || text.startsWith("/allow ")) {
          const isBlk = text.startsWith("/block ");
          const targetId = text.split(/\s+/)[1] || "";
          await adminControlUser({ target_uid: targetId, set_blocked: isBlk });
          const card = await formatAdminUserCard(targetId, baseWebappUrl);
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: card.text,
            parse_mode: "HTML",
            reply_markup: card.kb,
          });
          return res.status(200).json({ ok: true });
        }

        const ov = await formatAdminOverview(baseWebappUrl);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: ov.text,
          parse_mode: "HTML",
          reply_markup: ov.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (
        text.startsWith("/restart") ||
        text.startsWith("/fix") ||
        text.startsWith("/repair") ||
        text.startsWith("/status") ||
        text.includes("Qayta yuklash") ||
        text.includes("Перезапуск") ||
        text.includes("System Status")
      ) {
        const card = await formatSystemFixCard(snap, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_system_fix", detail: "", source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: card.text,
            parse_mode: "HTML",
            reply_markup: card.kb,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/moodle") || text.includes("Moodle")) {
        const curDb = await loadDb();
        const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
        const card = await formatMoodleDashboard(uM, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_moodle", detail: "", source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: card.text,
            parse_mode: "HTML",
            reply_markup: card.kb,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/deadlines") || text.includes("Dedlayn") || text.includes("Дедлайн")) {
        const curDb = await loadDb();
        const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
        const card = await formatMoodleDeadlines(uM, lang, baseWebappUrl);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: card.text,
          parse_mode: "HTML",
          reply_markup: card.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/grades") || text.includes("Baholar") || text.includes("Оценки")) {
        const curDb = await loadDb();
        const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
        const card = await formatMoodleGrades(uM, lang, baseWebappUrl);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: card.text,
          parse_mode: "HTML",
          reply_markup: card.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/today") || text.includes("Bugungi darslar") || text.includes("Пары сегодня")) {
        const curDb = await loadDb();
        const card = await formatTodayClasses(from, snap, curDb, lang, baseWebappUrl);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: card.text,
          parse_mode: "HTML",
          reply_markup: card.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/notify") || text.includes("Eslatmalar") || text.includes("Напоминания")) {
        const curDb = await loadDb();
        const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
        const card = formatNotificationSettings(uM, lang);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: card.text,
          parse_mode: "HTML",
          reply_markup: card.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/login")) {
        const parts = text.split(/\s+/);
        if (parts.length >= 3) {
          const login = parts[1].trim();
          const password = parts.slice(2).join(" ").trim();
          const tokRes = await moodlePost("/login/token.php", {
            service: "moodle_mobile_app",
            username: login,
            password: password,
          });

          if (!tokRes || tokRes.errorcode || !tokRes.token) {
            const errText =
              lang === "ru"
                ? `❌ <b>Ошибка входа в Moodle:</b> Неверный логин или пароль.\nПопробуйте ещё раз: <code>/login логин пароль</code>`
                : `❌ <b>Moodle xatosi:</b> Login yoki parol xato kiritildi.\nQayta urinib ko'ring: <code>/login login parol</code>`;
            await tgApi("sendMessage", { chat_id: chatId, text: errText, parse_mode: "HTML" });
            return res.status(200).json({ ok: true });
          }

          const token = tokRes.token;
          const siteInfo = await moodleWsCall(token, "core_webservice_get_site_info");
          const userid = siteInfo && siteInfo.userid;
          const fullname = (siteInfo && siteInfo.fullname) || login;

          const [coursesRaw, calRaw] = await Promise.all([
            moodleWsCall(token, "core_enrol_get_users_courses", { userid }).catch(() => []),
            moodleWsCall(token, "core_calendar_get_action_events_by_timesort", {
              timesortfrom: Math.floor(Date.now() / 1000) - 3600,
              limitnum: 30,
            }).catch(() => ({ events: [] })),
          ]);

          const courses = Array.isArray(coursesRaw)
            ? coursesRaw.map((c) => ({ id: c.id, name: c.fullname || c.shortname }))
            : [];
          const deadlines = calRaw && Array.isArray(calRaw.events) ? calRaw.events : [];

          await recordTelemetry({
            user: from,
            action: "moodle_login",
            detail: fullname,
            source: "bot",
            moodle: {
              token,
              username: login,
              fullname,
              userid,
              courses,
              deadlines,
              notify_classes: true,
              notify_grades: true,
              notify_deadlines: true,
              morning_digest: true,
              lead_time_mins: 20,
            },
          });

          const curDb = await loadDb();
          if (!curDb.subscriptions[String(from.id)]) {
            curDb.subscriptions[String(from.id)] = {
              uid: String(from.id),
              chat_id: from.id,
              kind: "STUDENT",
              target_id: String(from.id),
              title: fullname,
              lang,
              notify: true,
              updated_at: new Date().toISOString(),
            };
            await saveDb(curDb, true);
          }

          const welcomeMsg =
            lang === "ru"
              ? `🎉 <b>Moodle успешно подключён!</b>\n\n` +
                `👤 Студент: <b>${fullname}</b> (<code>${login}</code>)\n` +
                `📚 Курсов: <b>${courses.length}</b>\n` +
                `⏳ Активных дедлайнов: <b>${deadlines.length}</b>\n\n` +
                `🔔 <b>Напоминания активированы:</b>\n` +
                `• Напоминание о парах за 20 минут до начала\n` +
                `• Уведомления об оценках сразу при выставлении\n` +
                `• Горящие дедлайны домашних заданий`
              : `🎉 <b>Moodle hisobingiz muvaffaqiyatli ulandi!</b>\n\n` +
                `👤 Talaba: <b>${fullname}</b> (<code>${login}</code>)\n` +
                `📚 Fanlar: <b>${courses.length} ta</b>\n` +
                `⏳ Dedlaynlar: <b>${deadlines.length} ta</b>\n\n` +
                `🔔 <b>Eslatmalar yoqildi:</b>\n` +
                `• Har bir darsdan 20 daqiqa oldin xabar\n` +
                `• Ustoz yangi baho qo'yganda tezkor bildirishnoma\n` +
                `• Topshiriqlar dedlaynlari`;

          const dash = await formatMoodleDashboard(
            { token, username: login, fullname, courses, deadlines },
            lang,
            baseWebappUrl
          );
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: welcomeMsg,
            parse_mode: "HTML",
            reply_markup: dash.kb,
          });
          return res.status(200).json({ ok: true });
        }

        const promptMsg =
          lang === "ru"
            ? `🎓 <b>Вход в Moodle (moodle.uwed.uz):</b>\n\n` +
              `Отправьте логин и пароль в формате:\n<code>/login ваш_логин ваш_пароль</code>\n\n` +
              `<i>Пример:</i> <code>/login s_karimova MyPassword123!</code>\n\n` +
              `Или откройте Moodle в нашем Mini App 👇`
            : `🎓 <b>Moodle'ga kirish (moodle.uwed.uz):</b>\n\n` +
              `Quyidagi formatda yuboring:\n<code>/login login parol</code>\n\n` +
              `<i>Masalan:</i> <code>/login s_karimova MyPassword123!</code>\n\n` +
              `Yoki Mini App orqali ulaning 👇`;

        await tgApi("sendMessage", {
          chat_id: chatId,
          text: promptMsg,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔗 Moodle Mini App", web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=moodle` } }],
            ],
          },
        });
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/logout")) {
        const curDb = await loadDb();
        if (curDb.moodle_users && curDb.moodle_users[String(from.id)]) {
          delete curDb.moodle_users[String(from.id)];
          await saveDb(curDb, true);
        }
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: lang === "ru" ? "🚪 Вы успешно вышли из Moodle." : "🚪 Moodle hisobidan muvaffaqiyatli chiqildi.",
        });
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/start")) {
        const hub = formatHomeHub(snap, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_start", detail: text, source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: hub.text,
            parse_mode: "HTML",
            reply_markup: buildReplyKeyboard(baseWebappUrl, lang),
          }),
        ]);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: "👇",
          reply_markup: hub.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (
        text.startsWith("/help") ||
        text.includes("Yordam") ||
        text.includes("Помощь") ||
        text.includes("Help")
      ) {
        const hub = formatHomeHub(snap, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_help", detail: "", source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: tr.helpText,
            parse_mode: "HTML",
            reply_markup: hub.kb,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (
        text.startsWith("/events") ||
        text.includes("Tadbirlar") ||
        text.includes("Мероприятия") ||
        text.includes("Campus Events")
      ) {
        const evMsg = await formatCampusEventsMessage(lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_events", detail: "", source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: evMsg.text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: evMsg.kb,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (
        text.startsWith("/my") ||
        text.includes("Meniꞑ jadvalim") ||
        text.includes("Моё расписание") ||
        text.includes("My Schedule")
      ) {
        const sub = db.subscriptions && db.subscriptions[String(from.id)];
        if (!sub || !sub.target_id) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: tr.noMySched,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }]],
            },
          });
          return res.status(200).json({ ok: true });
        }
        const pCode = sub.kind === "TEACHER" ? "T" : "S";
        const view = await formatPersonScheduleView(snap, pCode, sub.target_id, cur.day, lang, baseWebappUrl);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: view.text,
          parse_mode: "HTML",
          reply_markup: view.kb,
        });
        return res.status(200).json({ ok: true });
      }

      if (
        text.startsWith("/now") ||
        text.startsWith("/rooms") ||
        text.includes("Bõş xonalarni") ||
        text.includes("Найти пустую") ||
        text.includes("Find Free")
      ) {
        const picker = formatBlockPicker(snap, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_find_rooms", detail: "", source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: picker.text,
            parse_mode: "HTML",
            reply_markup: picker.kb,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (
        text.startsWith("/feedback") ||
        text.includes("Taklif va Fikr") ||
        text.includes("Оставить отзыв") ||
        text.includes("Send Feedback")
      ) {
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: tr.feedbackPrompt,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}&tab=feedback` } }]],
          },
        });
        return res.status(200).json({ ok: true });
      }

      if (/^!(fikr|отзыв|feedback)/i.test(text)) {
        const msg = text.replace(/^!(fikr|отзыв|feedback)\s*/i, "").trim();
        await Promise.all([
          recordTelemetry({
            user: from,
            action: "submit_feedback",
            detail: msg,
            source: "bot",
            feedback: { rating: 5, message: msg },
          }),
          tgApi("sendMessage", { chat_id: chatId, text: tr.feedbackSaved, parse_mode: "HTML" }),
        ]);
        return res.status(200).json({ ok: true });
      }

      // Direct Room Lookup
      const qClean = text.toUpperCase().replace(/\s+/g, "").replace("А", "A").replace("Б", "B").replace("В", "B").replace("Д", "D");
      const roomMatch = snap.rooms.find(
        (r) =>
          r.name.toUpperCase() === qClean ||
          r.name.toUpperCase().replace("-", "") === qClean.replace("-", "") ||
          r.number.toUpperCase() === qClean
      );
      if (roomMatch) {
        const rv = await formatRoomDetailView(snap, roomMatch, cur.day, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_room", detail: roomMatch.name, source: "bot" }),
          tgApi("sendMessage", {
            chat_id: chatId,
            text: rv.text,
            parse_mode: "HTML",
            reply_markup: rv.kb,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      // Live search teacher / student
      const [tRes, sRes] = await Promise.all([
        uwedGet("/timetable/public/v1/search/teachers", { search: text }, lang),
        uwedGet("/education/public/v1/student/search/for-timetable", { search: text }, lang),
        recordTelemetry({ user: from, action: "bot_search", detail: text, source: "bot" }),
      ]);
      let teachers = Array.isArray(tRes.data) ? tRes.data.slice(0, 5) : [];
      let students = Array.isArray(sRes.data) ? sRes.data.slice(0, 5) : [];

      if (teachers.length === 0 && snap.teachers) {
        const q = text.toLowerCase().trim();
        const qLat = cyrToLat(q);
        teachers = snap.teachers
          .filter((t) => {
            const fn = (t.full_name || "").toLowerCase();
            return fn.includes(q) || (qLat && fn.includes(qLat));
          })
          .slice(0, 5);
      }

      if (teachers.length || students.length) {
        const rows = [];
        for (const t of teachers) {
          rows.push([{ text: `👨‍🏫 ${toNewUz(t.full_name, lang)}`, callback_data: `p:${lang}:T:${t.id}:${cur.day}` }]);
        }
        for (const s of students) {
          rows.push([{ text: `🎓 ${tr.studentWord}: ${toNewUz(s.full_name, lang)}`, callback_data: `p:${lang}:S:${s.id}:${cur.day}` }]);
        }
        rows.push([{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }]);
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: tr.searchResults(text),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: rows },
        });
        return res.status(200).json({ ok: true });
      }

      await tgApi("sendMessage", {
        chat_id: chatId,
        text: tr.notFound(text),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }]],
        },
      });
      return res.status(200).json({ ok: true });
    }

    if (upd.callback_query) {
      const cb = upd.callback_query;
      const from = cb.from || {};
      const chatId = cb.message.chat.id;
      const messageId = cb.message.message_id;
      const data = cb.data || "";

      // Admin user control callbacks (strictly @bxdxbxy only)
      if (data.startsWith("adm:")) {
        if (!isAdminUser(from)) {
          return res.status(200).json({ ok: true });
        }
        const parts = data.split(":");
        const subCmd = parts[1];

        if (subCmd === "list") {
          const ov = await formatAdminOverview(baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: ov.text,
              parse_mode: "HTML",
              reply_markup: ov.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (subCmd === "u") {
          const targetUid = parts[2];
          const card = await formatAdminUserCard(targetUid, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (subCmd === "blk") {
          const targetUid = parts[2];
          const setBlk = parts[3] === "1";
          await adminControlUser({ target_uid: targetUid, set_blocked: setBlk });
          const card = await formatAdminUserCard(targetUid, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: setBlk ? "🚫 Пользователь заблокирован!" : "✅ Доступ разрешён!",
            }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (subCmd === "maint") {
          const setMaint = parts[2] === "1";
          await adminSetMaintenance({ enabled: setMaint });
          const ov = await formatAdminOverview(baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: ov.text,
              parse_mode: "HTML",
              reply_markup: ov.kb,
            }),
            tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: setMaint
                ? "🛠 Технические работы включены (бот отвечает только вам)!"
                : "✅ Бот открыт для всех пользователей!",
              show_alert: true,
            }),
          ]);
          return res.status(200).json({ ok: true });
        }
      }

      if (data.startsWith("m:")) {
        const [, mode, langRaw] = data.split(":");
        const lang = L10N[langRaw] ? langRaw : "uz";
        const tr = L10N[lang];
        const cur = detectCurrentSlotAndDay(snap.slots, lang);

        if (mode === "fix" || mode === "restart") {
          const card = await formatSystemFixCard(snap, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "🔄 Tizim qayta yuklandi / Система перезапущена!" }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "moodle") {
          const curDb = await loadDb();
          const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
          const card = await formatMoodleDashboard(uM, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "deadlines") {
          const curDb = await loadDb();
          const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
          const card = await formatMoodleDeadlines(uM, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "grades") {
          const curDb = await loadDb();
          const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
          const card = await formatMoodleGrades(uM, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "today") {
          const curDb = await loadDb();
          const card = await formatTodayClasses(from, snap, curDb, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "notify") {
          const curDb = await loadDb();
          const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
          const card = formatNotificationSettings(uM, lang);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "tgl") {
          const [, , field, langParam] = data.split(":");
          const actLang = langParam || lang;
          const curDb = await loadDb();
          if (!curDb.moodle_users) curDb.moodle_users = {};
          const uM = curDb.moodle_users[String(from.id)] || { uid: String(from.id) };
          if (field === "classes") {
            if (uM.notify_classes === false) {
              uM.notify_classes = true;
              uM.lead_time_mins = 20;
            } else if (uM.lead_time_mins === 20) {
              uM.lead_time_mins = 30;
            } else {
              uM.notify_classes = false;
            }
          } else if (field === "grades") {
            uM.notify_grades = uM.notify_grades === false;
          } else if (field === "deadlines") {
            uM.notify_deadlines = uM.notify_deadlines === false;
          } else if (field === "digest") {
            uM.morning_digest = uM.morning_digest === false;
          }
          curDb.moodle_users[String(from.id)] = uM;
          await saveDb(curDb, true);
          const card = formatNotificationSettings(uM, actLang);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Sozlama yangilandi / Настройка обновлена" }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "mlogout") {
          const curDb = await loadDb();
          if (curDb.moodle_users && curDb.moodle_users[String(from.id)]) {
            delete curDb.moodle_users[String(from.id)];
            await saveDb(curDb, true);
          }
          const card = await formatMoodleDashboard(null, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "🚪 Chiqildi / Вы вышли" }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "mrefresh") {
          const curDb = await loadDb(true);
          const uM = (curDb.moodle_users && curDb.moodle_users[String(from.id)]) || null;
          const card = await formatMoodleDashboard(uM, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: card.text,
              parse_mode: "HTML",
              reply_markup: card.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "🔄 Yangilandi / Обновлено!" }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "home") {
          const hub = formatHomeHub(snap, lang, baseWebappUrl);
          await Promise.all([
            recordTelemetry({
              user: { ...from, preferred_lang: lang },
              action: "bot_lang",
              detail: lang,
              source: "bot",
            }),
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: hub.text,
              parse_mode: "HTML",
              reply_markup: hub.kb,
            }),
            tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: lang === "ru" ? "🇷🇺 Язык: Русский" : lang === "en" ? "🇬🇧 Language: English" : "🇺🇿 Til: Õzbekça",
            }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "pick") {
          const picker = formatBlockPicker(snap, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: picker.text,
              parse_mode: "HTML",
              reply_markup: picker.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "events") {
          const evMsg = await formatCampusEventsMessage(lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: evMsg.text,
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: evMsg.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "my") {
          const db = await loadDb();
          const sub = db.subscriptions && db.subscriptions[String(from.id)];
          if (!sub || !sub.target_id) {
            await Promise.all([
              tgApi("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: tr.noMySched,
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
                    [{ text: tr.backHomeBtn, callback_data: `m:home:${lang}` }],
                  ],
                },
              }),
              tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
            ]);
            return res.status(200).json({ ok: true });
          }
          const pCode = sub.kind === "TEACHER" ? "T" : "S";
          const view = await formatPersonScheduleView(snap, pCode, sub.target_id, cur.day, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: view.text,
              parse_mode: "HTML",
              reply_markup: view.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }

        if (mode === "tprompt" || mode === "sprompt") {
          const promptTxt = mode === "tprompt" ? tr.teacherPrompt : tr.studentPrompt;
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: promptTxt,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: tr.openApp, web_app: { url: `${baseWebappUrl}?lang=${lang}` } }],
                  [{ text: tr.backHomeBtn, callback_data: `m:home:${lang}` }],
                ],
              },
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
          return res.status(200).json({ ok: true });
        }
      }

      if (data.startsWith("v:")) {
        const parts = data.split(":");
        let lang = "uz", b, flStr, dStr, sStr, offStr;
        if (parts.length === 7) {
          [, lang, b, flStr, dStr, sStr, offStr] = parts;
        } else {
          [, b, flStr, dStr, sStr, offStr] = parts;
        }
        const st = {
          lang: L10N[lang] ? lang : "uz",
          building: b,
          floor: flStr === "A" ? null : Number(flStr),
          day: Number(dStr),
          slot: Number(sStr),
          offices: offStr === "1",
        };
        const view = formatStateMessage(snap, st, baseWebappUrl);
        await Promise.all([
          recordTelemetry({ user: from, action: "bot_block", detail: `${b}:${flStr}`, source: "bot" }),
          tgApi("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: view.text,
            parse_mode: "HTML",
            reply_markup: view.kb,
          }),
          tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith("rm:")) {
        const parts = data.split(":");
        const lang = parts.length === 4 ? parts[1] : "uz";
        const rname = parts.length === 4 ? parts[2] : parts[1];
        const day = Number(parts.length === 4 ? parts[3] : parts[2]);
        const rm = snap.rooms.find((r) => r.name === rname);
        if (rm) {
          const rv = await formatRoomDetailView(snap, rm, day, lang, baseWebappUrl);
          await Promise.all([
            recordTelemetry({ user: from, action: "bot_room", detail: rm.name, source: "bot" }),
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: rv.text,
              parse_mode: "HTML",
              reply_markup: rv.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
          ]);
        }
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith("cr:")) {
        const [, lang, rname, status] = data.split(":");
        const cur = detectCurrentSlotAndDay(snap.slots, lang);
        await recordTelemetry({
          user: from,
          action: "bot_crowd_room",
          detail: `${rname}:${status}`,
          source: "bot",
          room_report: { room: rname, status },
        });
        const rm = snap.rooms.find((r) => r.name === rname);
        if (rm) {
          const rv = await formatRoomDetailView(snap, rm, cur.day, lang, baseWebappUrl);
          await Promise.all([
            tgApi("editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: rv.text,
              parse_mode: "HTML",
              reply_markup: rv.kb,
            }),
            tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "✓ Status yangilandi!" }),
          ]);
        }
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith("sub:")) {
        const [, lang, pCode, id] = data.split(":");
        const tr = L10N[lang] || L10N.uz;
        const kind = pCode === "T" ? "TEACHER" : "STUDENT";
        const tMatch = snap.teachers.find((t) => t.id === id);
        const title = tMatch ? tMatch.full_name : `${kind} ${id.slice(0, 8)}`;
        await Promise.all([
          recordTelemetry({
            user: { ...from, chat_id: chatId },
            action: "bot_subscribe",
            detail: `${kind}:${title}`,
            source: "bot",
            subscription: { kind, target_id: id, title, lang, notify: true },
          }),
          tgApi("answerCallbackQuery", {
            callback_query_id: cb.id,
            text: tr.subSaved,
            show_alert: true,
          }),
        ]);
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith("ics:")) {
        const [, lang, pCode, id] = data.split(":");
        const type = pCode === "T" ? "TEACHER" : "STUDENT";
        const tMatch = snap.teachers.find((t) => t.id === id);
        const label = tMatch ? tMatch.full_name : `${type} ${id.slice(0, 8)}`;
        const mondayStr = getTashkentMonday();
        const evRes = await uwedGet(
          "/timetable/public/v1/events/list",
          { request_id: id, type, start_time: mondayStr },
          lang
        );
        const list = Array.isArray(evRes.data) ? evRes.data : [];
        const SLOT_TIMES = {
          1: ["090000", "102000"],
          2: ["103000", "115000"],
          3: ["120000", "132000"],
          4: ["140000", "152000"],
          5: ["153000", "165000"],
          6: ["170000", "182000"],
        };
        const icsLines = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//UWED Helpdesk//Schedule//EN",
          "CALSCALE:GREGORIAN",
          "METHOD:PUBLISH",
          `X-WR-CALNAME:UWED - ${label}`,
          "X-WR-TIMEZONE:Asia/Tashkent",
        ];
        const [y, m, d] = mondayStr.split("-").map(Number);
        const seen = new Set();
        for (const ev of list) {
          const wday = Number(ev.week_day);
          const sid = Number(ev.slot_id);
          if (!wday || !sid || !SLOT_TIMES[sid]) continue;
          const k = `${wday}_${sid}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const dt = new Date(Date.UTC(y, m - 1, d + (wday - 1)));
          const ymd = dt.toISOString().slice(0, 10).replace(/-/g, "");
          const [st, et] = SLOT_TIMES[sid];
          icsLines.push(
            "BEGIN:VEVENT",
            `UID:uwed-${id}-${wday}-${sid}@uwed.uz`,
            `DTSTART;TZID=Asia/Tashkent:${ymd}T${st}`,
            `DTEND;TZID=Asia/Tashkent:${ymd}T${et}`,
            "RRULE:FREQ=WEEKLY;COUNT=15",
            `SUMMARY:${String(ev.title || "UWED Class").replace(/[\r\n,;]/g, " ")} (${ev.room_number || "UWED"})`,
            `LOCATION:UWED Room ${ev.room_number || ""}`,
            "END:VEVENT"
          );
        }
        icsLines.push("END:VCALENDAR");
        const boundary = "----UWEDBotIcs" + Date.now().toString(16);
        const bodyBuf = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n📅 ${label} — UWED Schedule (.ics)\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="uwed_schedule.ics"\r\nContent-Type: text/calendar; charset=utf-8\r\n\r\n`,
            "utf-8"
          ),
          Buffer.from(icsLines.join("\r\n"), "utf-8"),
          Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
        ]);
        await new Promise((resolve) => {
          const reqDoc = https.request(
            {
              hostname: "api.telegram.org",
              port: 443,
              path: `/bot${BOT_TOKEN}/sendDocument`,
              method: "POST",
              headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": bodyBuf.length,
              },
              timeout: 8000,
            },
            (r) => {
              r.on("data", () => {});
              r.on("end", resolve);
            }
          );
          reqDoc.on("error", resolve);
          reqDoc.write(bodyBuf);
          reqDoc.end();
        });
        await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "📥 .ics file sent to chat!" });
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith("p:")) {
        const parts = data.split(":");
        const lang = parts.length === 5 ? parts[1] : "uz";
        const pCode = parts.length === 5 ? parts[2] : parts[1];
        const id = parts.length === 5 ? parts[3] : parts[2];
        const day = Number(parts.length === 5 ? parts[4] : parts[3]);
        const type = pCode === "T" ? "TEACHER" : "STUDENT";

        const view = await formatPersonScheduleView(snap, pCode, id, day, lang, baseWebappUrl);
        await Promise.all([
          recordTelemetry({
            user: from,
            action: type === "TEACHER" ? "bot_teacher" : "bot_student",
            detail: view.label,
            source: "bot",
          }),
          tgApi("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: view.text,
            parse_mode: "HTML",
            reply_markup: view.kb,
          }),
          tgApi("answerCallbackQuery", { callback_query_id: cb.id }),
        ]);
        return res.status(200).json({ ok: true });
      }

      await tgApi("answerCallbackQuery", { callback_query_id: cb.id });
    }

    // Proactive background reminders & Moodle alerts
    checkAndDispatchAlerts(snap, tgApi).catch(() => {});
  } catch (err) {
    console.error("Webhook error:", err);
  }
  return res.status(200).json({ ok: true });
};
