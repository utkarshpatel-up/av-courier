// Request status shared between computers. Each computer records what it did
// ("replied", "copy queued", "delivered", "closed") and reads what the others did,
// so a request handled on one shows as handled on the others. Only request status
// travels: queues, drives and the catalogue stay on their own computer.
//
// Where the records live:
// - GmailBackend: a label ("AV Courier sync") in the Gmail account the app already
//   uses for requests. Records are saved straight into the label with IMAP, never
//   sent, already read, and never in the inbox. Nothing else to set up.
// - FolderBackend: any folder both computers sync (Google Drive for desktop,
//   OneDrive, a network share).
// Either way each computer writes only its own records, so they never collide.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEEP_DAYS = 30;
const MATCH_WINDOW = 20 * 60000; // the same WhatsApp message, caught on two computers
const PENDING_DAYS = 3;          // how long to wait for a request this computer has not seen yet

const norm = (s) => String(s || '').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// What identifies a request on every computer: an email's Message-ID is the same
// everywhere; a WhatsApp message is matched by chat, opening words and time.
function keyOf(r) {
  const id = String(r.externalId || '');
  return {
    channel: r.channel,
    messageId: r.channel === 'email' && id && !/^(uid-|phone:|manual:)/.test(id) ? id : '',
    chat: norm(r.from?.chat || r.from?.name),
    head: norm(r.text).slice(0, 60),
    at: r.receivedAt || 0,
  };
}

function sameRequest(k, r) {
  if (!k || k.channel !== r.channel) return false;
  if (k.messageId && r.externalId === k.messageId) return true;
  const o = keyOf(r);
  if (k.messageId && o.messageId) return false; // two different emails
  // One computer may have joined later messages onto the request: compare the shared start.
  const n = Math.min(k.head.length, o.head.length);
  return n >= 8 && k.chat === o.chat && k.head.slice(0, n) === o.head.slice(0, n) && Math.abs(k.at - o.at) < MATCH_WINDOW;
}

const parseLines = (text) => String(text || '').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });

// ---------------------------------------------------------------- shared folder
class FolderBackend {
  constructor(dir) { this.dir = dir; } // dir(): the folder, '' when not set
  ready() { return !!this.dir(); }
  where() { return this.dir(); }

  async _d() { const d = this.dir(); await fs.promises.mkdir(d, { recursive: true }); return d; }
  async append(name, text) { await fs.promises.appendFile(path.join(await this._d(), name), text); }

  async readAll() {
    const d = await this._d();
    const out = [];
    for (const f of await fs.promises.readdir(d)) {
      if (!f.endsWith('.jsonl')) continue;
      try { out.push({ name: f, text: await fs.promises.readFile(path.join(d, f), 'utf8') }); } catch { /* still syncing */ }
    }
    return out;
  }

  async compact(name, cutoff) {
    const p = path.join(await this._d(), name);
    let text;
    try { text = await fs.promises.readFile(p, 'utf8'); } catch { return; }
    const keep = parseLines(text).filter((e) => e.at >= cutoff);
    await fs.promises.writeFile(p, keep.map((e) => JSON.stringify(e) + '\n').join(''));
  }
}

// ---------------------------------------------------------------- Gmail label
const b64lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

function parseRecord(source) {
  const raw = Buffer.isBuffer(source) ? source.toString('latin1') : String(source);
  const split = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  if (split < 0) return null;
  const head = raw.slice(0, split);
  const name = /^X-AVC-File:\s*(.+)$/im.exec(head)?.[1]?.trim();
  if (!name) return null;
  const body = raw.slice(split).trim();
  const text = /^Content-Transfer-Encoding:\s*base64/im.test(head) ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : Buffer.from(body, 'latin1').toString('utf8');
  return { name, text };
}

