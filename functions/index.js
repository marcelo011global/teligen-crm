const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const {setGlobalOptions} = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const INSTANTLY_API_KEY = defineSecret('INSTANTLY_API_KEY');
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const ALLOWED_DOMAINS = ['011global.com', '011telecom.com'];
// Our own domains: a lead at one of these is a teammate/test address, never a prospect.
const INTERNAL_DOMAINS = ['011global.com', '011telecom.com', 'teligen.io', 'teligenlabs.com'];
// Instantly mailboxes whose sent/received mail gets imported into the CRM.
const SYNCED_EACCOUNTS = ['michael@teligenlabs.com', 'guillermo@teligen.io', 'guillermo@011global.com', 'marcelo@011global.com', 'marcelo@teligen.io'];
// Only Instantly campaigns whose name matches this are ever surfaced to the CRM —
// the workspace has campaigns for other companies too.
const CAMPAIGN_NAME_FILTER = /teligen/i;

setGlobalOptions({region: 'us-central1', maxInstances: 5});

function assertAuthorized(request) {
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!email) throw new HttpsError('unauthenticated', 'Sign in required.');
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    throw new HttpsError('permission-denied', 'Not authorized.');
  }
  return email;
}

function initialsFrom(name) {
  return (name || '').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('') || '?';
}

