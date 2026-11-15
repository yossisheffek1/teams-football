// Service worker for push notifications (Firebase Cloud Messaging)
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD_FM3NMjHcRcTnz2WIEgvBVkc8tdMiXu4",
  authDomain: "teams-football.firebaseapp.com",
  projectId: "teams-football",
  storageBucket: "teams-football.firebasestorage.app",
  messagingSenderId: "175983615125",
  appId: "1:175983615125:web:60a493fe62943970fbcf9c"
});

// Delivery receipt: tell the server this notification reached the phone (✓✓ for the organizer).
const ACK_URL = "https://europe-west1-teams-football.cloudfunctions.net/pushAck";
self.addEventListener("push", (e) => {
  try {
    const p = e.data ? e.data.json() : null;
    const d = (p && p.data) || {};
    if (d.lid && d.k) {
      e.waitUntil(fetch(`${ACK_URL}?l=${encodeURIComponent(d.lid)}&k=${encodeURIComponent(d.k)}`, { mode: "no-cors", keepalive: true }).catch(() => {}));
    }
  } catch (err) {}
});

// Messages are sent with a `notification` payload, so the SDK shows them itself.
firebase.messaging();
