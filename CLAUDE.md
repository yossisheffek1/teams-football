# כדורגל שבועי – the organizer's private weekly-football app

Live: https://yossisheffek1.github.io/teams-football/ · Firebase project `teams-football`.
The owner (Yossi) is the organizer. He writes in Hebrew and uses an iPhone + MacBook; answer in Hebrew, short, mobile-friendly.
This is the app for his own group only. The public multi-group app is a separate repo (`frienldyz`, "Friendlyz") – don't mix them.

## Layout
- `src/app.js`, `src/style.css` – the real source. **Never edit `index.html` by hand.**
- `build.py` – run `python3 build.py` from the repo root; it writes `index.html` (single file, Firebase JS SDK 10.12.2 from gstatic).
- `firestore.rules` – security rules. The owner's email is the placeholder `__OWNER_EMAIL__`; GitHub Actions swaps it in from a secret.
- `functions/index.js` – Cloud Functions (Node 22, europe-west1, firebase-functions v2).
- `firebase-messaging-sw.js` – push service worker (reports delivery to `pushAck` for the ✓✓ log).

## Deploy
- Site: GitHub Pages serves `index.html` from `main`.
- Functions + rules: `.github/workflows/deploy-firebase.yml` deploys on push to `main` (secrets `FIREBASE_SERVICE_ACCOUNT`, `OWNER_EMAIL`). Check with `gh run list -R yossisheffek1/teams-football`.
- Always `git pull --rebase` before pushing.

## Rules that must not break
- Only the owner may see survey ratings/averages and who voted for whom (MVP, survey). Other organizers must not.
- Never commit the owner's email or any service-account key – this repo is public.
- Players sign in with phone (SMS); organizers with Google and link their phone.
- Canonical player name lives in `who/{uid}`.
