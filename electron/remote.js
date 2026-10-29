// Phone remote: a small HTTP server on the local network for the AV Courier
// Android app. Every route except /pair needs a per-phone token; a phone gets
// its token once, by typing (or scanning) the one-time code shown on the PC.
// Calls go through the same `api` object the window uses (see main.js).
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { rowLine } = require('./notifier');

// What a paired phone may call on `api`. Everything else (settings, secrets,
// file pickers, opening paths on the PC) stays on the PC.
const PHONE_CALLS = new Set([
  'search', 'reanalyse', 'setRequest', 'recipientFor', 'locatedMessage', 'notFoundMessage', 'replyToRequest',
  'addJob', 'pause', 'resume', 'skip', 'holdJob', 'cancelJob', 'retryJob', 'moveJob', 'notifyJob',
  'previewJobMessage', 'scanTape', 'rescanDrives', 'addManualRequest', 'phoneRequest', 'dismissRequests', 'ignoreSenders',
  'draftChecklist', 'itemFromRow', 'saveChecklist', 'setChecklist', 'pickCandidate', 'approveChecklist', 'addChecklistItem', 'checklistItem', 'checklistMessage', 'completeRequest', 'findOnDrives',
]);

const CODE_TTL = 10 * 60000;
const CODE_TRIES = 5;
// Calls carry at most a spreadsheet the phone could not read (10 MB, base64).
const MAX_BODY = 16 * 1024 * 1024;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Tailscale (and other carrier-grade NAT) addresses, 100.64.0.0/10: a private network
// that only the user's own devices join, so the phone can reach the PC off the office Wi-Fi.
function isTailscale(addr) {
  const m = /^100\.(\d+)\./.exec(String(addr || '').replace(/^::ffff:/i, ''));
  return !!m && +m[1] >= 64 && +m[1] <= 127;
}

// Private, loopback, link-local and Tailscale addresses only: the remote never answers the internet.
function isLan(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '');
  if (a === '::1' || a === '127.0.0.1' || /^127\./.test(a)) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (isTailscale(a)) return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/i.test(a);
}

// Office addresses first, Tailscale last: the phone tries them in this order.
function lanAddresses() {
  const all = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && isLan(i.address))
    .map((i) => i.address);
  return [...all.filter((a) => !isTailscale(a)), ...all.filter(isTailscale)];
}

const lineFor = (m) => { try { return rowLine(m); } catch { return m.title || m.id || ''; } };

// Requests and jobs trimmed to what the phone shows.
const slimRequest = (r) => ({
  id: r.id, channel: r.channel, from: r.from, subject: r.subject, text: r.text, status: r.status,
  receivedAt: r.receivedAt, lastAt: r.lastAt, summary: r.analysis?.summary || '', score: r.analysis?.score,
  matches: (r.matches || []).slice(0, 15).map((m) => ({ ...m, line: lineFor(m) })), jobIds: r.jobIds, history: (r.history || []).slice(-8),
  // Without catalogue rows; the other matches by title only (pickCandidate takes their place).
  checklist: r.checklist && { ...r.checklist, items: r.checklist.items.map(({ row, candidates, ...i }) => ({ ...i, candidates: (candidates || []).map((m) => m.title) })) },
});
const slimJob = (j) => {
  const { files, log, ...rest } = j; // a job can list thousands of files
  return rest;
};
const slimQueue = (q) => ({ paused: q.paused, running: q.running, current: q.current, jobs: q.jobs.map(slimJob) });

class Remote extends EventEmitter {
  // store: { load() -> devices[], save(devices) }; encrypt/decrypt: string <-> base64 (safeStorage in the app).
  constructor({ api, store, encrypt, decrypt, log, now = Date.now, sendTimeoutMs = 120000 }) {
    super();
    this.api = api;
    this.store = store;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.log = log || (() => {});
    this.now = now;
    this.sendTimeoutMs = sendTimeoutMs;
    this.server = null;
    this.port = 0;
    this.pairing = null; // { code, expiresAt, tries }
    this.clients = new Set(); // { res, device }
    this.outbox = new Map(); // id -> { id, to, text, subject, at, resolve, reject, timer }
    this._devices = [];
    this._hashes = new Map(); // device id -> sha256(token)
    this._loaded = false;
  }

