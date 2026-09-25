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
- **File storage**: Firebase Storage, same project — Documents (NDA/Contract/Interconnection forms/Others) on Customer and Partner records. Chosen over Google Drive specifically because it needed no separate OAuth flow and reuses the exact same "signed-in users only" access rule as Firestore.
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
- `prospects` — {name, side (Customer|Provider), website, countries[], source (LEAD_SOURCES), owner, contacts[], documents[...], instantlyStatus (''|'Synced' — set by `uploadProspectsToInstantly`), instantlySyncedAt, createdAt}. Cold, not-yet-qualified contacts sourced for outbound campaigns (uploaded to Instantly for intro emails) — deliberately lighter than Leads (no stage/interests/value, those are pipeline concepts that apply once qualified). "Convert to Lead" (`convertProspect()`) promotes one, identical pattern to `convertLead()`. See "Instantly integration" below.
- `leads` — {name, side (Customer|Provider), website, countries[], interests[] (API names — multi-select, own editor section like Countries), stage, owner, next, value, source (LEAD_SOURCES — fixed list, not free text), contacts[], documents[{id,category,name,url,path,uploadedBy,uploadedAt}], createdAt}
- `customers` — {name, industry, website, countries[], status, owner, apis[], arr, contacts[], documents[{id,category,name,url,path,uploadedBy,uploadedAt}], createdAt}
- `providers` — {name, kind (Mobile Operator|Wholesale), country, network, users, status, owner, coverage[{country,operator,apiFlags[N]}], apis[N] (derived — never edited directly, recomputed from coverage on save), contacts[], documents[{id,category,name,url,path,uploadedBy,uploadedAt}], createdAt}
- `partners` — {name, kicker (Aggregator|Alliance|Technology|Reseller), website, status, owner, share, joint, since, body, intros[{name,side,country,industry,stage,note}], contacts[], documents[{id,category,name,url,path,uploadedBy,uploadedAt}], createdAt}
- `logEntries` — the relationship log, shared across all four record types: {recordType, recordId, parentId (null or another entry's id — makes threads), kind (Note|Call|Email|Commercial), author, initials, text, follow (bool), followDate, followDone (bool), closedOn, createdAt}
- `settings` — one doc, `settings/config`: {apis: string[], team: [{name, email}]}. Backs the Settings page; see below.
- `materials` — the Materials library (see below), a standalone collection not tied to any other record: {name, cat, kind, format, size, url, fileUrl, path, lang, industry, version, updated, owner, note, createdAt}.

Contacts/coverage/intros are arrays embedded directly on the parent doc (not
subcollections) — matches the design's "everything saves together in the edit
sheet" behavior. `apis` on a provider is **derived**: `computeApis(coverage)`
recomputes it from the per-market `apiFlags` every time coverage is saved.

**Documents** (all four record types now, shown in the right column below
the details sheet) work a little differently: unlike everything else,
uploads/removals write immediately rather than waiting for the edit modal's
"Save changes" — a file picker doesn't fit that deferred-save pattern. The
actual bytes go to Firebase Storage at `docs/{type}/{id}/{timestamp}_{filename}`;
only the metadata (`documents[]` above) lives on the Firestore record.
`DOC_CATEGORIES` (top of `index.html`) is the fixed list: NDA, Contract,
Interconnection forms, Others.

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
- The `followDate` on any open follow-up is a plain `<input type="date">` inline (both on Today's list and on the record page's log) — `updateFollowDate(entryId, newDate)` writes it straight through, no confirm needed, since rescheduling isn't destructive.

## Lead conversion
"Convert to Customer" / "Convert to Provider" on a lead's record page (label
depends on `lead.side`) — `window.convertLead()`:
1. Creates a new customer/provider doc, carrying over `name`, `owner`,
   `contacts`, `documents`, and (customers only) `website`/`countries`/an
   `apis` entry seeded from `interest`.
2. Copies the lead's relationship log to the new record via
   `copyLogEntries()`, remapping `parentId` links to the new entries' ids
   (old ids don't exist in the new context) — thread structure and original
   timestamps/authorship survive.
3. Deletes the lead and its original log entries (now duplicated on the new
   record) so nothing is left both duplicated and orphaned.
Confirm-guarded, since step 3 is irreversible. Provider conversion is fairly
bare (no coverage yet, `country` from the first entry in `countries[]` if
any) — expect to fill in Coverage manually afterward.

## Countries of interest (Leads, Customers)
`AMERICAS_COUNTRIES` (top of `index.html`) is a fixed checklist of the 35
sovereign states of the Americas — a dedicated section in the edit modal
(`countriesEditorHTML()`), not a free-text field, so the data stays clean
enough to eventually build a "prospects by country" report from. Both types
store it the same way (`countries: string[]`); providers/partners keep a
single `country` string instead (one home market, not a market list).
`recordCountryLabel(type, rec)` is the one place that reads either shape —
use it for any cross-type display rather than reaching for `.country`
directly on a lead.

A lead's **interests** (which of the tracked APIs it's after) is the same
pattern, one level simpler: `interests: string[]` with its own editor
section (`interestsEditorHTML()`, `toggleEditInterest()`), checkboxes over
`APIS` rather than a fixed list of its own. On conversion to a Customer,
`interests` seeds that customer's `apis` (in use) directly.

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
1. **Today** — stat strip (follow-ups open/overdue, due this week, open pipeline, providers pending, silent accounts) + pending follow-ups list + accounts with no logged activity, all scoped by the Account manager filter. Rolls up across all five record types, including Prospects.
2. **Prospects** — table, filters by side + source. Feeds the Instantly integration (see below); "Convert to Lead" once one engages.
3. **Leads** — table, filters by side + stage.
4. **Customers** — table, filters by industry.
5. **Providers** — table with one column per API, showing each provider's headline status per API (Live/Contracting/Testing/Prospect/—, collapsed across all its markets by `computeApis()`), filters by kind/status/API.
6. **API coverage** — one row per country+operator (derived from every provider's `coverage`), same filters as Providers, showing that specific operator's actual per-API status. Answers "who can serve SIM Swap in Germany, and through whom, and what stage is that specific relationship at."
7. **Partners** — card grid, filters by role (kicker).
8. **Materials** — a shared library of files/links (decks, templates, rate cards, docs portal) grouped by category, in `NAV` like the other seven. See its own section below.
9. **Record page** (shared by prospects/leads/customers/providers/partners) — header with AM reassign (writes a system log entry) and Delete (confirm-guarded), stat strip, contact list + field sheet on the right, coverage/intros table (provider/partner only) + relationship log on the left.
10. **Edit modal** — per-type fields, plus a coverage editor (a status dropdown per API per market row — see `MARKET_STATUSES`) for providers, intros editor for partners, contacts editor for all types.
11. **Settings** — separate from the main views (sidebar footer link, not in `NAV`) — edits `settings/config` (see above).

## Instantly integration (live)
Uploads Prospects to Instantly for intro-email campaigns, and imports all email
communication to/from `michael@teligenlabs.com` back into the matching
Prospect's (or Lead's, post-conversion) relationship log as `kind:'Email'`
entries. Deployed to the `teligen-crm` Firebase project, region `us-central1`.
- **Architecture**: Firebase Cloud Functions (`functions/index.js`), not
  client-side calls. Instantly's own docs explicitly warn their API key must
  never be exposed client-side or committed to version control — this app is
  a public static site (GitHub Pages), so the key lives only server-side, as
  the `INSTANTLY_API_KEY` Cloud Functions secret (`firebase functions:secrets:set`).
  The client calls narrow, Auth-gated (`@011global.com`/`@011telecom.com` only)
  callable functions via `callInstantlyFn()` in `index.html`; it never talks
  to Instantly directly.
- **`listInstantlyCampaigns`** (callable) — `GET /campaigns?search=Teligen`,
  further filtered server-side to names matching `/teligen/i`. The Instantly
  workspace has campaigns for other companies too, so this is the only list
  ever surfaced to the CRM. Backs the campaign picker in the "Sync to
  Instantly" modal on a Prospect's record page.
- **`uploadProspectsToInstantly`** (callable) — `POST /leads/add` with a
  `campaign_id` (or `list_id`) and the given prospects' first contact as the
  lead (email/name/company/website). Sets `instantlyStatus: 'Synced'` +
  `instantlySyncedAt` on each uploaded prospect. Triggered from the "Sync to
  Instantly" button on a Prospect's record page (`openInstantlySync()` /
  `confirmInstantlySync()` in `index.html`); currently uploads one prospect
  at a time (whichever record is open), not a bulk multi-select.
