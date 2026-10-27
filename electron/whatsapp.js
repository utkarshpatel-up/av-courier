// WhatsApp Web inside the app, linked once with a QR code like any browser.
// Incoming: WhatsApp Web's own desktop notifications are captured (sender +
// text), plus a sweep of unread chats in the chat list as a fallback.
// Outgoing: the chat is opened through the search box and the message typed
// with real keystrokes, so it is sent exactly as if you had typed it.
// WhatsApp changes its page from time to time; the selectors live here only.
const { BrowserWindow, session } = require('electron');

const URL = 'https://web.whatsapp.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TAG = '__AVCOURIER__';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the WhatsApp page. Wraps Notification so each popup is also reported.
const HOOK = `(() => {
  if (window.${TAG}) return; window.${TAG} = true;
  const report = (title, opts) => console.log('${TAG}' + JSON.stringify({ kind: 'notification', title: String(title || ''), body: String(opts && opts.body || ''), tag: String(opts && opts.tag || ''), at: Date.now() }));
  const N = window.Notification;
  function Wrapped(title, opts) { report(title, opts); return new N(title, opts); }
  Wrapped.prototype = N.prototype;
  Object.defineProperty(Wrapped, 'permission', { get: () => N.permission });
  Wrapped.requestPermission = N.requestPermission.bind(N);
  window.Notification = Wrapped;
  if (window.ServiceWorkerRegistration) {
    const show = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) { report(title, opts); return show.call(this, title, opts); };
  }
})();`;

const STATE = `(() => {
  if (document.querySelector('canvas[aria-label*="QR" i], div[data-ref] canvas')) return 'qr';
  if (document.querySelector('#pane-side')) return 'ready';
  return 'loading';
})()`;

// Chats with an unread badge: title + last-message preview.
const UNREAD = `(() => {
  const rows = [...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')];
  return rows.map((row) => {
    const badge = row.querySelector('[aria-label*="unread" i]');
    if (!badge) return null;
    const titles = [...row.querySelectorAll('span[title]')].map((s) => s.getAttribute('title')).filter(Boolean);
    return { chat: titles[0] || '', preview: titles[titles.length - 1] || row.innerText.split('\\n').slice(-2, -1)[0] || '' };
  }).filter((r) => r && r.chat);
})()`;

// Every chat's latest preview, scrolling the chat list top to bottom. Reads text only;
// no chat is opened, so nothing is marked as read. "mine" = the preview is a message
// you sent (it has a tick icon); "self" = your own "Message yourself" chat.
const SWEEP = `(async () => {
  const pane = document.querySelector('#pane-side');
  if (!pane) return null;
  const seen = new Map();
  const grab = () => {
    for (const row of pane.querySelectorAll('[role="listitem"], [role="row"]')) {
      const lines = row.innerText.split('\\n').map((s) => s.trim()).filter(Boolean);
      const titled = [...row.querySelectorAll('span[title]')].map((s) => s.getAttribute('title')).filter(Boolean);
      const chat = titled[0] || lines[0] || '';
      if (!chat || seen.has(chat)) continue;
      const badge = row.querySelector('[aria-label*="unread" i]');
      const unread = badge ? +((badge.getAttribute('aria-label') || '').match(/\\d+/) || [1])[0] : 0;
      const preview = titled.length > 1 ? titled[titled.length - 1] : lines.slice(2).filter((l) => l !== String(unread)).join(' ');
      const mine = !!row.querySelector('[data-icon^="status-"], [data-icon*="check"], [data-icon="msg-time"]') || /^you:/i.test(preview);
      // "Message yourself" shows as "Your Name (You)", on one line or two.
      const self = /\\(you\\)/i.test(row.innerText) || /\\(you\\)/i.test(chat);
      // Today's messages show a clock time, yesterday's say "Yesterday".
      const recent = lines.some((l) => /^\\d{1,2}:\\d{2}(\\s?[ap]m)?$/i.test(l) || /^yesterday$/i.test(l));
      // Verified businesses carry a badge by their name (icon or label saying "verified").
      const verified = !!row.querySelector('[data-icon*="verified" i], [aria-label*="verified" i]');
      seen.set(chat, { chat, preview, unread, mine, self, today: recent, verified });
    }
  };
  const top = pane.scrollTop;
  pane.scrollTop = 0; await new Promise((r) => setTimeout(r, 500)); grab();
  for (let i = 0; i < 60 && seen.size < 300; i++) {
    const before = pane.scrollTop;
    pane.scrollTop += pane.clientHeight * 0.8;
    await new Promise((r) => setTimeout(r, 400));
    grab();
    if (pane.scrollTop === before) break;
  }
  pane.scrollTop = top;
  return [...seen.values()];
})()`;