class GmailBackend {
  // config(): { user, pass? } — the Gmail address (and App Password) the app already has.
  // auth(): optional, async — { pass } or { accessToken } (Sign in with Google).
  // isReady(): optional — whether a login is set up.
  // connect(cfg): a new ImapFlow client (replaced in tests).
  constructor({ config, auth, isReady, mailbox = 'AV Courier sync', connect }) {
    this.config = config;
    this.auth = auth;
    this.isReady = isReady;
    this.mailbox = mailbox;
    this.connect = connect || ((cfg) => {
      const { ImapFlow } = require('imapflow');
      return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: require('./mail').imapAuth(cfg), logger: false });
    });
    this.cache = new Map(); // uid -> { name, text }
    this.uidValidity = null;
    this.created = false;
  }

  ready() { if (this.isReady) return this.isReady(); const c = this.config(); return !!(c.user && c.pass); }
  where() { return `Gmail label “${this.mailbox}” in ${this.config().user}`; }

  async _session(fn) {
    const cfg = { ...this.config(), ...(this.auth ? await this.auth() : {}) };
    let client;
    try {
      client = this.connect(cfg);
      await client.connect();
    } catch (e) {
      throw require('./mail').imapError(e);
    }
    try {
      if (!this.created) {
        try { await client.mailboxCreate(this.mailbox); } catch (e) { if (!/exist/i.test(`${e.message} ${e.responseText || ''} ${e.serverResponseCode || ''}`)) throw e; }
        this.created = true;
      }
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // A record is saved into the label, already read: it is never sent to anyone.
  async append(name, text) {
    const user = this.config().user;
    const raw = [
      `From: AV Courier <${user}>`, `To: ${user}`, `Subject: AV Courier sync: ${name}`, `X-AVC-File: ${name}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@avcourier>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(text),
    ].join('\r\n');
    await this._session((c) => c.append(this.mailbox, raw, ['\\Seen']));
  }

  async readAll() {
    return this._session(async (c) => {
      const lock = await c.getMailboxLock(this.mailbox);
      try {
        const validity = String(c.mailbox?.uidValidity ?? '');
        if (validity !== this.uidValidity) { this.cache.clear(); this.uidValidity = validity; }
        const uids = (await c.search({ all: true }, { uid: true })) || [];
        const live = new Set(uids);
        for (const u of [...this.cache.keys()]) if (!live.has(u)) this.cache.delete(u);
        const fresh = uids.filter((u) => !this.cache.has(u));
        if (fresh.length) {
          for await (const m of c.fetch(fresh, { uid: true, source: true }, { uid: true })) {
            this.cache.set(m.uid, parseRecord(m.source) || { name: '', text: '' });
          }
        }
        // One "file" per computer, joined from its records.
        const files = new Map();
        for (const [, r] of [...this.cache.entries()].sort((a, b) => a[0] - b[0])) {
          if (r.name) files.set(r.name, (files.get(r.name) || '') + r.text);
        }
        return [...files].map(([name, text]) => ({ name, text }));
      } finally {
        lock.release();
      }
    });
  }

  // This computer's records older than a month go to the Gmail bin.
  async compact(name, cutoff) {
    await this._session(async (c) => {
      const lock = await c.getMailboxLock(this.mailbox);
      try {
        const old = (await c.search({ before: new Date(cutoff) }, { uid: true })) || [];
        if (!old.length) return;
        const mine = [];
        for await (const m of c.fetch(old, { uid: true, headers: ['x-avc-file'] }, { uid: true })) {
          if (String(m.headers || '').toLowerCase().includes(name.toLowerCase())) mine.push(m.uid);
        }
        if (!mine.length) return;
        const trash = (await c.list()).find((b) => b.specialUse === '\\Trash');
        if (trash) await c.messageMove(mine, trash.path, { uid: true });
        else await c.messageDelete(mine, { uid: true });
      } finally {
        lock.release();
      }
    });
  }
}

// Google Drive for desktop's "My Drive" folder, if it is on this computer.
function findGoogleDrive() {
  const home = os.homedir();
  const out = [];
  if (process.platform === 'win32') {
    for (const l of 'GHIJKLMNOPQRSTUVWXYZ') out.push(`${l}:\\My Drive`);
    out.push(path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'My Drive'), path.join(home, 'Google Drive'));
  } else {
    const cloud = path.join(home, 'Library', 'CloudStorage');
    try { for (const d of fs.readdirSync(cloud)) if (d.startsWith('GoogleDrive-')) out.push(path.join(cloud, d, 'My Drive')); } catch { /* no Drive */ }
    out.push(path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'Google Drive'));
  }
  const found = out.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  return found ? path.join(found, 'AV Courier sync') : '';
}

// ---------------------------------------------------------------- the sync itself
class RequestSync {
  // backend(): a FolderBackend or GmailBackend, or null when sharing is off.
  // machine(): this computer's name. getRequests(): the live request list.
  // onApplied(): save after changes from elsewhere. store: { load(), save(state) }.
  constructor({ backend, machine, getRequests, onApplied, store, log, now = Date.now }) {
    Object.assign(this, { backend, machine, getRequests, onApplied, store, log: log || (() => {}), now });
    const s = store?.load() || {};
    this.me = s.me || crypto.randomBytes(3).toString('hex'); // keeps two computers with the same name apart
    this.seen = s.seen || {};          // request id -> status last published or applied
    this.applied = new Set(s.applied || []);
    this.pending = s.pending || [];    // others' updates for requests not caught here yet
    this.outbox = s.outbox || [];      // this computer's updates not written yet (offline)
    this.lastPoll = 0;
    this.lastError = '';
    this.others = [];
    this.timer = null;
    this.compacted = false;
    this.writing = Promise.resolve();
    this.polling = null;
  }

  _save() {
    this.store?.save({ me: this.me, seen: this.seen, applied: [...this.applied].slice(-5000), pending: this.pending, outbox: this.outbox });
  }

  _file() {
    const name = String(this.machine() || os.hostname()).replace(/[^\w.-]+/g, '_').slice(0, 40);
    return `${name}-${this.me}.jsonl`;
  }

  _ready() { const b = this.backend(); return b && b.ready() ? b : null; }

  // Call after any change to the requests: records status changes made here.
  noteChanges() {
    let added = 0;
    for (const r of this.getRequests()) {
      const before = this.seen[r.id];
      if (before === undefined) { this.seen[r.id] = r.status; continue; } // just arrived: "new" is not news
      if (before === r.status) continue;
      this.seen[r.id] = r.status;
      r.statusAt = this.now();
      const last = (r.history || []).at(-1);
      this.outbox.push({ id: crypto.randomBytes(8).toString('hex'), at: r.statusAt, machine: this.machine(), key: keyOf(r), status: r.status, note: last?.text || `Marked ${r.status}` });
      added++;
    }
    if (!added) return;
    this._save();
    this.flush();
  }

  // Writes waiting updates; one write at a time. Kept for later when offline.
  flush() {
    this.writing = this.writing.then(async () => {
      const b = this._ready();
      if (!b || !this.outbox.length) return;
      const batch = [...this.outbox];
      try {
        await b.append(this._file(), batch.map((e) => JSON.stringify(e) + '\n').join(''));
        this.outbox = this.outbox.filter((e) => !batch.includes(e));
        this._save();
        this.lastError = '';
      } catch (e) {
        this.lastError = e.message;
      }
    });
    return this.writing;
  }

  // Reads the other computers' updates and applies them. Returns how many changed a request.
  poll() {
    if (!this.polling) this.polling = this._poll().finally(() => { this.polling = null; });
    return this.polling;
  }

  async _poll() {
    const b = this._ready();
    if (!b) return 0;
    await this.flush();
    const mine = this._file();
    const cutoff = this.now() - KEEP_DAYS * 86400000;
    let files;
    try {
      if (!this.compacted) { await b.compact(mine, cutoff); this.compacted = true; }
      files = await b.readAll();
      this.lastError = '';
    } catch (e) {
      this.lastError = e.message;
      return 0;
    }
    const events = [];
    const others = new Set();
    for (const f of files) {
      if (f.name === mine) continue;
      for (const e of parseLines(f.text)) {
        if (!e.id || !e.key) continue;
        others.add(e.machine);
        if (e.at >= cutoff && !this.applied.has(e.id)) events.push(e);
      }
    }
    this.others = [...others];
    this.lastPoll = this.now();

    // Waiting updates are usually read again too: each counts once.
    const keep = this.now() - PENDING_DAYS * 86400000;
    const byId = new Map();
    for (const e of [...this.pending.filter((p) => p.at >= keep && !this.applied.has(p.id)), ...events]) byId.set(e.id, e);
    const todo = [...byId.values()].sort((x, y) => x.at - y.at);
    this.pending = [];
    const from = new Set();
    let changed = 0;
    const reqs = this.getRequests();
    for (const e of todo) {
      const r = reqs.find((x) => sameRequest(e.key, x));
      if (!r) { this.pending.push(e); continue; }
      this.applied.add(e.id);
      r.history = r.history || [];
      r.history.push({ at: e.at, text: `${e.note} — on ${e.machine}` });
      if (e.at > (r.statusAt || 0)) { // the latest change wins
        r.status = e.status;
        r.statusAt = e.at;
      }
      this.seen[r.id] = r.status;
      from.add(e.machine);
      changed++;
    }
    this._save();
    if (changed) {
      this.log(`${changed} request update${changed > 1 ? 's' : ''} from ${[...from].join(', ')}`);
      this.onApplied?.();
    }
    return changed;
  }

  start(everyMs = 60000) {
    this.stop();
    this.poll();
    this.timer = setInterval(() => this.poll(), everyMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  info() {
    const b = this.backend();
    return { where: b ? b.where() : '', ready: !!b?.ready(), machine: this.machine(), file: this._file(), lastPoll: this.lastPoll, error: this.lastError, others: this.others, waiting: this.pending.length, unsent: this.outbox.length };
  }
}

module.exports = { RequestSync, FolderBackend, GmailBackend, keyOf, sameRequest, findGoogleDrive, parseRecord };