  // Loaded on first use: safeStorage only works once Electron is ready.
  _load() {
    if (this._loaded) return;
    this._loaded = true;
    this._devices = (this.store?.load() || []).filter((d) => d && d.id && d.token);
    for (const d of this._devices) {
      try { this._hashes.set(d.id, sha(this.decrypt(d.token))); } catch { /* unreadable on this account: pair again */ }
    }
  }

  _save() { this.store?.save(this._devices); }

  devices() {
    this._load();
    const online = new Set([...this.clients].map((c) => c.device.id));
    return this._devices.map(({ token, ...d }) => ({ ...d, online: online.has(d.id) }));
  }

  revoke(id) {
    this._load();
    this._devices = this._devices.filter((d) => d.id !== id);
    this._hashes.delete(id);
    for (const c of [...this.clients]) if (c.device.id === id) { c.res.end(); this.clients.delete(c); }
    this._save();
  }

  // ------------------------------------------------------------ server
  start(port = 8765, host = '0.0.0.0') {
    if (this.server) return Promise.resolve(this.info());
    this._load();
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => this._json(res, 500, { error: e.message })));
    return new Promise((resolve, reject) => {
      this.server.once('error', (e) => { this.server = null; reject(e); });
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        this.log(`Phone remote listening on port ${this.port}`);
        resolve(this.info());
      });
    });
  }

  stop() {
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    for (const o of this.outbox.values()) { clearTimeout(o.timer); o.reject(new Error('Phone remote switched off')); }
    this.outbox.clear();
    const s = this.server;
    this.server = null;
    this.pairing = null;
    return new Promise((r) => (s ? s.close(() => r()) : r()));
  }

  info() {
    return { on: !!this.server, port: this.port, addresses: lanAddresses(), devices: this.devices(), pairing: this.pairing && this.now() < this.pairing.expiresAt ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null };
  }

  // A fresh six-digit code, valid once for ten minutes.
  startPairing() {
    if (!this.server) throw new Error('Switch the phone remote on first');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    this.pairing = { code, expiresAt: this.now() + CODE_TTL, tries: 0 };
    const hosts = lanAddresses();
    // What the QR code holds; the Android app reads it with its scanner.
    const url = `avcourier://pair?h=${encodeURIComponent(hosts.join(','))}&p=${this.port}&c=${code}`;
    return { code, expiresAt: this.pairing.expiresAt, addresses: hosts, port: this.port, url };
  }

  _pair(body) {
    const p = this.pairing;
    if (!p || this.now() > p.expiresAt) { this.pairing = null; return null; }
    const given = String(body.code || '').replace(/\D/g, '');
    if (given.length !== 6 || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(p.code))) {
      if (++p.tries >= CODE_TRIES) this.pairing = null; // too many guesses: show a new code
      return null;
    }
    this.pairing = null; // one-time
    const token = crypto.randomBytes(32).toString('base64url');
    const device = { id: crypto.randomBytes(6).toString('hex'), name: String(body.name || 'Phone').slice(0, 60), token: this.encrypt(token), pairedAt: this.now(), lastSeen: this.now() };
    this._devices.push(device);
    this._hashes.set(device.id, sha(token));
    this._save();
    this.log(`Phone paired: ${device.name}`);
    this.emit('devices');
    return { token, deviceId: device.id };
  }

  _auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const h = sha(m[1]);
    for (const d of this._devices) {
      const k = this._hashes.get(d.id);
      if (k && crypto.timingSafeEqual(k, h)) return d;
    }
    return null;
  }

  _json(res, code, body) {
    if (res.headersSent) return res.end();
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body ?? null));
  }

  _body(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Too large')); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new Error('Bad JSON')); } });
      req.on('error', reject);
    });
  }

  async _handle(req, res) {
    if (!isLan(req.socket.remoteAddress)) return this._json(res, 403, { error: 'Local network only' });
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /pair') {
      const r = this._pair(await this._body(req));
      return r ? this._json(res, 200, r) : this._json(res, 403, { error: 'Wrong or expired code. Show a new code on the PC.' });
    }

    const device = this._auth(req);
    if (!device) return this._json(res, 401, { error: 'Not paired' });
    device.lastSeen = this.now();

    switch (route) {
      case 'GET /api/ping': return this._json(res, 200, { app: 'AV Courier', device: device.name });
      case 'GET /api/state': return this._json(res, 200, this.state());
      case 'GET /api/events': return this._stream(req, res, device);
      case 'GET /api/catalog': return this._catalog(req, res);
      case 'GET /api/outbox': return this._json(res, 200, [...this.outbox.values()].map(({ id, to, text, subject, at }) => ({ id, to, text, subject, at })));
      case 'POST /api/sent': return this._json(res, 200, this._sent(await this._body(req), device));
      case 'POST /api/call': {
        const { method, args = [] } = await this._body(req);
        if (!PHONE_CALLS.has(method) || typeof this.api[method] !== 'function') return this._json(res, 403, { error: `Not allowed from the phone: ${method}` });
        try { return this._json(res, 200, { result: (await this.api[method](...(Array.isArray(args) ? args : [args]))) ?? null }); }
        catch (e) { return this._json(res, 400, { error: e.message }); }
      }
      default: return this._json(res, 404, { error: 'No such route' });
    }
  }

  // The catalogue for offline search on the phone: a header line, then one line per row, gzipped.
  // Made once per import and kept until the next one.
  _catalog(req, res) {
    const version = this.api.state().catalog?.importedAt || 0;
    if (!this._cat || this._cat.version !== version) {
      const x = this.api.phoneCatalog();
      const lines = [JSON.stringify({ version: x.version, sheets: x.sheets, rows: x.rows.length }), ...x.rows.map((r) => JSON.stringify(r))];
      this._cat = { version, gz: zlib.gzipSync(lines.join('\n') + '\n') };
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': this._cat.gz.length, 'X-Catalog-Version': String(version), 'Cache-Control': 'no-store' });
    res.end(this._cat.gz);
  }

  state() {
    const s = this.api.state();
    // The newest 200, whatever their state: the phone sorts them into Open, Maybe, In progress, Done, All.
    const open = s.requests.slice(0, 200);
    return { version: s.version, queue: slimQueue(s.queue), requests: open.map(slimRequest), status: s.status, templates: s.templates, recentDest: s.settings?.recentDest || [], catalogVersion: s.catalog?.importedAt || 0,
      ignored: { verified: s.settings?.whatsapp?.verifiedChats || [], ignored: s.settings?.ignoredSenders || [] } };
  }

  // ------------------------------------------------------------ server-sent events
  _stream(req, res, device) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    const client = { res, device };
    this.clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => { clearInterval(ping); this.clients.delete(client); this.emit('devices'); });
    this.emit('devices');
    // Anything waiting to be sent goes out as soon as a phone is listening.
    for (const o of this.outbox.values()) this._write(client, 'send', { id: o.id, to: o.to, text: o.text, subject: o.subject });
  }

  _write(client, event, data) { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  broadcast(event, data) {
    if (!this.clients.size) return;
    // Copy progress arrives four times a second: once a second is plenty for a phone.
    if (event === 'queue') {
      this._queueLatest = data;
      if (this._queueTimer) return;
      const since = this.now() - (this._queueAt || 0);
      if (since < 1000) { this._queueTimer = setTimeout(() => { this._queueTimer = null; this.broadcast('queue', this._queueLatest); }, 1000 - since); return; }
      this._queueAt = this.now();
      data = slimQueue(data);
    }
    if (event === 'requests') data = data.slice(0, 200).map(slimRequest);
    for (const c of this.clients) this._write(c, event, data);
  }

  // ------------------------------------------------------------ phone channel
  available() { return this.clients.size > 0; }

  // Hands a message to the paired phone, which sends it through its own WhatsApp
  // (the notification's reply action, or the chat opened with the text filled in).
  // Resolves with the phone's report: { route: 'phone-reply' | 'phone-opened' | ... }.
  sendViaPhone(to, text, subject) {
    if (!this.available()) return Promise.reject(new Error('No phone connected'));
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.outbox.delete(id); reject(new Error('The phone did not confirm the message')); }, this.sendTimeoutMs);
      this.outbox.set(id, { id, to, text, subject, at: this.now(), resolve, reject, timer });
      for (const c of this.clients) this._write(c, 'send', { id, to, text, subject });
    });
  }

  _sent(body, device) {
    const o = this.outbox.get(body.id);
    if (!o) return { ok: false, error: 'Unknown message' };
    clearTimeout(o.timer);
    this.outbox.delete(o.id);
    for (const c of this.clients) this._write(c, 'sent', { id: o.id });
    if (body.ok) o.resolve({ route: body.route || 'phone', device: device.name });
    else o.reject(new Error(body.error || 'The phone could not send it'));
    return { ok: true };
  }
}

module.exports = { Remote, isLan, isTailscale, lanAddresses, PHONE_CALLS };
