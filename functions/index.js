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
const MICHAEL_EACCOUNT = 'michael@teligenlabs.com';
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
exports.listInstantlyCampaigns = onCall({secrets: [INSTANTLY_API_KEY]}, async (request) => {
  assertAuthorized(request);
  const apiKey = INSTANTLY_API_KEY.value();

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

  return {campaigns: matches};
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

function matchEmailToRecord(email, byEmail) {
  const candidates = [];
  if (email.from_address_email) candidates.push(email.from_address_email);
  if (email.to_address_email_list) candidates.push(...email.to_address_email_list.split(',').map(s => s.trim()));
  for (const addr of candidates) {
    const lower = (addr || '').toLowerCase();
    if (lower && lower !== MICHAEL_EACCOUNT.toLowerCase() && byEmail.has(lower)) {
      return byEmail.get(lower);
    }
  }
  return null;
}

async function writeLogEntryIfNew(email, match) {
  const existing = await db.collection('logEntries').where('instantlyId', '==', email.id).limit(1).get();
  if (!existing.empty) return;

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
    createdAt: new Date(email.timestamp_email || email.timestamp_created).toISOString(),
  });
}

// Polls Instantly for all mail to/from michael@teligenlabs.com since the last run,
// matches each message to a Prospect or Lead by contact email, and logs it there.
exports.syncInstantlyEmails = onSchedule(
  {schedule: 'every 30 minutes', secrets: [INSTANTLY_API_KEY], timeoutSeconds: 300},
  async () => {
    const apiKey = INSTANTLY_API_KEY.value();
    const cursorRef = db.collection('settings').doc('instantlySync');
    const cursorSnap = await cursorRef.get();
    const lastTimestamp = (cursorSnap.exists && cursorSnap.data().lastTimestamp) || '2020-01-01T00:00:00.000Z';

    const [prospectsSnap, leadsSnap] = await Promise.all([
      db.collection('prospects').get(),
      db.collection('leads').get(),
    ]);
    const byEmail = new Map();
    for (const snap of prospectsSnap.docs) addContactsToMap(byEmail, 'prospects', snap);
    for (const snap of leadsSnap.docs) addContactsToMap(byEmail, 'leads', snap);

    let startingAfter;
    let processed = 0;
    let maxTimestamp = lastTimestamp;
    let pages = 0;
    const MAX_PAGES = 20;

    do {
      const params = new URLSearchParams({
        eaccount: MICHAEL_EACCOUNT,
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
