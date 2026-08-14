# Teligen CRM

## Project Overview
A CRM for Teligen (teligen.io), a broker of GSMA Open Gateway / CAMARA network
APIs. Teligen buys API capacity from **Providers** (mobile operators and
wholesale aggregators) and sells it to **Customers** (fintechs, iGaming,
mobility, delivery), with **Partners** who introduce prospects, and **Leads**
covering both sides of the market. Four APIs are tracked: SIM Swap, Silent
Auth, KYC Match, Age Verification.

Sibling project to [011-deals-dashboard](https://github.com/marcelo011global/011-deals-dashboard)
(011 Telecom's deal tracker) — same author, same build philosophy (single
HTML file, vanilla JS, Firebase, GitHub Pages), same allowed sign-in domains,
but its own separate Firebase project so CRM data never touches deal data.

## Live URL
- Production: https://teligen.io (GitHub Pages, once DNS + repo are set up — see README.md)
- Until then: open `index.html` directly, or serve it locally — runs in DEMO_MODE (localStorage only, no Firebase needed).

## Tech Stack
- **Frontend**: Single HTML file (`index.html`) — vanilla JS, no framework, no build step
- **Database**: Firebase Firestore — **own project**, not `telecom-deals-f155b`. See README.md to create it.
- **Auth**: Firebase Auth — Email/Password + Google Sign-In, restricted to `@011global.com` / `@011telecom.com`
- **Hosting**: GitHub Pages, custom domain `teligen.io` (see `CNAME`)
- **Design system**: "Modernist" — `styles.css`, flat/architectural, Archivo type, single red accent `#ec3013`, zero border-radius, strong 2px rules. Do not hardcode colors/spacing/fonts outside `var(--*)` tokens already in that file.

## Firebase Config
Placeholder in `index.html` until a real project is created (see README.md
Setup — 1). While `firebaseConfig.apiKey === "REPLACE_ME"`, the app runs in
`DEMO_MODE`: a tiny abstraction (`dbAdd`/`dbUpdate`/`dbDelete`/`dbWatch`) swaps
between real Firestore calls and a localStorage-backed store with the same
shape, so every view/interaction is testable with zero setup. Nothing else in
the file needs to change when a real project is wired in.

## Firestore Collections
- `leads` — {name, side (Customer|Provider), country, interest (API name), stage, owner, next, value, source, contacts[], createdAt}
- `customers` — {name, industry, website, countries[], status, owner, apis[], arr, contacts[], createdAt}
- `providers` — {name, kind (Mobile Operator|Wholesale), country, network, users, status, owner, coverage[{country,operator,apiFlags[4]}], apis[4] (derived — never edited directly, recomputed from coverage on save), contacts[], createdAt}
- `partners` — {name, kicker (Aggregator|Alliance|Technology|Reseller), status, owner, share, joint, since, body, intros[{name,side,country,industry,stage,note}], contacts[], createdAt}
- `logEntries` — the relationship log, shared across all four record types: {recordType, recordId, parentId (null or another entry's id — makes threads), kind (Note|Call|Email|Commercial), author, initials, text, follow (bool), followDate, followDone (bool), closedOn, createdAt}

Contacts/coverage/intros are arrays embedded directly on the parent doc (not
subcollections) — matches the design's "everything saves together in the edit
sheet" behavior. `apis` on a provider is **derived**: `computeApis(coverage)`
recomputes it from the per-market `apiFlags` every time coverage is saved.

## Relationship log / follow-up threading
This is the trickiest piece and is ported conceptually from the deals
dashboard's `partners` / `partnerLogEntries` feature (same author/kind/
parentId/createdAt shape). Behavior:
- "Needs follow-up" on the composer sets `follow:true, followDate`.
- "Mark done" closes an entry in place: `follow:false, followDone:true, closedOn:today`.
- "Log outcome & reschedule" opens an inline reply composer under the entry. Posting it (a) closes the parent the same way, and (b) inserts a new entry with `parentId: <parent id>` and its own follow-up date. Children render indented by `depth * 26px`.
- The **Today** view's "Pending follow-ups" list is every entry across every record type where `follow && !followDone`, scoped by the header's Account manager filter, earliest `followDate` first.

## Team
`TEAM` (top of `index.html`'s script) is still the design prototype's
placeholder AM names (`L. Meyer`, `R. Costa`, `S. Haddad`, `M. Lima`,
`Unassigned`). Replace with Teligen's real account managers before real use —
it's a plain business-role list, decoupled from actual Firebase Auth accounts
(same pattern the design intentionally used).

## Dashboard Views
1. **Today** — stat strip (follow-ups open/overdue, due this week, open pipeline, providers pending, silent accounts) + pending follow-ups list + accounts with no logged activity, all scoped by the Account manager filter.
2. **Leads** — table, filters by side + stage.
3. **Customers** — table, filters by industry.
4. **Providers** — table with one column per API (Live/Planned/—), filters by kind/status/API.
5. **API coverage** — one row per country+operator (derived from every provider's `coverage`), same filters as Providers. Answers "who can serve SIM Swap in Germany, and through whom."
6. **Partners** — card grid, filters by role (kicker).
7. **Record page** (shared by all 4 types) — header with AM reassign (writes a system log entry), stat strip, contact list + field sheet on the right, coverage/intros table (provider/partner only) + relationship log on the left.
8. **Edit modal** — per-type fields, plus coverage editor (cycles Not covered → Live → Planned per API per market) for providers, intros editor for partners, contacts editor for all types.

## Open product decisions (carried over from the design handoff)
1. Provider/Partner overlap — companies like Sinch/Infobip that are both. Currently two separate records; could link them or add role flags to one company record.
2. Email sync — "Email" is a first-class log kind but nothing ingests real mail yet.
3. Follow-ups live on log entries, not as a separate task entity — fine until they need separate assignees/reminders.
4. Customer `apis` (in use) isn't reconciled against provider coverage — a customer could be sold an API with no live route.
5. No lead → Customer/Provider conversion flow yet.

## Deployment
```bash
git add .
git commit -m "description of change"
git push origin main
# GitHub Pages auto-deploys shortly after push
```

## Files
- `index.html` — entire frontend app.
- `styles.css` — Modernist design system tokens + components, verbatim from the design handoff.
- `CNAME` — GitHub Pages custom domain (teligen.io).
- `README.md` — setup steps (Firebase project, GitHub Pages, DNS).
- `CLAUDE.md` — this file.