// The last N messages of the open chat, with images as data URLs.
const OPEN_CHAT = (n) => `(async () => {
  const header = document.querySelector('#main header span[title], #main header [dir="auto"]');
  const chat = header ? (header.getAttribute('title') || header.textContent) : '';
  const nodes = [...document.querySelectorAll('#main [data-pre-plain-text], #main div[role="row"]')];
  const msgs = [];
  for (const row of nodes.slice(-${n})) {
    const pre = row.closest('[data-pre-plain-text]') || row.querySelector('[data-pre-plain-text]');
    const meta = pre ? pre.getAttribute('data-pre-plain-text') : '';
    const text = [...row.querySelectorAll('span.selectable-text, .copyable-text span')].map((s) => s.innerText).join('\\n').trim();
    const out = !!row.closest('.message-out') || !!row.querySelector('.message-out');
    const images = [];
    for (const img of row.querySelectorAll('img[src^="blob:"]')) {
      if (img.naturalWidth < 120) continue;
      try {
        const blob = await (await fetch(img.src)).blob();
        images.push(await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); }));
      } catch {}
    }
    if (text || images.length) msgs.push({ meta, text, out, images });
  }
  const seen = new Set();
  return { chat, messages: msgs.filter((m) => { const k = m.meta + m.text + m.images.length; if (seen.has(k)) return false; seen.add(k); return true; }) };
})()`;

class WhatsApp {
  // store: { load() -> { chat: lastPreview }, save(map) } remembers what the chat list
  // showed last time, so messages that came while the PC was off are still caught.
  // onVerified(chats): chats shown with a verified-business badge.
  constructor({ onMessage, onStatus, onVerified, log, store, sweepEveryMin = 2 }) {
    this.onMessage = onMessage;
    this.onVerified = onVerified;
    this.onStatus = onStatus;
    this.log = log;
    this.store = store;
    this.sweepEveryMin = sweepEveryMin;
    this.win = null;
    this.status = 'off';
    this.sending = Promise.resolve();
    this._seen = new Map();
    this._last = (store && store.load()) || null; // null = never swept on this PC
    this._sweptAt = 0;
  }

  // Compare every chat's latest preview with last time; new ones from others (or
  // anything in your own "Message yourself" chat) go through as incoming messages.
  async sweep() {
    const rows = await this._js(SWEEP);
    if (!rows) return 0;
    const first = this._last === null;
    const last = this._last || {};
    let n = 0;
    const verified = rows.filter((r) => r.verified).map((r) => r.chat);
    if (verified.length) this.onVerified?.(verified);
    for (const r of rows) {
      const changed = last[r.chat] !== r.preview;
      last[r.chat] = r.preview;
      if (!changed || !r.preview) continue;
      if (r.mine && !r.self) continue; // your own replies to others
      if (first && !(r.today || r.unread)) continue; // first run: only today's and yesterday's messages
      n++;
      this._incoming({ kind: r.self ? 'self' : 'sweep', title: r.chat, body: r.preview, at: Date.now() });
    }
    this._last = last;
    this._sweptAt = Date.now();
    this.store?.save(last);
    if (n) this.log?.(`WhatsApp chat list: ${n} new message${n > 1 ? 's' : ''} checked`);
    return n;
  }