- **`syncInstantlyEmails`** (scheduled, every 30 min) — polls
  `GET /emails?eaccount=michael@teligenlabs.com&min_timestamp_created=...`
  since the last run (cursor kept in `settings/instantlySync`), matches each
  email's from/to address against every existing record's first contact email
  (Prospects, Leads, Customers, Providers, Partners — `buildEmailIndex()`,
  loaded fresh into memory each run, fine at this scale), and writes a
  `logEntries` doc (`kind:'Email'`) on the first match. Dedupes via
  `instantlyId` on the log entry, so overlapping timestamp windows across
  runs never double-log. Capped at 20 pages (2000 emails) per run; a very
  large backfill on first run continues across subsequent runs since the
  cursor only advances by what was actually processed. It does **not**
  create new records for an unmatched address — see the next function for
  that direction.
- **`syncInstantlyLeadsToProspects`** (scheduled, every 30 min) — the reverse
  direction: for every Teligen campaign (`getTeligenCampaigns()`, shared with
  `listInstantlyCampaigns`), pages through `POST /leads/list` and creates a
  new `prospects` doc for any lead email not already in `buildEmailIndex()`
  (Customer side by default, source `'Cold outreach'`, owner `'Unassigned'`,
  `instantlyStatus:'Synced'`, `instantlyLeadId` + `instantlyCampaign` kept for
  reference). So a lead created directly in Instantly — not uploaded from
  here — shows up as a Prospect in the CRM within 30 min, no manual step.
  No time-based cursor (the list-leads endpoint has none to filter by), so
  every run re-scans full campaigns; cost is one dedupe-map lookup per lead,
  capped at 20 pages (2000 leads) per campaign per run.
