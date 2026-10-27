const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Remote, isLan, PHONE_CALLS } = require('../electron/remote');
const { Notifier } = require('../electron/notifier');

// Stand-in for safeStorage: reversible, but never the plain token.
const encrypt = (s) => Buffer.from(s.split('').reverse().join('')).toString('base64');
const decrypt = (b) => Buffer.from(b, 'base64').toString().split('').reverse().join('');

function memStore() {
  let saved = [];
  return { load: () => JSON.parse(JSON.stringify(saved)), save: (d) => { saved = JSON.parse(JSON.stringify(d)); }, get raw() { return saved; } };
}

const fakeApi = () => {
  const calls = [];
  return {
    calls,
    state: () => ({ version: '0.1.0', queue: { paused: false, running: false, current: null, jobs: [{ id: 'j1', name: 'Job', files: [{ src: 'a' }], log: [] }] }, requests: [{ id: 'r1', status: 'new', from: { name: 'Ravi' }, text: 'folder 3034 joie che', analysis: { summary: 's' }, matches: [], history: [] }, { id: 'r2', status: 'closed', from: { name: 'Old' }, text: '' }], status: {}, templates: {} }),
    pause: () => { calls.push('pause'); return true; },
    holdJob: (id, on) => { calls.push(['holdJob', id, on]); },
    setSecret: () => { calls.push('setSecret'); },
  };
};

async function started(opts = {}) {
  const store = opts.store || memStore();
  const api = opts.api || fakeApi();
  const r = new Remote({ api, store, encrypt, decrypt, sendTimeoutMs: opts.sendTimeoutMs || 3000 });
  await r.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${r.port}`;
  const req = (method, p, body, token) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { r, store, api, base, req };
}

test('pairing: one-time code gives a per-phone token, stored encrypted', async (t) => {
  const { r, store, req } = await started();
  t.after(() => r.stop());
  assert.equal((await req('POST', '/pair', { code: '000000', name: 'x' })).status, 403, 'no code shown yet');
  const { code, url } = r.startPairing();
  assert.match(code, /^\d{6}$/);
  assert.match(url, new RegExp(`^avcourier://pair\\?.*p=${r.port}&c=${code}$`));
  const wrong = code === '123456' ? '654321' : '123456';
  assert.equal((await req('POST', '/pair', { code: wrong, name: 'Pixel' })).status, 403);
  const ok = await req('POST', '/pair', { code, name: 'Pixel' });
  assert.equal(ok.status, 200);
  const { token, deviceId } = await ok.json();
  assert.ok(token.length >= 40 && deviceId);
  assert.equal((await req('POST', '/pair', { code, name: 'Second' })).status, 403, 'the code works only once');

  assert.equal(store.raw.length, 1);
  assert.ok(!JSON.stringify(store.raw).includes(token), 'token is not saved in plain text');
  assert.equal(r.devices()[0].token, undefined, 'device list never shows tokens');
  assert.equal((await (await req('GET', '/api/ping', null, token)).json()).device, 'Pixel');

  // After a restart the same token still works.
  const again = await started({ store });
  t.after(() => again.r.stop());
  assert.equal((await again.req('GET', '/api/ping', null, token)).status, 200);
});

test('pairing: too many wrong codes cancel the code', async (t) => {
  const { r, req } = await started();
  t.after(() => r.stop());
  const { code } = r.startPairing();
  const wrong = code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) await req('POST', '/pair', { code: wrong });
  assert.equal((await req('POST', '/pair', { code })).status, 403);
});