async function instantlyFetch(path, apiKey, options) {
  const res = await fetch(`${INSTANTLY_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options && options.headers),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new HttpsError('internal', `Instantly API error (${res.status}) on ${path}: ${errText.slice(0, 500)}`);
  }
  return res.json();
}

// Returns only the Instantly campaigns relevant to Teligen (name contains "teligen"),
// so the CRM never lists other companies' campaigns from the same Instantly workspace.
async function getTeligenCampaigns(apiKey) {
  const matches = [];
  let startingAfter;
  let pages = 0;
  const MAX_PAGES = 5;

  do {
    const params = new URLSearchParams({limit: '100', search: 'Teligen'});
    if (startingAfter) params.set('starting_after', startingAfter);
    const data = await instantlyFetch(`/campaigns?${params.toString()}`, apiKey);
    const items = data.items || [];
    for (const c of items) {
      if (CAMPAIGN_NAME_FILTER.test(c.name || '')) {
        matches.push({id: c.id, name: c.name, status: c.status});
      }
    }
    startingAfter = data.next_starting_after;
    pages++;
  } while (startingAfter && pages < MAX_PAGES);

  return matches;
}

exports.listInstantlyCampaigns = onCall({secrets: [INSTANTLY_API_KEY]}, async (request) => {
  assertAuthorized(request);
  const campaigns = await getTeligenCampaigns(INSTANTLY_API_KEY.value());
  return {campaigns};
});

exports.uploadProspectsToInstantly = onCall({secrets: [INSTANTLY_API_KEY]}, async (request) => {
  assertAuthorized(request);
  const {prospectIds, campaignId, listId} = request.data || {};
  if (!Array.isArray(prospectIds) || !prospectIds.length) {
    throw new HttpsError('invalid-argument', 'prospectIds must be a non-empty array.');
  }
  if (!campaignId && !listId) {
    throw new HttpsError('invalid-argument', 'campaignId or listId is required.');
  }

  const snaps = await db.getAll(...prospectIds.map(id => db.collection('prospects').doc(id)));
  const skipped = [];
  const leads = [];
  const idByEmail = new Map();

  for (const snap of snaps) {
    if (!snap.exists) { skipped.push({id: snap.id, reason: 'not found'}); continue; }
    const p = snap.data();
    const contact = (p.contacts || [])[0];
    const email = contact && contact.email;
    if (!email) { skipped.push({id: snap.id, reason: 'no contact email'}); continue; }
    const [firstName, ...rest] = (contact.name || '').split(' ');
    leads.push({
      email,
      first_name: firstName || null,
      last_name: rest.join(' ') || null,
      company_name: p.name || null,
      website: p.website || null,
    });
    idByEmail.set(email.toLowerCase(), snap.id);
  }

  if (!leads.length) {
    return {uploaded: 0, skipped};
  }

  const body = {
    leads,
    skip_if_in_campaign: true,
    skip_if_in_list: true,
    skip_if_in_workspace: true,
  };
  if (campaignId) body.campaign_id = campaignId;
  if (listId) body.list_id = listId;

  await instantlyFetch('/leads/add', INSTANTLY_API_KEY.value(), {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const now = new Date().toISOString();
  const batch = db.batch();
  for (const id of idByEmail.values()) {
    batch.update(db.collection('prospects').doc(id), {instantlyStatus: 'Synced', instantlySyncedAt: now});
  }
  await batch.commit();

  return {uploaded: leads.length, skipped};
});

function addContactsToMap(map, type, snap) {
  const data = snap.data();
  for (const c of (data.contacts || [])) {
    if (c.email) map.set(c.email.toLowerCase(), {type, id: snap.id});
  }
}

// Every record type that can carry a contact email — used both to match inbound
// mail to an existing record, and to avoid re-creating a Prospect for a contact
// that's already a Lead/Customer/Provider/Partner elsewhere in the CRM.
const RECORD_TYPES_WITH_CONTACTS = ['prospects', 'leads', 'customers', 'providers', 'partners'];
async function buildEmailIndex() {
  const snaps = await Promise.all(RECORD_TYPES_WITH_CONTACTS.map(t => db.collection(t).get()));
  const byEmail = new Map();
  RECORD_TYPES_WITH_CONTACTS.forEach((type, i) => {
    for (const snap of snaps[i].docs) addContactsToMap(byEmail, type, snap);
  });
  return byEmail;
}

const SYNCED_EACCOUNTS_LOWER = SYNCED_EACCOUNTS.map(e => e.toLowerCase());
function matchEmailToRecord(email, byEmail) {
  const candidates = [];
  if (email.from_address_email) candidates.push(email.from_address_email);
  if (email.to_address_email_list) candidates.push(...email.to_address_email_list.split(',').map(s => s.trim()));
  for (const addr of candidates) {
    const lower = (addr || '').toLowerCase();
    if (lower && !SYNCED_EACCOUNTS_LOWER.includes(lower) && byEmail.has(lower)) {
      return byEmail.get(lower);
    }
  }
  return null;
}

// RFC Message-ID, normalised -- the same email has the same one in Instantly, in
// every Gmail mailbox it passed through, so it's the cross-source dedupe key.
function normMessageId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

async function writeLogEntryIfNew(email, match) {
  const existing = await db.collection('logEntries').where('instantlyId', '==', email.id).limit(1).get();
  if (!existing.empty) return;
  const emailMessageId = normMessageId(email.message_id);
  if (emailMessageId) {
    const dup = await db.collection('logEntries').where('emailMessageId', '==', emailMessageId).limit(1).get();
    if (!dup.empty) return;
  }

  const received = email.email_type === 'received';
  const counterpart = received ? email.from_address_email : email.to_address_email_list;
  const snippet = ((email.body && email.body.text) || '').trim().slice(0, 2000);
  const text = `${received ? 'Received from' : 'Sent to'} ${counterpart || 'unknown'} — ${email.subject || '(no subject)'}${snippet ? `\n\n${snippet}` : ''}`;
  const author = received ? (counterpart || 'Prospect') : 'Michael (Instantly)';

  await db.collection('logEntries').add({
    recordType: match.type,
    recordId: match.id,
    parentId: null,
    kind: 'Email',
    author,
    initials: initialsFrom(author),
    text,
    follow: false,
    followDate: null,
    followDone: false,
    closedOn: null,
    instantlyId: email.id,
    emailMessageId,
    createdAt: new Date(email.timestamp_email || email.timestamp_created).toISOString(),
  });
}

// Polls Instantly for all mail to/from SYNCED_EACCOUNTS since the last run,
// matches each message to a Prospect or Lead by contact email, and logs it there.
exports.syncInstantlyEmails = onSchedule(
  {schedule: 'every 30 minutes', secrets: [INSTANTLY_API_KEY], timeoutSeconds: 300},
  async () => {
    const apiKey = INSTANTLY_API_KEY.value();
    const cursorRef = db.collection('settings').doc('instantlySync');
    const cursorSnap = await cursorRef.get();
    const lastTimestamp = (cursorSnap.exists && cursorSnap.data().lastTimestamp) || '2020-01-01T00:00:00.000Z';

    const byEmail = await buildEmailIndex();

    let startingAfter;
    let processed = 0;
    let maxTimestamp = lastTimestamp;
    let pages = 0;
    const MAX_PAGES = 20;

    do {
      const params = new URLSearchParams({
        eaccount: SYNCED_EACCOUNTS.join(','),
        limit: '100',
        sort_order: 'asc',
        min_timestamp_created: lastTimestamp,
      });
      if (startingAfter) params.set('starting_after', startingAfter);

      let data;
      try {
        data = await instantlyFetch(`/emails?${params.toString()}`, apiKey);
      } catch (e) {
        console.error('syncInstantlyEmails: fetch failed', e);
        break;
      }
      const items = data.items || [];
      for (const email of items) {
        const match = matchEmailToRecord(email, byEmail);
        if (match) await writeLogEntryIfNew(email, match);
        processed++;
        if (email.timestamp_created && email.timestamp_created > maxTimestamp) {
          maxTimestamp = email.timestamp_created;
        }
      }
      startingAfter = data.next_starting_after;
      pages++;
    } while (startingAfter && pages < MAX_PAGES);

    await cursorRef.set({
      lastTimestamp: maxTimestamp,
      lastRunAt: new Date().toISOString(),
      lastProcessedCount: processed,
    }, {merge: true});
    console.log(`syncInstantlyEmails: processed ${processed} emails, cursor now ${maxTimestamp}`);
  }
);

// Polls every Teligen campaign in Instantly and creates a Prospect here for any
// lead whose email isn't already attached to a record in the CRM (Prospect, Lead,
// Customer, Provider or Partner). Keeps the CRM as a mirror of who's being
// worked in Instantly, not just the leads we ourselves uploaded from here.
exports.syncInstantlyLeadsToProspects = onSchedule(
  {schedule: 'every 30 minutes', secrets: [INSTANTLY_API_KEY], timeoutSeconds: 300},
  async () => {
    const apiKey = INSTANTLY_API_KEY.value();
    const campaigns = await getTeligenCampaigns(apiKey);
    if (!campaigns.length) {
      console.log('syncInstantlyLeadsToProspects: no Teligen campaigns found');
      return;
    }

    const byEmail = await buildEmailIndex();
    let created = 0;
    const MAX_PAGES = 20;

    for (const campaign of campaigns) {
      let startingAfter;
      let pages = 0;
      do {
        let data;
        try {
          data = await instantlyFetch('/leads/list', apiKey, {
            method: 'POST',
            body: JSON.stringify({campaign: campaign.id, limit: 100, starting_after: startingAfter}),
          });
        } catch (e) {
          console.error(`syncInstantlyLeadsToProspects: leads/list failed for campaign ${campaign.name}`, e);
          break;
        }
        const items = data.items || [];
        for (const lead of items) {
          const email = (lead.email || '').toLowerCase();
          if (!email || byEmail.has(email) || INTERNAL_DOMAINS.includes(email.split('@')[1])) continue;

          const contactName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || email;
          const name = lead.company_name || contactName;
          const now = new Date().toISOString();
          const ref = await db.collection('prospects').add({
            name,
            side: 'Customer',
            owner: 'Unassigned',
            website: lead.website || '',
            countries: [],
            source: 'Cold outreach',
            contacts: [{name: contactName, role: '', kind: 'Primary', email: lead.email, phone: ''}],
            documents: [],
            instantlyStatus: 'Synced',
            instantlySyncedAt: now,
            instantlyLeadId: lead.id,
            instantlyCampaign: campaign.name,
            createdAt: now,
          });
          byEmail.set(email, {type: 'prospects', id: ref.id});
          created++;
        }
        startingAfter = data.next_starting_after;
        pages++;
      } while (startingAfter && pages < MAX_PAGES);
    }

    console.log(`syncInstantlyLeadsToProspects: created ${created} new prospect(s) from ${campaigns.length} Teligen campaign(s)`);
  }
);

// ── Gmail sync ──────────────────────────────────────────────────────────────
// Logs the team's own 1:1 email (not just Instantly campaign mail) onto the matching
// record. Keyless domain-wide delegation: the function's runtime service account signs a
// JWT (IAM Credentials API) naming the mailbox as `sub`, and exchanges it for a read-only
// Gmail token. Only messages whose from/to/cc matches a CRM contact are stored, and only
// the headers + Gmail's ~200-char snippet -- never the full body, never unmatched mail.
// One-time setup (Gmail API on, Token Creator on the runtime SA, domain-wide delegation of
// its client ID with the gmail.readonly scope in each Workspace admin console) is in CLAUDE.md.
// guillermo@011global.com is the same inbox (alias) as guillermo@teligen.io -- scanning both only re-reads it.
// marcelo@teligen.io is the same inbox as marcelo@011global.com (identical message counts), so only one is scanned.
const GMAIL_MAILBOXES = ['guillermo@teligen.io', 'marcelo@011global.com'];
const GMAIL_INITIAL_LOOKBACK_DAYS = 90;
const GMAIL_MAX_MESSAGES_PER_MAILBOX_PER_RUN = 1500;
const GMAIL_CONCURRENCY = 5;
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';

async function getDelegatedGmailToken(subject) {
  const mdHeaders = {'Metadata-Flavor': 'Google'};
  const saEmail = await (await fetch(`${METADATA}/email`, {headers: mdHeaders})).text();
  const own = await (await fetch(`${METADATA}/token`, {headers: mdHeaders})).json();
  const iat = Math.floor(Date.now() / 1000);
  const claims = {iss: saEmail, sub: subject, scope: GMAIL_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3000};
  const signRes = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:signJwt`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${own.access_token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({payload: JSON.stringify(claims)}),
  });
  if (!signRes.ok) throw new Error(`signJwt failed (${signRes.status}): ${(await signRes.text()).slice(0, 300)}`);
  const {signedJwt} = await signRes.json();
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt}),
  });
  if (!tokRes.ok) throw new Error(`token exchange for ${subject} failed (${tokRes.status}): ${(await tokRes.text()).slice(0, 300)} -- is domain-wide delegation authorized for this domain?`);
  return (await tokRes.json()).access_token;
}

