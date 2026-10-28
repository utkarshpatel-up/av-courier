const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, safeStorage, Notification, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { CopyQueue, fmtBytes } = require('./copyqueue');
const { Catalog } = require('./catalog');
const { analyse, searchRequest, requestAsks } = require('./extract');
const { sendEmail, GmailWatcher } = require('./mail');
const { WhatsApp } = require('./whatsapp');
const { Notifier, TEMPLATES, fill, firstName, rowLine } = require('./notifier');
const { DriveIndex } = require('./locate');
const { Remote } = require('./remote');
const { RequestSync, FolderBackend, GmailBackend, findGoogleDrive } = require('./sync');
const { GoogleAuth, readClientFile } = require('./google-auth');
const { senderKey, ignoredReason } = require('./senders');
const { Ocr } = require('./ocr');
const { readSheet, isSheet } = require('./sheet');
const os = require('os');
const QRCode = require('qrcode');

// Dev check: AVC_SMOKE=<folder> runs the UI on throwaway data and saves screenshots.
if (process.env.AVC_SMOKE) { const d = path.join(process.env.AVC_SMOKE, 'data'); fs.mkdirSync(d, { recursive: true }); app.setPath('userData', d); }
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const DATA = app.getPath('userData');
const ATTACH = path.join(DATA, 'attachments');
fs.mkdirSync(ATTACH, { recursive: true });
const file = (n) => path.join(DATA, n);
const readJSON = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const writeJSON = (n, v) => { fs.writeFileSync(file(n) + '.tmp', JSON.stringify(v)); fs.renameSync(file(n) + '.tmp', file(n)); };

const DEFAULTS = {
  copy: { verify: true, conflict: 'skip-same', bufferMB: 4, hash: 'md5' },
  notify: { autoSend: true, templates: {} },
  email: { user: '', watch: false, folder: 'INBOX', intervalMin: 3, domains: '', lastUid: 0, login: 'password', googleClientId: '' },
  whatsapp: { enabled: false, groupWindowMin: 10, verifiedChats: [] },
  ai: { enabled: false },
  reminders: { afterMin: 60 },
  locate: { includeSystemDrive: false, extraRoots: [], depth: 7 },
  remote: { enabled: false, port: 8765 },
  sync: { enabled: false, mode: 'gmail', folder: '', machine: '' },
  catalog: { files: [] },
  recentDest: [],
  ignoredSenders: [], // [{ key, name, channel, at }]: never data requests
  contacts: [],
};
let settings = readJSON('settings.json', {});
for (const [k, v] of Object.entries(DEFAULTS)) settings[k] = typeof v === 'object' && !Array.isArray(v) ? { ...v, ...(settings[k] || {}) } : (settings[k] ?? v);
const saveSettings = () => writeJSON('settings.json', settings);

// Passwords and keys: encrypted with the Windows account (DPAPI via safeStorage).
let secrets = readJSON('secrets.json', {});
const getSecret = (k) => { try { return secrets[k] ? safeStorage.decryptString(Buffer.from(secrets[k], 'base64')) : ''; } catch { return ''; } };
const setSecret = (k, v) => { if (v) secrets[k] = safeStorage.encryptString(v).toString('base64'); else delete secrets[k]; writeJSON('secrets.json', secrets); };

let requests = readJSON('requests.json', []);
// sync: request status shared with your other computers (electron/sync.js), set up below.
let sync = null;
const saveRequests = () => { sync?.noteChanges(); writeJSON('requests.json', requests); push('requests', requests); updateTray(); };

let log = readJSON('activity.json', []);
function activity(text) {
  log.unshift({ at: Date.now(), text });
  log = log.slice(0, 500);
  writeJSON('activity.json', log);
  push('activity', log);
}

let catalog = new Catalog();
const ocr = new Ocr(DATA);
try { const c = readJSON('catalog.json', null); if (c) catalog = Catalog.fromJSON(c); } catch { /* re-import */ }

let win, tray;
let remote = null; // phone remote, set up below the api
const push = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
  if (['queue', 'requests', 'activity', 'status'].includes(ch)) remote?.broadcast(ch, data);
};
const toast = (title, body, onClick) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => { showWin(); onClick?.(); });
  n.show();
};

// ---------------------------------------------------------------- copy queue
const queue = new CopyQueue({ statePath: file('queue.json'), settings: () => settings.copy });
queue.on('update', (s) => { push('queue', s); updateTray(s); });
queue.on('error', (e) => activity(`Queue error: ${e.message}`));
queue.on('job-finished', async (job) => {
  const ok = job.status === 'done';
  activity(`${ok ? 'Finished' : job.status === 'cancelled' ? 'Cancelled' : 'Failed'}: ${job.name} (${job.done}/${job.count} files, ${fmtBytes(job.bytesTotal)})`);
  writeReport(job);
  if (job.status === 'cancelled') {
    const r = requests.find((x) => x.id === job.requestId);
    const it = r?.checklist?.items.find((i) => i.id === job.itemId);
    if (it) { Object.assign(it, { status: 'waiting', note: 'Copy cancelled' }); await checklistProgress(r); saveRequests(); }
    return;
  }
  toast(ok ? 'Copy finished' : 'Copy finished with errors', `${job.name}: ${job.done} of ${job.count} files${job.failed ? `, ${job.failed} failed` : ''}`);
  const req = requests.find((r) => r.id === job.requestId);
  // One item of a request's checklist: tick it, and tell the requester once every item is through.
  const item = req?.checklist?.items.find((i) => i.id === job.itemId);
  if (item) {
    Object.assign(item, ok ? { status: 'done', note: '' } : { status: 'failed', note: `${job.failed || job.count - job.done} of ${job.count} files failed` });
    req.history.push({ at: Date.now(), text: `${ok ? '✓' : '✗'} ${item.title}` });
    await checklistProgress(req);
    return saveRequests();
  }
  if (req) { req.status = ok ? 'ready' : 'attention'; req.history.push({ at: Date.now(), text: `Copy ${ok ? 'finished' : 'had errors'}: ${job.name}` }); }
  const live = queue.get(job.id);
  if (job.notify?.length && (job.autoSend ?? settings.notify.autoSend) && ok) {
    const results = await notifier.jobFinished(job);
    if (live) { live.notified = results; queue._changed(true); }
    if (req && results.some((r) => r.ok)) { req.status = 'delivered'; req.history.push({ at: Date.now(), text: `Told ${results.filter((r) => r.ok).map((r) => r.to).join(', ')}` }); }
  }
  if (req) saveRequests();
});

