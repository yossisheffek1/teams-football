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

// Messages are sent with a `notification` payload, so the SDK shows them itself.
firebase.messaging();
