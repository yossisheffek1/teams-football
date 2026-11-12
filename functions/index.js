// Sends a push notification to players who move up from the waitlist.
const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
// Firestore is in eur3, whose matching functions region is europe-west1
setGlobalOptions({ region: "europe-west1", maxInstances: 3 });

const db = getFirestore();
const APP_URL = "https://yossisheffek1.github.io/teams-football/";

async function capacity() {
  const c = await db.doc("config/main").get();
  return (c.exists && Number(c.data().capacity)) || 18;
}

async function notify(players) {
  for (const p of players) {
    if (!p.uid || p.uid === "admin") continue;            // added by the organizer, no device
    const tokDoc = await db.doc(`tokens/${p.uid}`).get();
    if (!tokDoc.exists || !tokDoc.data().token) continue;
    const guest = !!p.guestOf;
    const title = guest ? "🎉 האורח שלך נכנס!" : "🎉 התפנה מקום, אתה בפנים!";
    const body = guest
      ? `${p.name} עלה מרשימת ההמתנה לכדורגל ⚽`
      : `${p.name}, עלית מרשימת ההמתנה. נתראה במגרש ⚽`;
    try {
      await getMessaging().send({
        token: tokDoc.data().token,
        notification: { title, body },
        webpush: {
          notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png" },
          fcmOptions: { link: APP_URL },
        },
      });
    } catch (e) {
      console.error("send failed", p.uid, e.code || e.message);
      if (String(e.code || "").includes("registration-token-not-registered")) await tokDoc.ref.delete();
    }
  }
}

// Compare the list with the last saved state; whoever was waiting and is now in gets a push.
async function sync() {
  const cap = await capacity();
  const snap = await db.collection("signups").orderBy("ts").get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const active = list.slice(0, cap), waiting = list.slice(cap);
  const stateRef = db.doc("state/lists");
  const promoted = await db.runTransaction(async (tx) => {
    const st = await tx.get(stateRef);
    const prevWaiting = new Set(st.exists ? st.data().waiting || [] : []);
    tx.set(stateRef, { active: active.map((s) => s.id), waiting: waiting.map((s) => s.id), at: Date.now() });
    return active.filter((s) => prevWaiting.has(s.id));
  });
  if (promoted.length) await notify(promoted);
}

exports.onSignupChange = onDocumentWritten("signups/{id}", sync);

exports.onCapacityChange = onDocumentUpdated("config/main", async (event) => {
  const before = event.data.before.data() || {}, after = event.data.after.data() || {};
  if ((before.capacity || 18) !== (after.capacity || 18)) await sync();
});