  start() {
    if (this.win && !this.win.isDestroyed()) return;
    const ses = session.fromPartition('persist:whatsapp');
    ses.setUserAgent(UA);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'notifications'));
    ses.setPermissionCheckHandler((_wc, perm) => perm === 'notifications');
    this.win = new BrowserWindow({
      width: 1100, height: 800, show: false, title: 'WhatsApp (AV Courier)',
      webPreferences: { partition: 'persist:whatsapp', backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    this.win.on('close', (e) => { if (!this.quitting) { e.preventDefault(); this.win.hide(); } });
    const wc = this.win.webContents;
    wc.setWindowOpenHandler(({ url }) => { require('electron').shell.openExternal(url); return { action: 'deny' }; });
    wc.on('dom-ready', () => wc.executeJavaScript(HOOK).catch(() => {}));
    wc.on('console-message', (_e, _level, message) => {
      if (!message.startsWith(TAG)) return;
      try { this._incoming(JSON.parse(message.slice(TAG.length))); } catch {}
    });
    wc.loadURL(URL, { userAgent: UA });
    this._setStatus('loading');
    this.poll = setInterval(() => this._tick(), 15000);
    setTimeout(() => this._tick(), 5000);
  }

  stop() {
    clearInterval(this.poll);
    if (this.win && !this.win.isDestroyed()) { this.quitting = true; this.win.destroy(); }
    this.win = null;
    this._setStatus('off');
  }

  show() { this.start(); this.win.show(); this.win.focus(); }

  _setStatus(s) { if (s !== this.status) { this.status = s; this.onStatus?.(s); } }

  async _js(code) { return this.win.webContents.executeJavaScript(code, true); }

  async _tick() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      const s = await this._js(STATE);
      this._setStatus(s);
      if (s === 'qr' && !this.win.isVisible()) this.show();
      if (s === 'ready') {
        await this._js(HOOK);
        for (const u of await this._js(UNREAD)) this._incoming({ kind: 'unread', title: u.chat, body: u.preview, at: Date.now() });
        if (Date.now() - this._sweptAt > this.sweepEveryMin * 60000) await this.sweep();
      }
    } catch { /* page navigating */ }
  }

  _incoming({ title, body, at, kind }) {
    // Previews come wrapped in invisible direction marks (U+202A … U+202C).
    const strip = (s) => String(s || '').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim();
    title = strip(title); body = strip(body);
    // WhatsApp's own announcements are never requests.
    if (!title || !body || /^whatsapp$/i.test(title)) return;
    // The same message can arrive by notification and by the unread sweep.
    const key = `${title}\u0000${body}`;
    if (this._seen.has(key) && at - this._seen.get(key) < 6 * 3600000) return;
    this._seen.set(key, at);
    if (this._seen.size > 2000) this._seen = new Map([...this._seen].slice(-1000));
    // Group popups read "Sender: text"; direct chats have the contact as title.
    let sender = title, text = body;
    const m = /^([^:]{1,60}):\s([\s\S]+)$/.exec(body);
    if (m && (kind === 'notification' || kind === 'sweep') && !/^https?$/i.test(m[1])) { sender = `${m[1]} (${title})`; text = m[2]; }
    // Your own chat is an inbox: forward or paste a request there to add it.
    if (kind === 'self') sender = `${title} (forwarded to yourself)`;
    this.onMessage({
      channel: 'whatsapp',
      externalId: `wa:${title}:${at}`,
      from: { name: sender, chat: title },
      text,
      images: [],
      receivedAt: at,
      hasMedia: /📷|photo|image|📄|document/i.test(body) && body.length < 40,
    });
  }

  // Grab the open chat's recent messages (with pictures) as one request.
  async importOpenChat(n = 12) {
    if (this.status !== 'ready') throw new Error('Open WhatsApp and link it first');
    const r = await this._js(OPEN_CHAT(n));
    if (!r.chat) throw new Error('Open the chat in the WhatsApp window first');
    const incoming = r.messages.filter((m) => !m.out);
    return { chat: r.chat, text: incoming.map((m) => `${m.meta}${m.text}`.trim()).join('\n'), images: incoming.flatMap((m) => m.images).slice(0, 5) };
  }

  send(chat, text) {
    // One at a time: each send drives the same page.
    const run = this.sending.then(() => this._send(chat, text));
    this.sending = run.catch(() => {});
    return run;
  }

  async _key(code, modifiers = []) {
    const wc = this.win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
    await sleep(80);
  }

  async _send(chat, text) {
    this.start();
    for (let i = 0; i < 40 && this.status !== 'ready'; i++) { await sleep(1000); await this._tick(); }
    if (this.status !== 'ready') throw new Error(this.status === 'qr' ? 'WhatsApp needs to be linked: scan the QR code' : 'WhatsApp Web did not load');
    const wc = this.win.webContents;
    const q = JSON.stringify(chat);

    // Search box -> type the chat name -> click the exact match.
    const focused = await this._js(`(() => {
      const box = document.querySelector('#side div[contenteditable="true"], #side input[type="text"], div[contenteditable="true"][data-tab="3"]');
      if (!box) return false; box.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return true;
    })()`);
    if (!focused) throw new Error('WhatsApp search box not found');
    await wc.insertText(chat);
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      await sleep(300);
      opened = await this._js(`(() => {
        const hit = [...document.querySelectorAll('#pane-side span[title]')].find((s) => s.getAttribute('title') === ${q});
        if (!hit) return false;
        const row = hit.closest('[role="listitem"], [role="row"], [tabindex]') || hit;
        for (const t of ['mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(t, { bubbles: true }));
        return true;
      })()`);
    }
    if (!opened) throw new Error(`WhatsApp chat not found: ${chat}`);

    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(250);
      ready = await this._js(`(() => {
        const h = document.querySelector('#main header span[title], #main header [dir="auto"]');
        const box = document.querySelector('#main footer div[contenteditable="true"]');
        if (!box || !h || !(h.getAttribute('title') || h.textContent).includes(${q})) return false;
        box.focus(); return true;
      })()`);
    }
    if (!ready) throw new Error(`Could not open the chat with ${chat}`);

    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await wc.insertText(lines[i]);
      if (i < lines.length - 1) await this._key('Enter', ['shift']);
    }
    await sleep(200);
    await this._key('Enter');
    await sleep(1200);
    const last = JSON.stringify(lines.find(Boolean)?.slice(0, 30) || '');
    const sent = await this._js(`(() => {
      const outs = document.querySelectorAll('#main .message-out');
      const m = outs[outs.length - 1];
      return !!m && m.innerText.includes(${last});
    })()`);
    if (!sent) throw new Error('Message typed but not confirmed as sent: check the WhatsApp window');
    return true;
  }
}

module.exports = { WhatsApp };