test('unauthenticated, wrong, revoked tokens and disallowed calls are refused', async (t) => {
  const { r, api, req } = await started();
  t.after(() => r.stop());
  const { code } = r.startPairing();
  const { token, deviceId } = await (await req('POST', '/pair', { code, name: 'Phone' })).json();

  for (const p of ['/api/ping', '/api/state', '/api/events', '/api/outbox']) assert.equal((await req('GET', p)).status, 401, p);
  assert.equal((await req('POST', '/api/call', { method: 'pause' })).status, 401);
  assert.equal((await req('POST', '/api/call', { method: 'pause' }, 'not-a-token')).status, 401);
  assert.equal((await req('POST', '/api/call', { method: 'pause' }, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).status, 401);
  assert.deepEqual(api.calls, [], 'nothing ran');

  assert.equal((await req('POST', '/api/call', { method: 'setSecret', args: ['gmail', 'x'] }, token)).status, 403, 'secrets stay on the PC');
  assert.equal((await req('POST', '/api/call', { method: 'constructor' }, token)).status, 403);
  const res = await req('POST', '/api/call', { method: 'holdJob', args: ['j1', false] }, token);
  assert.equal(res.status, 200);
  assert.deepEqual(api.calls, [['holdJob', 'j1', false]]);

  const state = await (await req('GET', '/api/state', null, token)).json();
  assert.deepEqual(state.requests.map((x) => x.id), ['r1', 'r2'], 'every state goes to the phone, which sorts them into Open, Done, All');
  assert.equal(state.queue.jobs[0].files, undefined, 'file lists stay on the PC');

  r.revoke(deviceId);
  assert.equal((await req('GET', '/api/ping', null, token)).status, 401, 'unpaired phone is refused');
});

test('only local network addresses are served', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.1', '169.254.3.3', 'fe80::1', 'fd12::3']) assert.ok(isLan(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '::ffff:49.36.1.1', '2401:4900::1', '']) assert.ok(!isLan(a), a);
});

// A phone listening on the event stream that "sends" each message it is given.
function fakePhone(base, token, reply = { ok: true, route: 'phone-reply' }) {
  const got = [];
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', async (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev === 'send') {
            const m = JSON.parse(data);
            got.push(m);
            await fetch(`${base}/api/sent`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: m.id, ...reply }) });
          }
        }
      });
      resolve({ got, close: () => req.destroy() });
    });
  });
}

async function pairedPhone(opts) {
  const s = await started(opts);
  const { code } = s.r.startPairing();
  const { token } = await (await s.req('POST', '/pair', { code, name: 'Phone' })).json();
  return { ...s, token };
}

const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('phone channel: WhatsApp Web failing or unlinked hands the message to the phone', async (t) => {
  const { r, base, token } = await pairedPhone();
  t.after(() => r.stop());
  const logs = [];
  const wa = { status: 'ready', sent: [], send: async (chat) => { wa.sent.push(chat); throw new Error('chat not found'); } };
  const n = new Notifier({ getTemplates: () => ({}), sendEmail: async () => {}, whatsapp: wa, phone: r, log: (s) => logs.push(s) });
  const to = { channel: 'whatsapp', name: 'Ravi Patel', chat: 'Ravi Patel' };

  await assert.rejects(n.send(to, 'hello'), /chat not found/, 'no phone connected: the PC error stands');

  const phone = await fakePhone(base, token);
  t.after(() => phone.close());
  await waitFor(() => r.available());
  assert.equal(await n.send(to, 'Your data is ready'), 'phone-reply');
  assert.deepEqual(wa.sent, ['Ravi Patel', 'Ravi Patel'], 'tried WhatsApp Web first');
  assert.equal(phone.got.at(-1).text, 'Your data is ready');
  assert.equal(phone.got.at(-1).to.chat, 'Ravi Patel');
  assert.match(logs.at(-1), /through the phone \(phone-reply\) — WhatsApp Web failed: chat not found/);

  // Not linked on the PC: straight to the phone.
  wa.status = 'qr';
  const results = await n.jobFinished({ name: 'Garba 17 Oct', status: 'done', count: 3, done: 3, failed: 0, bytesTotal: 1e9, dest: 'E:\\Out', notify: [to] });
  assert.deepEqual(results, [{ to: 'Ravi Patel', ok: true, route: 'phone-reply' }]);
  assert.equal(wa.sent.length, 2, 'WhatsApp Web was not tried');
  assert.match(logs.at(-1), /WhatsApp Web on the PC is qr/);
  assert.match(phone.got.at(-1).text, /Garba 17 Oct: 3 files/);

  // Working WhatsApp Web stays the first route.
  wa.status = 'ready';
  wa.send = async (chat) => { wa.sent.push(chat); return true; };
  assert.equal(await n.send(to, 'x'), 'whatsapp-web');
  assert.equal(phone.got.length, 2);
});

test('phone channel: a phone that cannot send is reported as a failure', async (t) => {
  const { r, base, token } = await pairedPhone();
  t.after(() => r.stop());
  const phone = await fakePhone(base, token, { ok: false, error: 'No reply action for this chat' });
  t.after(() => phone.close());
  await waitFor(() => r.available());
  const n = new Notifier({ getTemplates: () => ({}), whatsapp: { status: 'off' }, phone: r, log: () => {} });
  const results = await n.jobFinished({ name: 'J', status: 'done', count: 1, done: 1, failed: 0, bytesTotal: 1, dest: 'D:', notify: [{ channel: 'whatsapp', name: 'Asha', chat: 'Asha' }] });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /No reply action/);
});