async function gmailGet(token, path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {headers: {Authorization: `Bearer ${token}`}});
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    throw new Error(`Gmail ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

function decodeMimeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString('utf8');
      return Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    } catch (e) { return m; }
  });
}
function decodeEntities(s) {
  return String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function headerOf(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

async function syncOneMailbox(mailbox, byEmail, cursorState) {
  const token = await getDelegatedGmailToken(mailbox);
  const mailboxLower = mailbox.toLowerCase();
  const sinceMs = cursorState.lastInternalMs || (Date.now() - GMAIL_INITIAL_LOOKBACK_DAYS * 86400000);
  const q = `after:${Math.max(0, Math.floor(sinceMs / 1000) - 1)}`; // -1s: boundary overlap is absorbed by the Message-ID dedupe

  const ids = [];
  let pageToken;
  do {
    const data = await gmailGet(token, `messages?q=${encodeURIComponent(q)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const m of (data.messages || [])) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < 5000);
  ids.reverse(); // list is newest-first; process oldest-first so the cursor only ever moves forward over fully-handled mail

  let handled = 0, logged = 0, maxMs = sinceMs;
  const processOne = async (id) => {
    const msg = await gmailGet(token, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject&metadataHeaders=Message-ID`);
    handled++;
    const internalMs = Number(msg.internalDate) || 0;
    if (internalMs > maxMs) maxMs = internalMs;
    if ((msg.labelIds || []).includes('DRAFT')) return;

    const fromHeader = headerOf(msg, 'From');
    const fromAddr = ((fromHeader.match(EMAIL_RE) || [])[0] || '').toLowerCase();
    const others = [fromHeader, headerOf(msg, 'To'), headerOf(msg, 'Cc'), headerOf(msg, 'Bcc')]
      .flatMap(h => (h.match(EMAIL_RE) || []).map(a => a.toLowerCase()))
      .filter(a => a !== mailboxLower && !SYNCED_EACCOUNTS_LOWER.includes(a));
    const matchAddr = others.find(a => byEmail.has(a));
    if (!matchAddr) return;
    const match = byEmail.get(matchAddr);

    const emailMessageId = normMessageId(headerOf(msg, 'Message-ID'));
    const dupQuery = emailMessageId
      ? db.collection('logEntries').where('emailMessageId', '==', emailMessageId)
      : db.collection('logEntries').where('gmailId', '==', `${mailbox}:${id}`);
    if (!(await dupQuery.limit(1).get()).empty) return;

    const sent = fromAddr === mailboxLower || (msg.labelIds || []).includes('SENT');
    const subject = decodeMimeWords(headerOf(msg, 'Subject')) || '(no subject)';
    const snippet = decodeEntities(msg.snippet || '').trim();
    const counterpart = sent ? decodeMimeWords(headerOf(msg, 'To')) || matchAddr : decodeMimeWords(fromHeader) || matchAddr;
    const author = sent ? mailbox : (decodeMimeWords(fromHeader).replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || matchAddr);
    await db.collection('logEntries').add({
      recordType: match.type,
      recordId: match.id,
      parentId: null,
      kind: 'Email',
      author,
      initials: initialsFrom(author),
      text: `${sent ? 'Sent to' : 'Received from'} ${counterpart} — ${subject}${snippet ? `\n\n${snippet}` : ''}`,
      follow: false,
      followDate: null,
      followDone: false,
      closedOn: null,
      emailMessageId,
      gmailId: `${mailbox}:${id}`,
      mailbox,
      createdAt: new Date(internalMs || Date.now()).toISOString(),
    });
    logged++;
  };
  // Small parallel batches (Gmail allows ~250 quota units/sec/user; a metadata get is 5) so a
  // new mailbox's backlog clears in a few runs instead of hours. Batches finish in order, so
  // the cursor still only moves over fully-handled mail.
  const batch = ids.slice(0, GMAIL_MAX_MESSAGES_PER_MAILBOX_PER_RUN);
  for (let i = 0; i < batch.length; i += GMAIL_CONCURRENCY) {
    await Promise.all(batch.slice(i, i + GMAIL_CONCURRENCY).map(processOne));
  }
  return {handled, logged, total: ids.length, lastInternalMs: maxMs};
}

exports.syncGmailMessages = onSchedule(
  {schedule: 'every 30 minutes', timeoutSeconds: 540, memory: '512MiB'},
  async () => {
    const cursorRef = db.collection('settings').doc('gmailSync');
    const cursorSnap = await cursorRef.get();
    const state = (cursorSnap.exists && cursorSnap.data().mailboxes) || {};
    const byEmail = await buildEmailIndex();

    for (const mailbox of GMAIL_MAILBOXES) {
      const key = mailbox.replace(/[.@]/g, '_');
      try {
        const r = await syncOneMailbox(mailbox, byEmail, state[key] || {});
        await cursorRef.set({mailboxes: {[key]: {mailbox, lastInternalMs: r.lastInternalMs, lastRunAt: new Date().toISOString(), lastHandled: r.handled, lastLogged: r.logged, lastError: null}}}, {merge: true});
        console.log(`syncGmailMessages: ${mailbox} — scanned ${r.handled}/${r.total}, logged ${r.logged}`);
      } catch (e) {
        console.error(`syncGmailMessages: ${mailbox} failed:`, e.message || e);
        await cursorRef.set({mailboxes: {[key]: {mailbox, lastRunAt: new Date().toISOString(), lastError: String(e.message || e).slice(0, 500)}}}, {merge: true});
      }
    }
  }
);
