# Teligen CRM

A CRM for [Teligen](https://www.teligen.io), a broker of GSMA Open Gateway / CAMARA
network APIs (SIM Swap, Silent Auth, KYC Match, Age Verification). Tracks Leads,
Customers, Providers and Partners, with a shared relationship-log per record.

Design: the "Modernist" system (flat, Archivo type, single red accent, zero
corner radius) from the Claude-generated design handoff. `styles.css` is that
system's token sheet, unmodified.

Built the same way as 011 Telecom's [deal tracker dashboard](https://github.com/marcelo011global/011-deals-dashboard):
a single `index.html`, vanilla JS, no build step, Firebase Auth + Firestore,
deployed on GitHub Pages. The relationship-log (threaded follow-ups, kind tags,
"Mark done" / "Log outcome & reschedule") reuses that dashboard's `partners`
module pattern.

## Right now: demo mode

`index.html` ships with a placeholder Firebase config, so **it runs today with
zero setup** — open it (or visit the GitHub Pages URL once deployed) and it
signs you in automatically as "Demo User," storing everything in your
browser's `localStorage`. Nothing is shared between browsers or synced
anywhere. This is only for trying out the UI — don't build real pipeline data
in it.

To go live, follow the two setup steps below.

## Setup — 1. Firebase project

This is a **separate Firebase project** from the deals dashboard
(`telecom-deals-f155b`) — the deals data and this CRM's data never mix. "Same
users" means the same @011global.com / @011telecom.com people are allowed in,
via the same domain check, not a literally shared Auth user table — each
person creates one account here (can reuse the same email + password they use
elsewhere, Firebase won't know or care).

1. Go to the [Firebase console](https://console.firebase.google.com/) → **Add project** → name it e.g. `teligen-crm`.
2. **Build → Authentication → Get started** → enable **Email/Password** and **Google** sign-in providers.
3. **Build → Firestore Database → Create database** → start in production mode, pick a region.
4. **Project settings (gear icon) → General → Your apps → Add app → Web**. Register it (any nickname), copy the `firebaseConfig` object it gives you.
5. Paste those values into `index.html`, replacing the `firebaseConfig` block near the top of the `<script type="module">` (search for `REPLACE_ME`). Once `apiKey` is no longer `"REPLACE_ME"`, demo mode turns off automatically and the real sign-in screen appears.
6. Firestore security rules — lock reads/writes to signed-in users. In the Firestore console → **Rules**, use:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
   (The domain restriction already happens at sign-up in the app; this rule just keeps signed-out requests out of Firestore entirely.)

## Setup — 2. GitHub repo + hosting

1. Create a new empty GitHub repo, e.g. `marcelo011global/teligen-crm` (no README/gitignore — this folder already has one).
2. From this folder:
   ```
   git remote add origin https://github.com/marcelo011global/teligen-crm.git
   git push -u origin main
   ```
3. In the repo's **Settings → Pages**, set source to the `main` branch, `/` (root).
4. **Settings → Pages → Custom domain**: enter `teligen.io`. GitHub will show the DNS records to add (the `CNAME` file in this repo already has `teligen.io` in it, which is what makes GitHub Pages serve on that domain once DNS points there).
5. At your DNS provider for teligen.io, add the records GitHub's Pages settings page shows you (typically a few `A` records for the apex domain, or a `CNAME` record if pointing a subdomain like `crm.teligen.io`).

## Team

`TEAM` and the AM names are placeholders (`L. Meyer`, `R. Costa`, ...) carried
over from the design prototype — replace the `TEAM` constant near the top of
the script with Teligen's actual account managers before real use.

## Files

- `index.html` — the entire app (Firebase config, auth, all six views, record page, relationship log, edit/new modals).
- `styles.css` — the Modernist design system, verbatim from the design handoff.
- `CNAME` — GitHub Pages custom domain (`teligen.io`).
- `CLAUDE.md` — project notes for future Claude Code sessions.

## Data model / open decisions

See `CLAUDE.md` for the Firestore collection layout. The original design
handoff flagged a few product decisions still open (Provider/Partner overlap
for companies like Sinch/Infobip, email sync into the log, lead→Customer/
Provider conversion) — see the `design_handoff_teligen_crm` folder this was
built from for the full writeup.
