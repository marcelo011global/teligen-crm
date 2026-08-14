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
- Production: https://crm.teligen.ai (GitHub Pages, once DNS + repo are set up — see README.md)
- Until then: open `index.html` directly, or serve it locally — runs in DEMO_MODE (localStorage only, no Firebase needed).

## Tech Stack
- **Frontend**: Single HTML file (`index.html`) — vanilla JS, no framework, no build step
- **Database**: Firebase Firestore — **own project**, not `telecom-deals-f155b`. See README.md to create it.
- **Auth**: Firebase Auth — Email/Password + Google Sign-In, restricted to `@011global.com` / `@011telecom.com`
- **Hosting**: GitHub Pages, custom domain `crm.teligen.ai` (see `CNAME`) — a `CNAME` DNS record for host `crm` → `marcelo011global.github.io`. Note: `teligen.ai` may be a different registrar/DNS host than `teligen.io` (the main site) — check before assuming GoDaddy or Route 53.
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
- `providers` — {name, kind (Mobile Operator|Wholesale), country, network, users, status, owner, coverage[{country,operator,apiFlags[N]}], apis[N] (derived — never edited directly, recomputed from coverage on save), contacts[], createdAt}
- `partners` — {name, kicker (Aggregator|Alliance|Technology|Reseller), status, owner, share, joint, since, body, intros[{name,side,country,industry,stage,note}], contacts[], createdAt}
- `logEntries` — the relationship log, shared across all four record types: {recordType, recordId, parentId (null or another entry's id — makes threads), kind (Note|Call|Email|Commercial), author, initials, text, follow (bool), followDate, followDone (bool), closedOn, createdAt}
- `settings` — one doc, `settings/config`: {apis: string[], team: [{name, email}]}. Backs the Settings page; see below.

Contacts/coverage/intros are arrays embedded directly on the parent doc (not
subcollections) — matches the design's "everything saves together in the edit
sheet" behavior. `apis` on a provider is **derived**: `computeApis(coverage)`
recomputes it from the per-market `apiFlags` every time coverage is saved.

Each `coverage` row's `apiFlags[i]` is a **status string** — `''` (not
covered), `'Prospect'`, `'Testing'`, `'Contracting'`, or `'Live'` — one per
tracked API, per operator, in that market. This is deliberately the *same*
vocabulary as a provider's own `status` field, but the two are independent:
`status` is the overall commercial/onboarding stage with that provider,
while a coverage row's flags are the actual technical rollout for one API
with one specific operator. This is what lets a wholesale provider be Live
on an API through one operator and not offer that API at all through
another operator in the same country — each `{country, operator}` row
carries its own set of flags. `computeApis()` collapses a provider's rows
down to one headline status per API (highest-precedence match across all
its markets: Live > Contracting > Testing > Prospect > not covered) for the
Providers table and API-coverage filters.

`normFlags(row)` is the only thing that should ever read `apiFlags` — besides
padding short/legacy arrays out to the current `APIS.length`, it also
migrates the old pre-Settings numeric scheme (`0`=not covered, `1`=Live,
`2`=Planned, from before per-market statuses existed) into the new strings.

## Relationship log / follow-up threading
This is the trickiest piece and is ported conceptually from the deals
dashboard's `partners` / `partnerLogEntries` feature (same author/kind/
parentId/createdAt shape). Behavior:
- "Needs follow-up" on the composer sets `follow:true, followDate`.
- "Mark done" closes an entry in place: `follow:false, followDone:true, closedOn:today`.
- "Log outcome & reschedule" opens an inline reply composer under the entry. Posting it (a) closes the parent the same way, and (b) inserts a new entry with `parentId: <parent id>` and its own follow-up date. Children render indented by `depth * 26px`.
- The **Today** view's "Pending follow-ups" list is every entry across every record type where `follow && !followDone`, scoped by the header's Account manager filter, earliest `followDate` first.

## Team and tracked APIs
Both editable from the **Settings** page (link at the bottom of the sidebar)
instead of hardcoded — see the `settings` collection above. `TEAM_MEMBERS`/
`APIS` in `index.html` are just the seed defaults used the first time the app
runs, before Settings has saved anything; after that, Firestore is the
source of truth and every signed-in user sees the same lists live. Add
teammates there (name + sign-in email) so their activity attributes
correctly, and add/rename/remove tracked APIs there as Teligen's product
lineup changes — no code deploy needed for either.

## Dashboard Views
1. **Today** — stat strip (follow-ups open/overdue, due this week, open pipeline, providers pending, silent accounts) + pending follow-ups list + accounts with no logged activity, all scoped by the Account manager filter.
2. **Leads** — table, filters by side + stage.
3. **Customers** — table, filters by industry.
4. **Providers** — table with one column per API, showing each provider's headline status per API (Live/Contracting/Testing/Prospect/—, collapsed across all its markets by `computeApis()`), filters by kind/status/API.
5. **API coverage** — one row per country+operator (derived from every provider's `coverage`), same filters as Providers, showing that specific operator's actual per-API status. Answers "who can serve SIM Swap in Germany, and through whom, and what stage is that specific relationship at."
6. **Partners** — card grid, filters by role (kicker).
7. **Record page** (shared by all 4 types) — header with AM reassign (writes a system log entry) and Delete (confirm-guarded), stat strip, contact list + field sheet on the right, coverage/intros table (provider/partner only) + relationship log on the left.
8. **Edit modal** — per-type fields, plus a coverage editor (a status dropdown per API per market row — see `MARKET_STATUSES`) for providers, intros editor for partners, contacts editor for all types.
9. **Settings** — separate from the six main views (sidebar footer link, not in `NAV`) — edits `settings/config` (see above).

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
- `logo.png` — Teligen wordmark, used in the sidebar and sign-in screen.
- `CNAME` — GitHub Pages custom domain (crm.teligen.ai).
- `README.md` — setup steps (Firebase project, GitHub Pages, DNS).
- `CLAUDE.md` — this file.
