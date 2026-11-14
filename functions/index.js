// Push notifications for the weekly football app.
const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 3 });

const db = getFirestore();
const APP_URL = "https://yossisheffek1.github.io/teams-football/";
const COLORS = ["כתומים", "כחולים", "צהובים", "ירוקים", "אדומים", "שחורים", "לבנים", "סגולים", "ורודים", "חומים"];

// ---------- helpers ----------
async function getConfig() {
  const c = await db.doc("config/main").get();
  return c.exists ? c.data() : {};
}
async function getSignups() {
  const snap = await db.collection("signups").orderBy("ts").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

async function tokensFor(uids) {
  const out = [];
  for (const uid of new Set(uids)) {
    if (!uid || uid === "admin") continue;
    const t = await db.doc(`tokens/${uid}`).get();
    if (t.exists && t.data().token) out.push({ uid, token: t.data().token, ref: t.ref });
  }
  return out;
}
async function allTokens() {
  const snap = await db.collection("tokens").get();
  return snap.docs.filter((d) => d.data().token).map((d) => ({ uid: d.id, token: d.data().token, ref: d.ref }));
}

// When the organizer turned player notifications off, send one copy of each notification to his devices only.
async function applyMode(msgs) {
  const cfg = await getConfig();
  if (cfg.pushMode !== "admin") return msgs;
  const p = await db.doc("admin/push").get();
  const toks = (p.exists && p.data().tokens) || [];
  const byTitle = new Map();
  for (const m of msgs) { const e = byTitle.get(m.title); if (e) e.n++; else byTitle.set(m.title, { m, n: 1 }); }
  const out = [];
  for (const { m, n } of byTitle.values()) for (const t of toks) {
    const note = n > 1 ? `(רק אצלך · היה נשלח ל-${n}, למשל: ${m.body})` : `(רק אצלך) ${m.body}`;
    out.push({ ...m, token: t, uid: "admin", ref: { delete: async () => {} }, title: "🔕 " + m.title, body: note });
  }
  return out;
}

// msgs: [{token, ref, title, body, link}]
async function sendAll(msgs) {
  msgs = await applyMode(msgs);
  const seen = new Set();
  msgs = msgs.filter((m) => !seen.has(m.token) && seen.add(m.token));
  for (let i = 0; i < msgs.length; i += 500) {
    const chunk = msgs.slice(i, i + 500);
    const res = await getMessaging().sendEach(chunk.map((m) => ({
      token: m.token,
      notification: { title: m.title, body: m.body },
      webpush: {
        notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png" },
        fcmOptions: { link: m.link || APP_URL },
      },
    })));
    await Promise.all(res.responses.map(async (r, j) => {
      if (!r.success) {
        const code = String((r.error && r.error.code) || "");
        console.error("send failed", chunk[j].uid, code);
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
          await chunk[j].ref.delete().catch(() => {});
        }
      }
    }));
  }
}

function gameLine(cfg) {
  const parts = [];
  if (cfg.gameAt) {
    const d = new Date(cfg.gameAt);
    const t = d.toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });
    const day = d.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long" });
    parts.push(`${day} ${t}`);
  } else if (cfg.game && (cfg.game.day || cfg.game.time)) {
    parts.push([cfg.game.day, cfg.game.time].filter(Boolean).join(" "));
  }
  if (cfg.game && cfg.game.place) parts.push(cfg.game.place);
  return parts.join(" · ");
}

// colors of an option's teams (same logic as the app)
function teamColors(opt, cfg) {
  const k = (opt.teams || []).length;
  const used = new Set(), out = [];
  const src = Array.isArray(opt.colors) ? opt.colors : [];
  const base = Array.isArray(cfg.colors) ? cfg.colors : [];
  for (let i = 0; i < k; i++) { const c = src[i]; if (Number.isInteger(c) && c >= 0 && c < COLORS.length && !used.has(c)) { out.push(c); used.add(c); } else out.push(null); }
  for (let i = 0; i < k; i++) if (out[i] == null) {
    let c = base[i]; if (!Number.isInteger(c) || used.has(c) || c >= COLORS.length) { c = 0; while (used.has(c)) c++; }
    out[i] = c; used.add(c);
  }
  return out;
}