- **Local tooling note**: this machine's global npm cache is broken and the
  global install path needs sudo, so there's no bare `firebase` command —
  every Firebase CLI call goes through
  `npm_config_cache=/tmp/npm-cache-fix npx --yes firebase-tools@latest <command>`.
- **Not yet built**: a bulk "sync selected prospects" action from the
  Prospects list view (today it's per-record only) and a `listId` alternative
  in the sync modal (only `campaignId` is wired up client-side, though the
  function supports either).

## Materials library
A standalone `materials` collection — not attached to any lead/customer/
provider/partner. Built from a separate design handoff
(`design_handoff_materials/` under Downloads when this was built) covering
just this one section plus shell chrome.

- Add row writes immediately (no edit modal): a name and/or a pasted link,
  a category (`MATERIAL_CATEGORIES`, fixed display order: Legal,
  Presentation, One pager, Pricing, Marketing), a language
  (`MATERIAL_LANGS`), and a description.
- **`url` vs `fileUrl` — kept deliberately separate.** `url` is only ever a
  *pasted* shareable link (Drive, docs portal, sandbox signup) — it drives
  `hasUrl` (Open link / Copy link, the "Links only" filter, the visible URL
  line under the description) and the whole "Shareable links" stat. `fileUrl`
  is only the Storage download link for an uploaded file, and only drives
  the Download button. A material can have either, both (a deck with a
  Drive link), or neither yet (a typed placeholder name with nothing
  attached). Conflating the two was an actual bug caught in testing — an
  uploaded PDF was showing up under "Links only" until they were split.
- Uploads go to Firebase Storage at `materials/{timestamp}_{filename}`
  (own path prefix, separate from `docs/{type}/{id}/...` used by the
  Documents section on records) — same bucket, no separate setup.
- **Format** for an uploaded file is its extension, uppercased, truncated to
  4 characters (`PDF`, `DOCX`, ...); a pasted link with no file and a
  dot-free name becomes `format: 'LINK'`. Typing a plain name with neither
  a real file nor a dot still creates an entry (format `FILE`) — it has no
  `fileUrl` yet, so no Download button shows until a real file is attached
  later (not yet built — see the design handoff's "open decisions" #1).
- **Freshness**: `isFreshMaterial()` — `updated` within `MATERIALS_FRESH_DAYS`
  (45) earns a "Recently updated" tag and counts toward that stat cell.
- Only the description edits inline (`startEditMaterialNote` /
  `saveMaterialNote`) — category/language/version aren't editable yet, per
  the design handoff's open decisions; re-add via Remove + re-add for now.
- Sort: fixed category order, then `updated` descending within each
  category (`computeMaterialsRows()`).

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