function writeReport(job) {
  const dir = path.join(DATA, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const csv = ['Source,Destination,Size,Status,MD5,Verified,Note']
    .concat(job.files.filter((f) => f.status !== 'removed').map((f) => [f.src, f.target || '', f.size, f.status, f.hash || '', f.verified ? 'yes' : '', f.error || f.note || ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
  const name = `${new Date(job.finishedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')} ${job.name.replace(/[\\/:*?"<>|]/g, '_')}.csv`;
  fs.writeFileSync(path.join(dir, name), csv.join('\r\n'));
  const live = queue.get(job.id);
  if (live) live.report = path.join(dir, name);
}

// ---------------------------------------------------------------- channels
// Gmail login: an App Password, or "Sign in with Google" (electron/google-auth.js).
const google = new GoogleAuth({
  client: () => ({ id: settings.email.googleClientId, secret: getSecret('googleClient') }),
  tokens: { load: () => { try { return JSON.parse(getSecret('googleTokens') || 'null'); } catch { return null; } }, save: (t) => setSecret('googleTokens', t ? JSON.stringify(t) : '') },
  openUrl: (u) => shell.openExternal(u),
});
const useGoogle = () => settings.email.login === 'google';
const mailAuth = async () => (useGoogle() ? { accessToken: await google.token() } : { pass: getSecret('gmail') });
// Signed in with Google, the mailbox is always that account's.
const mailUser = () => (useGoogle() && google.email) || settings.email.user;
const mailReady = () => !!mailUser() && (useGoogle() ? google.signedIn : !!getSecret('gmail'));
const mailCfg = () => ({ ...settings.email, user: mailUser(), saveLastUid: (u) => { settings.email.lastUid = u; saveSettings(); } });
const sendMail = async (o) => sendEmail({ user: mailUser(), ...(await mailAuth()), ...o });
const gmail = new GmailWatcher({ getConfig: mailCfg, getAuth: mailAuth, onMessage: (m) => incoming(m), log: activity });
const whatsapp = new WhatsApp({
  onMessage: (m) => incoming(m),
  onStatus: (s) => { push('status', channelStatus()); if (s === 'ready') activity('WhatsApp connected'); },
  // Chats with a verified-business badge: their messages are never data requests.
  onVerified: (chats) => {
    const known = new Set(settings.whatsapp.verifiedChats);
    const fresh = chats.filter((c) => !known.has(c));
    if (!fresh.length) return;
    settings.whatsapp.verifiedChats = [...known, ...fresh].slice(-500);
    saveSettings();
    activity(`Verified business${fresh.length > 1 ? 'es' : ''} on WhatsApp, never treated as requests: ${fresh.join(', ')}`);
    const lists = senderLists();
    const hit = requests.filter((r) => !['dismissed', 'replied', 'delivered', 'closed'].includes(r.status) && ignoredReason(r, lists));
    for (const r of hit) { r.status = 'dismissed'; r.history.push({ at: Date.now(), text: 'Verified business: never a request' }); }
    if (hit.length) saveRequests();
    ignoredChanged();
  },
  log: activity,
  // Last preview seen per chat, so messages that came while the PC was off are caught too.
  store: { load: () => readJSON('whatsapp-seen.json', null), save: (m) => writeJSON('whatsapp-seen.json', m) },
});
// Day folders ("3034 Dt-15 Sep 2026") on whatever drives are plugged in.
const drives = new DriveIndex({
  getConfig: () => settings.locate, log: activity,
  // What each LTO tape holds, remembered after its one manual scan.
  store: { load: () => readJSON('tapes.json', {}), save: (t) => writeJSON('tapes.json', t) },
});
// The tape (if any) a path is on.
const tapeFor = (p) => [...drives.drives.values()].find((d) => d.tape && path.resolve(p).toUpperCase().startsWith(path.resolve(d.root).toUpperCase()));
const withDisk = (rows) => rows.map((r) => ({ ...r, found: drives.find(r) }));
const findRows = (q, limit) => withDisk(catalog.search(q, limit));

// A request's matches (a list of recordings item by item: extract.js searchRequest).
const matchRequest = (text, a) => withDisk(searchRequest(catalog, text, a));
// The request's words plus the words read from its pictures.
// The request's words, the words read from its pictures, and the rows of its spreadsheets.
const requestText = (r) => [r.text, ...Object.values(r.ocr || {}), ...Object.values(r.sheets || {}).map((s) => s.text)].filter(Boolean).join('\n\n');
function refreshFound() {
  for (const r of requests) if (r.matches?.length && !['closed', 'dismissed'].includes(r.status)) r.matches = withDisk(r.matches);
  saveRequests();
  push('status', channelStatus());
}

const notifier = new Notifier({ getTemplates: () => settings.notify.templates, sendEmail: sendMail, whatsapp, log: activity });

function channelStatus() {
  return {
    whatsapp: whatsapp.status,
    gmail: { status: gmail.status, error: gmail.lastError, lastCheck: gmail.lastCheck, hasPassword: !!getSecret('gmail'), login: settings.email.login, google: { signedIn: google.signedIn, email: google.email, hasClient: !!(settings.email.googleClientId && getSecret('googleClient')) } },
    ai: { hasKey: !!getSecret('anthropic') },
    drives: drives.status(),
    sync: sync && settings.sync.enabled ? sync.info() : null,
    phone: { on: !!remote?.server, online: remote?.devices().filter((d) => d.online).length || 0, paired: remote?.devices().length || 0 },
  };
}

// ---------------------------------------------------------------- requests
function saveImages(images) {
  return images.map((d) => {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(d);
    if (!m) return null;
    const p = path.join(ATTACH, `${crypto.randomBytes(8).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(p, Buffer.from(m[2], 'base64'));
    return p;
  }).filter(Boolean);
}

// Spreadsheets sent with a request: kept beside the pictures, under their own names.
// files: [{ name, data (base64) }] from a mail, or paths picked or dropped on this computer.
function saveFiles(files) {
  return (files || []).map((f) => {
    const name = path.basename(typeof f === 'string' ? f : f.name || 'request.xlsx').replace(/[\\/:*?"<>|]/g, '_');
    if (!isSheet(name)) return null;
    const p = path.join(ATTACH, `${crypto.randomBytes(4).toString('hex')} ${name}`);
    if (typeof f === 'string') fs.copyFileSync(f, p); else fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
    return p;
  }).filter(Boolean);
}
const fileName = (p) => path.basename(p).replace(/^[0-9a-f]{8} /, '');

const imageData = (p) => `data:image/${path.extname(p).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(p).toString('base64')}`;

async function analyseRequest(req) {
  const apiKey = settings.ai.enabled ? getSecret('anthropic') : '';
  const files = req.images.filter(fs.existsSync);
  const images = files.map(imageData);
  // The words in its pictures, read on this computer (once per picture), so a screenshot or
  // a photo of a monitor is understood without Claude too.
  req.ocr = req.ocr || {};
  for (const f of files.slice(0, 5)) {
    if (req.ocr[f] != null) continue;
    try { req.ocr[f] = await ocr.read(f); } catch (e) { req.ocr[f] = ''; activity(`Could not read the picture from ${req.from.name}: ${e.message}`); }
  }
  // The rows of its spreadsheets, read once per file.
  req.sheets = req.sheets || {};
  for (const f of (req.files || []).filter(fs.existsSync)) {
    if (req.sheets[f] != null) continue;
    try { req.sheets[f] = readSheet(f); } catch (e) { req.sheets[f] = { text: '', rows: 0, sheets: [], error: e.message }; activity(`Could not read the spreadsheet ${fileName(f)} from ${req.from.name}: ${e.message}`); }
  }
  const text = requestText(req);
  req.analysis = await analyse({ text, images, apiKey });
  const a = req.analysis;
  req.matches = matchRequest(text, a);
  redraft(req);
  if (a.aiError) activity(`Claude could not read the request from ${req.from.name}: ${a.aiError}`);
}

const senderLists = () => ({ verified: settings.whatsapp.verifiedChats, ignored: settings.ignoredSenders });
// The lists went to the phone too, so it filters its own notifications the same way.
function ignoredChanged() { remote?.broadcast('ignored', senderLists()); push('status', channelStatus()); }

async function incoming(msg) {
  if (requests.some((r) => r.externalId === msg.externalId)) return;
  // Verified businesses and ignored senders: never data requests.
  if (ignoredReason(msg, senderLists())) return;
  const now = Date.now();
  // Already have it (same chat, same words): a re-read of the chat list must not add it again.
  const same = (s) => String(s || '').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  // A spreadsheet sent on its own (from the phone) is always a request of its own.
  const sheetOnly = !!msg.files?.length && !String(msg.text || '').trim();
  if (msg.channel === 'whatsapp' && !sheetOnly && requests.some((r) => r.channel === 'whatsapp' && r.from.chat === msg.from.chat && same(r.text).includes(same(msg.text)) && now - r.receivedAt < 7 * 86400000)) return;

  // People send a request over several WhatsApp messages: join them.
  if (msg.channel === 'whatsapp' && !sheetOnly) {
    const open = requests.find((r) => r.channel === 'whatsapp' && r.from.chat === msg.from.chat && ['new', 'maybe'].includes(r.status) && now - r.lastAt < settings.whatsapp.groupWindowMin * 60000);
    // The same message can come twice (notification, then chat list): keep it once.
    const dup = open && open.text.replace(/\s+/g, ' ').includes(msg.text.replace(/\s+/g, ' ').slice(0, 80));
    if (dup) return;
    if (open) {
      open.text += '\n' + msg.text;
      open.lastAt = now;
      open.hasMedia = open.hasMedia || msg.hasMedia;
      await analyseRequest(open);
      if (open.status === 'maybe' && open.analysis.isRequest) { open.status = 'new'; announce(open); }
      return saveRequests();
    }
  }

  const req = {
    id: crypto.randomBytes(6).toString('hex'),
    channel: msg.channel, externalId: msg.externalId, from: msg.from, subject: msg.subject || '',
    text: msg.text, images: saveImages(msg.images || []), files: saveFiles(msg.files), hasMedia: !!msg.hasMedia,
    receivedAt: msg.receivedAt || now, lastAt: now, reply: msg.reply || null,
    status: 'new', jobIds: [], history: [{ at: now, text: `Received on ${msg.channel}` }],
  };
  await analyseRequest(req);
  if (!req.analysis.isRequest) {
    // forced: read from a picture on the phone, so someone chose to add it.
    const chosen = msg.channel === 'manual' || msg.forced;
    if (chosen || req.images.length || req.files.length || req.analysis.score >= 15) req.status = chosen ? 'new' : 'maybe';
    else return; // small talk: "ok", "thanks"
  }
  requests.unshift(req);
  requests = requests.slice(0, 2000);
  saveRequests();
  // Already dealt with on another computer? Then it arrives marked, without an alert.
  if (sync?.pending.length) await sync.poll();
  if (req.status === 'new' && msg.channel !== 'manual') announce(req);
  return req;
}

function announce(req) {
  activity(`Request from ${req.from.name} (${req.channel}): ${req.analysis.summary}`);
  toast(`Data request: ${req.from.name}`, `${req.analysis.summary}${req.matches.length ? `\nBest match: ${rowLine(req.matches[0]).slice(2, 120)}` : ''}`, () => push('open-request', req.id));
}

// Search the catalogue again with what was read from the request.
const rematch = (r) => { if (r.analysis) { r.matches = matchRequest(requestText(r), r.analysis); redraft(r); } };
// The draft follows the request's words until you change it; an approved list is yours.
function redraft(r) { if (!r.checklist || (r.checklist.state === 'draft' && !r.checklist.edited)) r.checklist = draftChecklist(r); }

const reqById = (id) => { const r = requests.find((x) => x.id === id); if (!r) throw new Error('Request not found'); return r; };
const openRequests = () => requests.filter((r) => ['new', 'attention'].includes(r.status));

// Anything left unanswered keeps coming back until it is dealt with.
setInterval(() => {
  const due = openRequests().filter((r) => Date.now() - r.receivedAt > settings.reminders.afterMin * 60000 && Date.now() - (r.remindedAt || 0) > settings.reminders.afterMin * 60000);
  if (!due.length) return;
  due.forEach((r) => { r.remindedAt = Date.now(); });
  writeJSON('requests.json', requests);
  const oldest = Math.max(...due.map((r) => Date.now() - r.receivedAt));
  toast(`${due.length} data request${due.length > 1 ? 's' : ''} waiting`, `${due.map((r) => r.from.name).slice(0, 4).join(', ')}. Oldest: ${Math.round(oldest / 3600000)} h`, () => push('go', 'requests'));
}, 5 * 60000);

function recipientFor(req) {
  if (req.channel === 'email') return { channel: 'email', name: req.from.name, address: req.from.address, reply: req.reply };
  // quote: their message, so the reply shows which request it answers.
  if (req.channel === 'whatsapp') return { channel: 'whatsapp', name: req.from.name, chat: req.from.chat, quote: req.text };
  return null;
}

// ---------------------------------------------------------------- checklist
// A request becomes a checklist: drafted from its words (each item asked for, with its best
// catalogue row and the drive it is on), changed and approved by you, then one copy per item.
// Items tick off as their copies finish; the requester hears once, when every item is done,
// or when you complete it and say what could not be done.
const itemId = () => crypto.randomBytes(4).toString('hex');
const slimRow = ({ found, ...row }) => row;
// "Live Garba (Navratri,Garba), Adalaj, 17 Oct 2026"; a row with no topic starts at its event.
const itemTitle = (row) => rowLine(row).split('\n')[0].replace(/^•\s*/, '').replace(/^\((.+?)\)/, '$1');
const rootName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
const isDone = (i) => i.status === 'done';

// Where an item's data is now: a folder on a connected drive, or why it cannot be copied yet.
function sourceFor(row) {
  const backups = (row.locations || []).map((l) => `${l.label.replace(/\s*backup$/i, '')}: ${l.value}`).join(' · ');
  const f = drives.find(row)[0];
  if (f?.offline) return { sources: [], where: `Tape ${f.tape}`, note: `Load tape ${f.tape}, then Copy again`, backups };
  if (f) return { sources: [f.session || f.path], where: f.tape ? `Tape ${f.tape}` : rootName(f.root), note: f.exact ? '' : 'Date on disk differs: check it', backups };
  if (row.path && fs.existsSync(row.path)) return { sources: [row.path], where: path.parse(row.path).root || row.path, note: '', backups };
  return { sources: [], where: '', note: 'Not on a connected drive', backups };
}

function itemFromRow(row, ask = '') {
  return { id: itemId(), ask, title: itemTitle(row), row: slimRow(row), kind: 'copy', ...sourceFor(row), status: 'draft' };
}

function draftChecklist(req) {
  const asks = req.analysis ? requestAsks(catalog, requestText(req), req.analysis) : [];
  const items = asks.map(({ ask, matches }) => (matches.length
    ? { ...itemFromRow(matches[0], ask), candidates: matches.map((m) => ({ ...slimRow(m), title: itemTitle(m) })) }
    : { id: itemId(), ask, title: ask, kind: 'copy', sources: [], where: '', backups: '', note: 'Nothing in the catalogue matches: add a folder, or make it a to-do', status: 'draft', candidates: [] }));
  return { state: 'draft', items, dest: settings.recentDest[0] || '', notify: [recipientFor(req)].filter(Boolean), autoSend: settings.notify.autoSend, edited: false };
}

// One copy for one item, from wherever its data is now (a drive may have been plugged in since).
async function queueItem(req, item) {
  if (item.kind === 'todo') { item.status = 'todo'; return; }
  if (item.row && !item.manual) Object.assign(item, sourceFor(item.row));
  if (!item.sources?.length) { item.status = 'waiting'; item.note = item.note || 'Nothing to copy yet'; return; }
  const id = await api.addJob({ sources: item.sources, dest: req.checklist.dest, name: item.title.slice(0, 80), notify: [], requestId: req.id, itemId: item.id, autoSend: false });
  const job = queue.get(id);
  Object.assign(item, { jobId: id, status: 'copying', note: job?.holdReason || item.note || '' });
}

function checklistMessage(req) {
  const c = req.checklist;
  // Your own to-dos are for you: the requester hears only about their data.
  const theirs = c.items.filter((i) => i.kind !== 'todo');
  const done = theirs.filter(isDone), rest = theirs.filter((i) => !isDone(i));
  const key = rest.length ? 'requestPartial' : 'requestDone';
  return fill(settings.notify.templates[key] || TEMPLATES[key], {
    name: firstName(req.from.name), dest: c.dest, count: theirs.length,
    done: done.map((i) => `• ${i.title}`).join('\n') || '• nothing yet',
    issues: rest.map((i) => `• ${i.title}${i.note ? ` — ${i.note}` : ''}`).join('\n'),
  });
}

async function sendChecklist(req, text) {
  const c = req.checklist;
  const to = c.notify?.length ? c.notify : [recipientFor(req)].filter(Boolean);
  if (!to.length) throw new Error('This request was added by hand: no one to tell. Use Write reply… instead.');
  const sent = [];
  for (const r of to) {
    try { await notifier.send(r, text, req.subject || 'Your data request'); sent.push(r.name); }
    catch (e) { activity(`Could not tell ${r.name}: ${e.message}`); }
  }
  if (!sent.length) throw new Error('The message could not be sent: see Activity');
  const n = c.items.filter(isDone).length;
  c.sentAt = Date.now();
  req.status = n === c.items.length ? 'delivered' : 'replied';
  req.history.push({ at: Date.now(), text: `Told ${sent.join(', ')}: ${n} of ${c.items.length} ready` });
}

// After any item changes: still copying, all done (send, if allowed), or waiting for you.
async function checklistProgress(req) {
  const c = req.checklist;
  if (c?.state !== 'approved' || c.sentAt) return;
  if (c.items.some((i) => i.status === 'copying')) { req.status = 'copying'; return; }
  const n = c.items.filter(isDone).length;
  if (n === c.items.length && c.autoSend) {
    try { return await sendChecklist(req, checklistMessage(req)); } catch (e) { activity(`${req.from.name}: ${e.message}`); }
  }
  req.status = 'attention';
  toast(`${req.from.name}: ${n} of ${c.items.length} ready`, n === c.items.length ? 'Everything is copied. Complete it to send the message.' : 'Some items need you: copy them again, mark them, or complete it with what is done.', () => push('open-request', req.id));
}

// ---------------------------------------------------------------- IPC
const api = {
  state: () => ({
    settings: { ...settings }, queue: queue.snapshot(), requests, activity: log,
    catalog: catalog.stats(), status: channelStatus(), templates: { ...TEMPLATES, ...settings.notify.templates },
    version: app.getVersion(),
  }),
  setSettings: (patch) => {
    for (const [k, v] of Object.entries(patch)) settings[k] = typeof v === 'object' && !Array.isArray(v) ? { ...settings[k], ...v } : v;
    saveSettings();
    if ('email' in patch) settings.email.watch ? gmail.start() : gmail.stop();
    if ('whatsapp' in patch) settings.whatsapp.enabled ? whatsapp.start() : whatsapp.stop();
    if ('sync' in patch) applySync();
    if ('remote' in patch) { if (remote.server && remote.port !== settings.remote.port) remote.stop().then(applyRemote); else applyRemote(); }
    push('status', channelStatus());
    return settings;
  },
  setSecret: (k, v) => { if (!['gmail', 'anthropic', 'googleClient'].includes(k)) throw new Error('unknown secret'); setSecret(k, v); push('status', channelStatus()); },

  pick: async (kind) => {
    const props = kind === 'dest' || kind === 'folder' ? ['openDirectory', 'createDirectory'] : kind === 'excel' ? ['openFile', 'multiSelections'] : ['openFile', 'multiSelections'];
    const filters = kind === 'excel' ? [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'xlsm', 'csv'] }]
      : kind === 'sheet' ? [{ name: 'Spreadsheet', extensions: ['xlsx', 'xlsm', 'xls', 'xlsb', 'csv', 'ods'] }] : undefined;
    const r = await dialog.showOpenDialog(win, { properties: kind === 'folder' ? [...props, 'multiSelections'] : props, filters });
    return r.canceled ? [] : r.filePaths;
  },
  addJob: async (o) => {
    // Copies from an LTO tape wait for you: start them once the drive light is steady.
    const tape = (o.sources || []).map(tapeFor).find(Boolean);
    const job = await queue.addJob({ ...o, held: tape ? `Waiting for tape ${tape.label || tape.root}. Start when the drive light is steady.` : '' });
    job.autoSend = o.autoSend ?? settings.notify.autoSend;
    settings.recentDest = [o.dest, ...settings.recentDest.filter((d) => d !== o.dest)].slice(0, 8);
    saveSettings();
    for (const c of o.notify || []) rememberContact(c);
    const req = requests.find((r) => r.id === o.requestId);
    if (req) { req.status = 'copying'; req.jobIds.push(job.id); req.history.push({ at: Date.now(), text: `Copy queued to ${o.dest}` }); saveRequests(); }
    activity(`Queued: ${job.name} → ${o.dest} (${job.files.length} files)`);
    return job.id;
  },
  addFiles: (id, paths) => queue.addFiles(id, paths).then(() => true),
  removeFile: (id, i) => queue.removeFile(id, i),
  removeJob: (id) => queue.removeJob(id),
  cancelJob: (id) => queue.cancelJob(id),
  retryJob: (id) => queue.retryFailed(id),
  holdJob: (id, on) => queue.hold(id, on),
  moveJob: (id, d) => queue.move(id, d),
  updateJob: (id, patch) => { queue.update(id, patch); const j = queue.get(id); if (j && 'autoSend' in patch) j.autoSend = patch.autoSend; },
  pause: () => queue.pause(),
  resume: () => queue.resume(),
  skip: () => queue.skipCurrent(),
  clearFinished: () => queue.clearFinished(),
  notifyJob: async (id) => {
    const j = queue.get(id);
    const results = await notifier.jobFinished({ ...j, ...queue._totals(j) });
    j.notified = results; queue._changed(true);
    return results;
  },
  previewJobMessage: (o) => notifier.messageForJob({ name: o.name || 'your data', status: 'done', count: '…', done: '…', failed: 0, bytesTotal: 0, dest: o.dest, message: o.message }, o.recipient || { name: '' }),
  reveal: (p) => shell.showItemInFolder(p),
  openPath: (p) => shell.openPath(p),
  exists: (p) => fs.existsSync(p),

  importCatalog: (files) => {
    const stats = catalog.load(files);
    writeJSON('catalog.json', catalog);
    settings.catalog.files = files; saveSettings();
    activity(`Catalogue imported: ${stats.rows} rows from ${files.map((f) => path.basename(f)).join(', ')}`);
    remote?.broadcast('catalog', { version: catalog.importedAt }); // phones fetch the new copy
    for (const r of openRequests()) rematch(r);
    saveRequests();
    return stats;
  },
  search: (q) => findRows(q, 200),
  // For the phone's offline search (served by remote.js at /api/catalog, not callable as a method).
  phoneCatalog: () => catalog.phoneExport(),
  rescanDrives: async () => { await drives.scan(); refreshFound(); return drives.items.length; },
  scanTape: async (root) => { const n = await drives.scanTape(root); refreshFound(); return n; },
  forgetTape: (label) => { drives.forgetTape(label); refreshFound(); },
  addDriveRoot: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled) return;
    settings.locate.extraRoots = [...new Set([...settings.locate.extraRoots, ...r.filePaths])];
    saveSettings();
    return api.rescanDrives();
  },
  removeDriveRoot: (p) => { settings.locate.extraRoots = settings.locate.extraRoots.filter((x) => x !== p); saveSettings(); return api.rescanDrives(); },

  addManualRequest: async ({ text, images = [], files = [], from }) => incoming({ channel: from?.channel || 'manual', externalId: `manual:${Date.now()}`, from: { name: from?.name || 'Manual', chat: from?.chat, address: from?.address }, text, images, files, receivedAt: Date.now() }),
  // A spreadsheet that belongs to a request already here: read into it.
  attachToRequest: async (id, paths) => {
    const r = reqById(id);
    const added = saveFiles(paths);
    if (!added.length) throw new Error('Only spreadsheets can be added here (Excel, CSV, OpenDocument)');
    r.files = [...(r.files || []), ...added];
    r.history.push({ at: Date.now(), text: `Spreadsheet added: ${added.map(fileName).join(', ')}` });
    await analyseRequest(r);
    saveRequests();
    return r;
  },
  reanalyse: async (id) => { const r = requests.find((x) => x.id === id); await analyseRequest(r); saveRequests(); return r; },
  setRequest: (id, patch) => {
    const r = requests.find((x) => x.id === id);
    Object.assign(r, patch);
    if (patch.status) r.history.push({ at: Date.now(), text: `Marked ${patch.status}` });
    saveRequests();
  },
  // "Never a request from this sender": senders [{ channel, from }] or request ids.
  // Their open requests are dismissed too.
  ignoreSenders: (list) => {
    const add = [];
    for (const x of [].concat(list || [])) {
      const r = typeof x === 'string' ? requests.find((q) => q.id === x) : null;
      const channel = r ? (r.channel === 'email' ? 'email' : 'whatsapp') : x.channel === 'email' ? 'email' : 'whatsapp';
      const from = r ? r.from : x.from || {};
      const key = senderKey(channel, from);
      if (key.endsWith(':') || settings.ignoredSenders.some((i) => i.key === key) || add.some((i) => i.key === key)) continue;
      // display: an email sender's name, which is all a phone notification shows.
      add.push({ key, channel, name: (channel === 'email' ? from.address || from.name : from.chat || from.name) || key, display: channel === 'email' ? from.name || '' : '', at: Date.now() });
    }
    if (!add.length) return 0;
    settings.ignoredSenders = [...settings.ignoredSenders, ...add];
    saveSettings();
    const lists = senderLists();
    const hit = requests.filter((r) => !['dismissed', 'replied', 'delivered', 'closed'].includes(r.status) && ignoredReason(r, lists));
    for (const r of hit) { r.status = 'dismissed'; r.history.push({ at: Date.now(), text: 'Sender ignored: never a request' }); }
    if (hit.length) saveRequests();
    activity(`Ignoring ${add.map((a) => a.name).join(', ')}: never data requests`);
    ignoredChanged();
    return add.length;
  },
  unignoreSender: (key) => {
    settings.ignoredSenders = settings.ignoredSenders.filter((i) => i.key !== key);
    saveSettings(); ignoredChanged();
  },
  // A chat wrongly seen as a verified business.
  forgetVerified: (chat) => {
    settings.whatsapp.verifiedChats = settings.whatsapp.verifiedChats.filter((c) => c !== chat);
    saveSettings(); ignoredChanged();
  },
  // False alarms, several at once: kept (under All) but out of every list and reminder.
  dismissRequests: (ids) => {
    const set = new Set([].concat(ids || []));
    const hit = requests.filter((r) => set.has(r.id) && r.status !== 'dismissed');
    for (const r of hit) { r.status = 'dismissed'; r.history.push({ at: Date.now(), text: 'Marked not a request' }); }
    if (hit.length) { saveRequests(); activity(`Marked ${hit.length} message${hit.length > 1 ? 's' : ''} as not a request`); }
    return hit.length;
  },
  deleteRequest: (id) => { requests = requests.filter((r) => r.id !== id); saveRequests(); },
  recipientFor: (id) => recipientFor(requests.find((r) => r.id === id)),
  locatedMessage: (id, rows) => {
    const r = requests.find((x) => x.id === id);
    const tpl = settings.notify.templates.located || TEMPLATES.located;
    return fill(tpl, { name: firstName(r.from.name), rows: rows.map(rowLine).join('\n') });
  },
  notFoundMessage: (id) => {
    const r = requests.find((x) => x.id === id);
    return fill(settings.notify.templates.notFound || TEMPLATES.notFound, { name: firstName(r.from.name), query: r.analysis.summary });
  },
  replyToRequest: async (id, text, recipient) => {
    const r = requests.find((x) => x.id === id);
    const to = recipient || recipientFor(r);
    if (!to) throw new Error('This request was added by hand: choose who to send it to');
    const route = await notifier.send(to, text, r.subject || 'Your data request');
    r.status = 'replied';
    r.history.push({ at: Date.now(), text: `Replied on ${to.channel}${route && route !== to.channel ? ` (${route})` : ''}:${text.split('\n')[0].slice(0, 80)}` });
    saveRequests();
    return true;
  },
  sendTo: (recipient, text) => notifier.send(recipient, text),

  // Checklist (see draftChecklist): draft from the message, change, approve, then tick off.
  draftChecklist: (id) => { const r = reqById(id); r.checklist = draftChecklist(r); saveRequests(); return r.checklist; },
  itemFromRow: (row, ask) => itemFromRow(row, ask),
  saveChecklist: (id, c) => {
    const r = reqById(id);
    if (r.checklist?.state === 'approved') throw new Error('This list is already approved');
    r.checklist = { state: 'draft', items: c.items || [], dest: c.dest || '', notify: c.notify || [], autoSend: !!c.autoSend, edited: true };
    saveRequests();
  },
  approveChecklist: async (id, c) => {
    const r = reqById(id);
    if (c) api.saveChecklist(id, c);
    const cl = r.checklist;
    if (!cl?.items.length) throw new Error('The list is empty: add at least one item');
    if (cl.items.some((i) => i.kind === 'copy') && !cl.dest) throw new Error('Choose the folder to copy to');
    Object.assign(cl, { state: 'approved', approvedAt: Date.now() });
    for (const i of cl.items) delete i.candidates;
    r.history.push({ at: Date.now(), text: `Checklist approved: ${cl.items.length} item${cl.items.length > 1 ? 's' : ''}` });
    for (const i of cl.items) await queueItem(r, i);
    await checklistProgress(r);
    saveRequests();
    activity(`${r.from.name}: checklist of ${cl.items.length} approved`);
  },
  // Your own item: a catalogue row, files or folders you picked, or a to-do with nothing to copy.
  addChecklistItem: async (id, o = {}) => {
    const r = reqById(id);
    r.checklist = r.checklist || { state: 'draft', items: [], dest: settings.recentDest[0] || '', notify: [recipientFor(r)].filter(Boolean), autoSend: settings.notify.autoSend };
    const c = r.checklist;
    const item = o.row ? itemFromRow(o.row, o.ask || '')
      : o.sources?.length ? { id: itemId(), ask: '', title: String(o.title || '').trim() || o.sources.map((s) => path.basename(s)).join(', '), kind: 'copy', manual: true, sources: o.sources, where: path.parse(o.sources[0]).root, backups: '', note: '', status: 'draft' }
      : { id: itemId(), ask: '', title: String(o.title || '').trim(), kind: 'todo', sources: [], where: '', backups: '', note: '', status: 'draft' };
    if (!item.title) throw new Error('Write what is to be done');
    c.items.push(item);
    if (c.state === 'approved') { c.sentAt = null; await queueItem(r, item); await checklistProgress(r); }
    else c.edited = true;
    saveRequests();
    return item;
  },
  // action: copy (again) | done | unavailable (note: why) | reopen | remove
  checklistItem: async (id, iid, action, note = '') => {
    const r = reqById(id);
    const c = r.checklist;
    const item = c?.items.find((i) => i.id === iid);
    if (!item) throw new Error('Item not found');
    const live = item.jobId && queue.get(item.jobId);
    const busy = item.status === 'copying' && live && !['done', 'failed', 'cancelled'].includes(live.status);
    if (busy && ['copy', 'remove'].includes(action)) throw new Error('It is still copying: cancel its copy in the queue first');
    if (action === 'remove') c.items = c.items.filter((i) => i !== item);
    else if (action === 'copy') await queueItem(r, item);
    else if (action === 'done') Object.assign(item, { status: 'done', note: String(note) });
    else if (action === 'unavailable') Object.assign(item, { status: 'unavailable', note: String(note).trim() || 'Not available' });
    else if (action === 'reopen') Object.assign(item, { status: item.kind === 'todo' ? 'todo' : 'waiting', note: '' });
    else throw new Error(`Unknown action ${action}`);
    if (c.state === 'approved') { if (action === 'reopen') c.sentAt = null; await checklistProgress(r); }
    else c.edited = true;
    saveRequests();
  },
  checklistMessage: (id) => checklistMessage(reqById(id)),
  // Send now, with what is done and why the rest is not.
  completeRequest: async (id, text) => { const r = reqById(id); await sendChecklist(r, String(text || '').trim() || checklistMessage(r)); saveRequests(); return true; },
  imageData: (p) => imageData(p),
  pasteImage: () => { const img = clipboard.readImage(); return img.isEmpty() ? null : img.toDataURL(); },

  showWhatsApp: () => whatsapp.show(),
  importWhatsAppChat: async () => {
    const r = await whatsapp.importOpenChat();
    return incoming({ channel: 'whatsapp', externalId: `wa-import:${r.chat}:${Date.now()}`, from: { name: r.chat, chat: r.chat }, text: r.text, images: r.images, receivedAt: Date.now() });
  },
  testWhatsApp: (chat) => whatsapp.send(chat, 'Test from AV Courier ✓'),
  checkGmail: () => gmail.check(),
  // Sign in with Google: opens Google's page in the browser; the account becomes the Gmail address.
  googleSignIn: async () => {
    const email = await google.signIn();
    if (email) settings.email.user = email;
    settings.email.login = 'google';
    saveSettings();
    activity(`Signed in to Google as ${email || 'your account'} for Gmail`);
    if (settings.email.watch) gmail.start();
    push('status', channelStatus());
    return email;
  },
  // The client JSON downloaded from Google Cloud: read here, so the ID and secret are never typed or pasted.
  googleLoadClient: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Google OAuth client file', properties: ['openFile'], filters: [{ name: 'Google client JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const c = readClientFile(fs.readFileSync(r.filePaths[0], 'utf8'));
    settings.email.googleClientId = c.id;
    settings.email.login = 'google';
    saveSettings();
    setSecret('googleClient', c.secret);
    push('status', channelStatus());
    return c.id;
  },
  googleSignOut: async () => {
    await google.signOut();
    settings.email.login = 'password';
    saveSettings();
    gmail.stop();
    activity('Signed out of Google for Gmail');
    push('status', channelStatus());
  },
  testEmail: (to) => sendMail({ to: to || mailUser(), subject: 'AV Courier test', text: 'Email from AV Courier works.' }),
  testClaude: async () => (await analyse({ text: 'Please send the Janmashtami sabha recording from Ahmedabad, 16 Aug, I think it was on drive 123', apiKey: getSecret('anthropic') })),

  // Phone remote (electron/remote.js). The phone itself may only call the
  // methods listed in remote.js PHONE_CALLS.
  syncInfo: () => ({ ...sync.info(), suggested: findGoogleDrive(), hostname: os.hostname() }),
  syncNow: async () => { const n = await sync.poll(); push('status', channelStatus()); if (sync.lastError) throw new Error(sync.lastError); return n; },
  remoteInfo: () => remote.info(),
  startPairing: async () => { const p = remote.startPairing(); return { ...p, qr: await QRCode.toDataURL(p.url, { margin: 1, width: 240 }) }; },
  revokePhone: (id) => { remote.revoke(id); activity('Phone unpaired'); push('status', channelStatus()); },
  // A request caught on the phone from WhatsApp or Gmail notifications.
  phoneRequest: async (msg) => {
    const text = String(msg.text || '').trim();
    const chat = msg.from?.chat || msg.from?.name;
    // WhatsApp Web on this PC may have seen the same message already.
    const dup = requests.find((r) => r.channel === msg.channel && (r.from.chat || r.from.name) === chat && text && r.text.includes(text) && Math.abs((msg.receivedAt || Date.now()) - r.lastAt) < 30 * 60000);
    if (dup) { dup.phoneSeen = true; return { id: dup.id, duplicate: true }; }
    // files: a spreadsheet the phone could not read itself (.xls, .ods), read here.
    const files = (Array.isArray(msg.files) ? msg.files : []).filter((f) => f && typeof f.name === 'string' && typeof f.data === 'string').slice(0, 5);
    const req = await incoming({ channel: msg.channel === 'email' ? 'email' : 'whatsapp', externalId: `phone:${msg.externalId}`, from: { name: msg.from?.name || chat, chat, address: msg.from?.address, phone: true }, subject: msg.subject || '', text, files, receivedAt: msg.receivedAt || Date.now(), forced: !!msg.scanned });
    const r = req || (text ? requests.find((x) => x.channel === msg.channel && (x.from.chat || x.from.name) === chat && x.text.includes(text)) : null);
    return { id: r?.id || null, status: r?.status || 'ignored' };
  },

  installSendTo: () => installSendTo(),
  openData: () => shell.openPath(DATA),
};

// ---------------------------------------------------------------- other computers
// Each computer records what it did and reads the others' records, in a label of
// the Gmail account the app already uses (or a shared folder), so a request
// handled on one computer shows as handled on all.
const syncBackends = {
  gmail: new GmailBackend({ config: () => ({ user: mailUser() }), auth: mailAuth, isReady: mailReady }),
  folder: new FolderBackend(() => settings.sync.folder),
};
sync = new RequestSync({
  backend: () => (settings.sync.enabled ? syncBackends[settings.sync.mode] || syncBackends.gmail : null),
  machine: () => settings.sync.machine || os.hostname(),
  getRequests: () => requests,
  onApplied: () => saveRequests(),
  store: { load: () => readJSON('sync-state.json', {}), save: (s) => writeJSON('sync-state.json', s) },
  log: activity,
});
function applySync() {
  const b = settings.sync.enabled ? syncBackends[settings.sync.mode] : null;
  if (b) { sync.start(60000); if (b.ready()) activity(`Sharing request status through ${b.where()}`); }
  else sync.stop();
  push('status', channelStatus());
}

// ---------------------------------------------------------------- phone remote
// Phone tokens are encrypted with the Windows account, like the passwords.
remote = new Remote({
  api, log: activity,
  store: { load: () => readJSON('phones.json', []), save: (d) => writeJSON('phones.json', d) },
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
});
remote.on('devices', () => push('status', channelStatus()));
notifier.phone = remote;
function applyRemote() {
  if (settings.remote.enabled) remote.start(settings.remote.port).catch((e) => activity(`Phone remote could not start on port ${settings.remote.port}: ${e.message}`)).finally(() => push('status', channelStatus()));
  else remote.stop().then(() => push('status', channelStatus()));
}

function rememberContact(c) {
  const key = (x) => `${x.channel}:${x.chat || x.address}`;
  settings.contacts = [c, ...settings.contacts.filter((x) => key(x) !== key(c))].slice(0, 200);
  saveSettings();
}

ipcMain.handle('call', async (_e, method, ...args) => {
  if (!Object.hasOwn(api, method)) throw new Error(`Unknown call ${method}`);
  return api[method](...args);
});

// Explorer: right-click → Send to → AV Courier.
function installSendTo() {
  const sendTo = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'AV Courier.lnk');
  const target = process.execPath;
  const args = app.isPackaged ? '' : `"${path.resolve(__dirname, '..')}"`;
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${sendTo.replace(/'/g, "''")}');$s.TargetPath='${target.replace(/'/g, "''")}';$s.Arguments='${args.replace(/'/g, "''")}';$s.Save()`;
  return new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-Command', ps], (e) => (e ? rej(e) : (activity('Added AV Courier to Explorer’s Send to menu'), res(sendTo)))));
}

const filesFromArgv = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && fs.existsSync(a) && path.resolve(a) !== path.resolve(__dirname, '..'));

app.on('second-instance', (_e, argv) => {
  showWin();
  const files = filesFromArgv(argv);
  if (files.length) push('add-files', files);
});

// ---------------------------------------------------------------- windows
function showWin() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 980, minHeight: 640, backgroundColor: '#16181d', title: 'AV Courier',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  const startFiles = filesFromArgv(process.argv);
  if (startFiles.length) win.webContents.once('did-finish-load', () => push('add-files', startFiles));
}

function updateTray(s = queue.snapshot()) {
  if (!tray) return;
  const run = s.jobs.find((j) => j.status === 'running');
  const pct = run && run.bytesTotal ? Math.floor((run.bytesDone / run.bytesTotal) * 100) : null;
  const n = openRequests().length;
  tray.setToolTip(`AV Courier${run ? ` — copying ${run.name} ${pct}%` : ''}${n ? ` — ${n} request${n > 1 ? 's' : ''} waiting` : ''}`);
  if (win && !win.isDestroyed()) win.setProgressBar(pct == null ? -1 : pct / 100, { mode: s.paused ? 'paused' : 'normal' });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.house.avcourier');
  createWindow();
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AV Courier', click: showWin },
    { label: 'Pause queue', click: () => queue.pause() },
    { label: 'Resume queue', click: () => queue.resume() },
    { label: 'WhatsApp window', click: () => whatsapp.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; whatsapp.quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWin);
  updateTray();
  if (settings.whatsapp.enabled) whatsapp.start();
  if (settings.email.watch) gmail.start();
  if (settings.remote.enabled) applyRemote();
  if (settings.sync.enabled) applySync();
  // Matches saved by an older version lack newer details (such as empty backup columns): find them again.
  for (const r of openRequests()) if (r.matches?.some((m) => !m.backups)) rematch(r);
  drives.scan().then(refreshFound);
  drives.watch(refreshFound);
  if (queue.jobs.some((j) => j.status === 'queued') && !queue.paused) queue._kick();
  if (process.env.AVC_SMOKE) require('./smoke')({ win, api, queue, out: process.env.AVC_SMOKE });
});

app.on('before-quit', () => { app.isQuitting = true; whatsapp.quitting = true; ocr.close(); });
app.on('window-all-closed', () => {});