// ---------- 1. moved up from the waitlist ----------
async function syncWaitlist() {
  const cfg = await getConfig();
  const cap = Number(cfg.capacity) || 18;
  const list = await getSignups();
  const active = list.slice(0, cap), waiting = list.slice(cap);
  const stateRef = db.doc("state/lists");
  const promoted = await db.runTransaction(async (tx) => {
    const st = await tx.get(stateRef);
    const prevWaiting = new Set(st.exists ? st.data().waiting || [] : []);
    tx.set(stateRef, { active: active.map((s) => s.id), waiting: waiting.map((s) => s.id), at: Date.now() });
    return active.filter((s) => prevWaiting.has(s.id));
  });
  if (!promoted.length) return;
  const toks = await tokensFor(promoted.map((p) => p.uid));
  const msgs = [];
  for (const p of promoted) {
    const t = toks.find((x) => x.uid === p.uid); if (!t) continue;
    const guest = !!p.guestOf;
    msgs.push({ ...t,
      title: guest ? "🎉 האורח שלך נכנס!" : "🎉 התפנה מקום, אתה בפנים!",
      body: guest ? `${p.name} עלה מרשימת ההמתנה לכדורגל ⚽` : `${p.name}, עלית מרשימת ההמתנה. נתראה במגרש ⚽` });
  }
  await sendAll(msgs);
}
exports.onSignupChange = onDocumentWritten("signups/{id}", syncWaitlist);

// ---------- 2. registration opened ----------
async function announceOpen(cfg, key) {
  const ref = db.doc("state/notify");
  const fresh = await db.runTransaction(async (tx) => {
    const st = await tx.get(ref);
    if (st.exists && st.data().openKey === key) return false;
    tx.set(ref, { openKey: key, openAt: Date.now() }, { merge: true });
    return true;
  });
  if (!fresh) return;
  const line = gameLine(cfg);
  const toks = await allTokens();
  await sendAll(toks.map((t) => ({ ...t,
    title: "🔓 ההרשמה לכדורגל נפתחה!",
    body: `${cfg.capacity || 18} מקומות, כל הקודם זוכה` + (line ? ` · ${line}` : "") })));
}

exports.onConfigChange = onDocumentUpdated("config/main", async (event) => {
  const before = event.data.before.data() || {}, after = event.data.after.data() || {};
  if ((before.capacity || 18) !== (after.capacity || 18)) await syncWaitlist();
  // opened by hand
  if (!before.open && after.open) await announceOpen(after, "manual:" + Date.now());
});

// auto-open at the scheduled time (checked every minute)
exports.checkAutoOpen = onSchedule({ schedule: "every 1 minutes", timeZone: "Asia/Jerusalem" }, async () => {
  const cfg = await getConfig();
  if (cfg.openAt && Date.now() >= cfg.openAt && Date.now() - cfg.openAt < 6 * 3600 * 1000) {
    await announceOpen(cfg, "auto:" + cfg.openAt);
  }
});

// ---------- 3. teams published / votes opened ----------
exports.onTeamsChange = onDocumentUpdated("teams/current", async (event) => {
  const b = event.data.before.data() || {}, a = event.data.after.data() || {};
  const opts = Array.isArray(a.options) ? a.options : [];
  if (!opts.length) return;
  const cfg = await getConfig();
  const cap = Number(cfg.capacity) || 18;
  const signups = await getSignups();
  const byName = new Map(signups.map((s) => [norm(s.name), s]));
  const link = APP_URL + "#teams";

  // teams were set (final)
  if (a.status === "final" && (b.status !== "final" || b.at !== a.at)) {
    const opt = opts[a.chosen ?? 0] || opts[0];
    const colors = teamColors(opt, cfg);
    const who = [];
    (opt.teams || []).forEach((t, i) => {
      (t.players || []).concat(t.subs || []).forEach((n) => { const s = byName.get(norm(n)); if (s) who.push({ s, color: COLORS[colors[i]], sub: (t.subs || []).includes(n) }); });
    });
    const toks = await tokensFor(who.map((w) => w.s.uid));
    const msgs = [];
    for (const w of who) {
      const t = toks.find((x) => x.uid === w.s.uid); if (!t) continue;
      const mine = w.s.guestOf ? `האורח שלך ${w.s.name} ב${w.color}` : `אתה ב${w.color}${w.sub ? " (מחליף)" : ""}`;
      msgs.push({ ...t, link, title: "⚽ הכוחות להשבוע פורסמו!", body: mine });
    }
    await sendAll(msgs);
  }

  // teams vote opened
  if (a.status === "voting" && (b.status !== "voting" || b.at !== a.at)) {
    const toks = await tokensFor(signups.slice(0, cap).map((s) => s.uid));
    await sendAll(toks.map((t) => ({ ...t, link, title: "🗳️ הצבעה על הכוחות!", body: "אופציה א׳ או אופציה ב׳? היכנס להצביע" })));
  }

  // MVP vote opened
  if (a.mvpOpen && !b.mvpOpen) {
    const opt = opts[a.chosen ?? 0] || opts[0];
    const names = (opt.teams || []).flatMap((t) => (t.players || []).concat(t.subs || []));
    const uids = names.map((n) => (byName.get(norm(n)) || {}).uid);
    const toks = await tokensFor(uids);
    await sendAll(toks.map((t) => ({ ...t, link, title: "⭐ מי ה-MVP של הערב?", body: "היכנס והצבע לשחקן הטוב ביותר" })));
  }
});
