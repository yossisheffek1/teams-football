// Push notifications for the weekly football app.
const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
// push tokens of one organizer's own devices (by Google email)
async function deviceTokens(email) {
  email = String(email || "").toLowerCase();
  if (!email) return [];
  const p = await db.doc("admin/push").get();
  const devs = (p.exists && p.data().devices) || [];
  return [...new Set(devs.filter((d) => d && d.token && String(d.email || "").toLowerCase() === email).map((d) => d.token))];
}
async function ownerEmail() {
  const o = await db.doc("owner/admins").get();
  return o.exists ? String(o.data().owner || "").toLowerCase() : "";
}

async function applyMode(msgs) {
  const cfg = await getConfig();
  if (cfg.pushMode !== "admin" && cfg.pushMode !== "select") return msgs;
  const toks = await deviceTokens(await ownerEmail());   // "only me" = the main organizer's phones only
  let chosen = [];
  if (cfg.pushMode === "select") {
    const t = await db.doc("admin/pushTest").get();
    const uids = new Set((t.exists && t.data().uids) || []);
    chosen = msgs.filter((m) => uids.has(m.uid));   // chosen testers get their normal notification
  }
  const byTitle = new Map();
  for (const m of msgs) { const e = byTitle.get(m.title); if (e) e.n++; else byTitle.set(m.title, { m, n: 1 }); }
  const out = [];
  for (const { m, n } of byTitle.values()) for (const t of toks) {
    const note = n > 1 ? `(רק אצלך · היה נשלח ל-${n}, למשל: ${m.body})` : `(רק אצלך) ${m.body}`;
    out.push({ ...m, token: t, uid: "admin", ref: { delete: async () => {} }, title: "🔕 " + m.title, body: note });
  }
  return chosen.concat(out);
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

// ---------- 4. payments ----------
// someone paid for the pitch and asked everyone on the list to pay them back
exports.onPaymentChange = onDocumentWritten("payments/current", async (event) => {
  const b = (event.data.before && event.data.before.data()) || {};
  const a = (event.data.after && event.data.after.data()) || {};
  if (!a.payer) return;
  const cfg = await getConfig();
  const cap = Number(cfg.capacity) || 18;
  const active = (await getSignups()).slice(0, cap);
  const price = Number(a.price) || Number(cfg.price) || 0;

  if (!b.payer || b.at !== a.at) {
    const toks = await tokensFor(active.map((s) => s.uid).filter((u) => u !== a.payer.uid));
    await sendAll(toks.map((t) => ({ ...t,
      title: `💳 ${a.payer.name} שילם על המגרש`,
      body: `${price}₪ לשחקן · היכנס לשלם או לסמן שהבאת מזומן` })));
  }

  if (a.remindAt && a.remindAt !== b.remindAt) {
    const marks = await db.collection("payMarks").get();
    const paid = new Set(marks.docs.map((d) => d.id).concat(a.paid || []));
    const unpaid = active.filter((s) => !paid.has(s.id) && s.uid !== a.payer.uid);
    const toks = await tokensFor(unpaid.map((s) => s.uid));
    await sendAll(toks.map((t) => ({ ...t,
      title: "⏰ תזכורת תשלום לכדורגל",
      body: `עוד לא סימנת ששילמת ${price}₪ ל${a.payer.name}` })));
  }
});

// a player marked that he paid -> tell the person who paid for the pitch
exports.onPayMark = onDocumentWritten("payMarks/{id}", async (event) => {
  const b = event.data.before && event.data.before.data();
  const a = event.data.after && event.data.after.data();
  if (!a || (b && b.m === a.m) || !["bit", "cash"].includes(a.m)) return;
  const p = await db.doc("payments/current").get();
  const pay = p.exists ? p.data() : null;
  if (!pay || !pay.payer || a.by === pay.payer.uid) return;
  const su = await db.doc(`signups/${event.params.id}`).get();
  const name = su.exists ? su.data().name : "שחקן";
  const toks = await tokensFor([pay.payer.uid]);
  const price = Number(pay.price) || 0;
  await sendAll(toks.map((t) => ({ ...t,
    title: a.m === "cash" ? `💵 ${name} הביא לך מזומן` : `💳 ${name} שילם לך בביט`,
    body: `${price}₪ על המגרש · אפשר לראות מי עוד לא שילם באפליקציה` })));
});


// ---------- 5. team split for co-organizers ----------
// Co-organizers can't read the ratings, so the server balances the teams with them.
const DEF_RATING = 4;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function sizesFor(n, k) { const b = Math.floor(n / k), e = n % k; return Array.from({ length: k }, (_, i) => b + (i < e ? 1 : 0)); }
function balance(players, k, apart) {
  k = Math.max(1, Math.min(k, players.length));
  const sizes = sizesFor(players.length, k);
  const desc = (a, b) => b.r - a.r;
  const allGK = shuffle(players.filter((p) => p.gk)).sort(desc);
  const gks = allGK.slice(0, k), rest = shuffle(players.filter((p) => !p.gk).concat(allGK.slice(k).map((p) => ({ ...p, gk: false })))).sort(desc);
  const teams = sizes.map(() => []);
  shuffle([...Array(k).keys()]).slice(0, gks.length).forEach((t, i) => teams[t].push(gks[i]));
  let idx = 0, fwd = true;
  const step = () => { if (fwd) { if (idx === k - 1) fwd = false; else idx++; } else { if (idx === 0) fwd = true; else idx--; } };
  for (const p of rest) { let g = 0; while (teams[idx].length >= sizes[idx] && g++ < k * 3) step(); teams[idx].push(p); step(); }
  const pairs = (apart || []).map((x) => [norm(x.a), norm(x.b)]);
  const avg = players.reduce((a, p) => a + p.r, 0) / players.length;
  const sum = (t) => t.reduce((a, p) => a + p.r, 0);
  const cost = () => {
    let c = teams.reduce((a, t) => a + (sum(t) - t.length * avg) ** 2, 0);
    if (pairs.length) for (const t of teams) { const ns = new Set(t.map((p) => norm(p.name))); for (const [a, b] of pairs) if (ns.has(a) && ns.has(b)) c += 1000; }
    return c;
  };
  let c = cost();
  for (let it = 0; it < 5000 && k > 1; it++) {
    const a = Math.floor(Math.random() * k); let b = Math.floor(Math.random() * (k - 1)); if (b >= a) b++;
    const i = Math.floor(Math.random() * teams[a].length), j = Math.floor(Math.random() * teams[b].length);
    if (!!teams[a][i].gk !== !!teams[b][j].gk) continue;
    [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
    const nc = cost(); if (nc <= c + 1e-9) c = nc; else [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
  }
  return shuffle(teams).map((t) => t.map((p) => p.name).sort((x, y) => x.localeCompare(y, "he")));
}
function buildOption(main, subs, k, apart) {
  const r = new Map(main.concat(subs).map((p) => [p.name, p.r]));
  const T = balance(main, k, apart).map((ps) => ({ players: ps, subs: [] }));
  const sum = (t) => t.players.concat(t.subs).reduce((a, n) => a + (r.get(n) || DEF_RATING), 0);
  subs.slice().sort((a, b) => b.r - a.r).forEach((p) => {
    let best = 0;
    T.forEach((t, i) => { const b = T[best]; if (t.subs.length < b.subs.length || (t.subs.length === b.subs.length && sum(t) < sum(b))) best = i; });
    T[best].subs.push(p.name);
  });
  return { teams: T, gks: main.concat(subs).filter((p) => p.gk).map((p) => p.name) };
}
const canon = (opt) => opt.teams.map((t) => t.players.slice().sort().join("|")).sort().join("||");
function violations(opt, apart) {
  let v = 0; for (const t of opt.teams) { const ns = new Set(t.players.map(norm)); for (const p of apart || []) if (ns.has(norm(p.a)) && ns.has(norm(p.b))) v++; } return v;
}

exports.makeTeams = onCall(async (req) => {
  const email = req.auth && req.auth.token && req.auth.token.email_verified && String(req.auth.token.email).toLowerCase();
  const own = await db.doc("owner/admins").get();
  const o = own.exists ? own.data() : {};
  const allowed = [String(o.owner || "").toLowerCase()].concat((o.emails || []).map((e) => String(e).toLowerCase()));
  if (!email || !allowed.includes(email)) throw new HttpsError("permission-denied", "not an organizer");

  const cfg = await getConfig();
  const cap = Number(cfg.capacity) || 18;
  const list = await getSignups();
  const active = list.slice(0, cap);
  if (active.length < 2) throw new HttpsError("failed-precondition", "not enough players");
  const rd = await db.doc("ratings/main").get();
  const roster = rd.exists ? rd.data().list || [] : [];
  const ap = await db.doc("admin/apart").get();
  const apart = ap.exists ? ap.data().list || [] : (rd.exists ? rd.data().apart || [] : []);
  const info = (name) => { const r = roster.find((x) => norm(x.n) === norm(name)); return { name, r: r ? r.r : DEF_RATING, gk: !!(r && r.gk) }; };
  const subIds = new Set(Array.isArray(req.data && req.data.subs) ? req.data.subs : []);
  const main = active.map((s) => info(s.name));
  const subs = list.slice(cap).filter((s) => subIds.has(s.id)).map((s) => info(s.name));
  const k = Math.min(Number(cfg.numTeams) || 3, active.length);
  const a = buildOption(main, subs, k, apart); let b = null;
  for (let t = 0; t < 60 && !b; t++) { const c = buildOption(main, subs, k, apart); if (canon(c) !== canon(a)) b = c; }
  const doc = { at: Date.now(), options: b ? [a, b] : [a], status: "draft", chosen: null, mvpOpen: false, mvp: null };
  await db.doc("teams/current").set(doc);
  return { options: doc.options.length, bad: violations(a, apart) + (b ? violations(b, apart) : 0) };
});


// ---------- 6. test notification (organizers only) ----------
async function isOrganizer(req) {
  const email = req.auth && req.auth.token && req.auth.token.email_verified && String(req.auth.token.email).toLowerCase();
  const own = await db.doc("owner/admins").get();
  const o = own.exists ? own.data() : {};
  const allowed = [String(o.owner || "").toLowerCase()].concat((o.emails || []).map((e) => String(e).toLowerCase()));
  return !!email && allowed.includes(email);
}
exports.testPush = onCall(async (req) => {
  if (!(await isOrganizer(req))) throw new HttpsError("permission-denied", "not an organizer");
  const uids = Array.isArray(req.data && req.data.uids) ? req.data.uids.slice(0, 50) : [];
  const caller = req.auth.token.email;
  const mine = (await deviceTokens(caller)).map((t) => ({ uid: "admin", token: t, ref: { delete: async () => {} } }));
  const others = await tokensFor(uids);
  const msgs = mine.concat(others).map((t) => ({ ...t, title: "🧪 בדיקת התראות", body: "אם אתה רואה את זה, ההתראות עובדות ✅" }));
  // bypass the notification mode: this is an explicit test
  const seen = new Set(), list = msgs.filter((m) => !seen.has(m.token) && seen.add(m.token));
  if (list.length) {
    await getMessaging().sendEach(list.map((m) => ({ token: m.token, notification: { title: m.title, body: m.body },
      webpush: { notification: { icon: APP_URL + "icon-192.png" }, fcmOptions: { link: APP_URL } } })));
  }
  return { sent: list.length };
});

// ---------- anonymous rating survey ----------
// Every vote recomputes the averages from scratch. Only the average and the number of raters per player are stored.
async function aggregateSurvey() {
  const sv = await db.doc("survey/current").get();
  if (!sv.exists) return;
  const { round, names = [], max = 7 } = sv.data();
  const keys = new Set(names.map(norm));
  const snap = await db.collection("surveyVotes").where("round", "==", round).get();
  const sum = {};
  snap.docs.forEach((d) => {
    const r = d.data().r || {};
    for (const [k, v] of Object.entries(r)) {
      const n = Number(v);
      if (!keys.has(k) || !(n >= 1 && n <= max)) continue;
      (sum[k] = sum[k] || { s: 0, n: 0 }).s += n; sum[k].n++;
    }
  });
  const avg = {};
  for (const [k, { s, n }] of Object.entries(sum)) avg[k] = { a: Math.round((s / n) * 100) / 100, n };
  await db.doc("survey/results").set({ round, avg, voters: snap.size, at: Date.now() });
}
exports.onSurveyVote = onDocumentWritten("surveyVotes/{id}", aggregateSurvey);

exports.onSurveyChange = onDocumentWritten("survey/current", async (event) => {
  const b = (event.data.before && event.data.before.exists && event.data.before.data()) || {};
  const a = (event.data.after && event.data.after.exists && event.data.after.data()) || {};
  if (a.open && (!b.open || b.round !== a.round)) {
    await db.doc("survey/results").set({ round: a.round, avg: {}, voters: 0, at: Date.now() });
    const toks = await allTokens();
    await sendAll(toks.map((t) => ({ ...t,
      title: "⭐ סקר דירוגים אנונימי",
      body: "דרגו את השחקנים כדי שהכוחות יהיו מאוזנים. אף אחד לא רואה מה דירגתם.",
      link: APP_URL + "#survey" })));
  }
});