test('phone channel: unconfirmed messages time out and leave the outbox', async (t) => {
  const { r, base, token } = await pairedPhone({ sendTimeoutMs: 150 });
  t.after(() => r.stop());
  const silent = await new Promise((res) => { const q = http.get(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` } }, () => res(q)); });
  t.after(() => silent.destroy());
  await waitFor(() => r.available());
  await assert.rejects(r.sendViaPhone({ channel: 'whatsapp', name: 'A', chat: 'A' }, 'hi'), /did not confirm/);
  assert.equal(r.outbox.size, 0);
});

test('the phone may mark requests as not a request, but not delete them or touch settings', () => {
  assert.ok(PHONE_CALLS.has('dismissRequests'));
  for (const m of ['deleteRequest', 'setSettings', 'setSecret', 'googleSignIn', 'phoneCatalog']) assert.ok(!PHONE_CALLS.has(m), m);
});

test('verified businesses and ignored senders are never requests', () => {
  const { ignoredReason, senderKey } = require('../electron/senders');
  const lists = {
    verified: ['Urban Company', '‪ICICI Bank‬'],
    ignored: [{ key: 'whatsapp:dada bhagwan foundation adalaj', channel: 'whatsapp', name: 'Dada Bhagwan Foundation Adalaj' },
      { key: 'email:alerts@bank.in', channel: 'email', name: 'alerts@bank.in', display: 'Bank Alerts' }],
  };
  const wa = (chat) => ({ channel: 'whatsapp', from: { name: chat, chat } });
  assert.equal(ignoredReason(wa('urban company'), lists), 'verified business');
  assert.equal(ignoredReason(wa('ICICI Bank'), lists), 'verified business', 'WhatsApp direction marks do not matter');
  assert.equal(ignoredReason(wa('Dada  Bhagwan Foundation Adalaj'), lists), 'ignored sender');
  assert.equal(ignoredReason(wa('Swapnil Patel'), lists), '');
  assert.equal(ignoredReason({ channel: 'email', from: { name: 'Bank Alerts', address: 'alerts@bank.in' } }, lists), 'ignored sender');
  assert.equal(ignoredReason({ channel: 'email', from: { name: 'Bank Alerts' } }, lists), 'ignored sender', 'phone emails carry only the name');
  assert.equal(ignoredReason({ channel: 'email', from: { name: 'Urban Company', address: 'x@uc.in' } }, lists), '', 'the WhatsApp badge says nothing about email');
  assert.equal(senderKey('email', { name: 'Swapnil', address: 'Swapnil@Gmail.com' }), 'email:swapnil@gmail.com');
});

test('WhatsApp replies carry the message they answer', async () => {
  const { withQuote, quoteLine } = require('../electron/notifier');
  assert.equal(withQuote('Hi Ravi, here is where it is', '‪Bhai folder 3046 no data joie che‬\nand 3047'), '> Bhai folder 3046 no data joie che\n\nHi Ravi, here is where it is');
  assert.equal(withQuote('Hi', ''), 'Hi', 'nothing to quote: unchanged');
  assert.equal(quoteLine('\n\n  Raw data requirement  \n\nNeed raw folder 3046'), 'Raw data requirement');
  assert.equal(quoteLine('x'.repeat(300)).length, 200);

  const calls = [];
  const wa = { status: 'ready', send: async (chat, text, opts) => { calls.push({ chat, text, opts }); return { quoted: 'reply' }; } };
  const logs = [];
  const n = new Notifier({ getTemplates: () => ({}), whatsapp: wa, log: (s) => logs.push(s) });
  assert.equal(await n.send({ channel: 'whatsapp', name: 'Ravi', chat: 'Ravi', quote: 'Bhai folder 3046 no data joie che' }, 'Hi Ravi'), 'whatsapp-web');
  assert.deepEqual(calls[0], { chat: 'Ravi', text: 'Hi Ravi', opts: { quote: 'Bhai folder 3046 no data joie che' } });
  assert.match(logs.at(-1), /as a reply to their message/);
});
