const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RequestSync, FolderBackend, GmailBackend, sameRequest, keyOf, parseRecord } = require('../electron/sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avc-sync-'));

// One "computer": its own request list and sync state, sharing one backend kind.
function computer(name, backend, clock) {
  let state = {};
  const c = { requests: [], saved: 0 };
  c.sync = new RequestSync({
    backend: () => backend, machine: () => name, getRequests: () => c.requests,
    onApplied: () => { c.saved++; c.sync.noteChanges(); },
    store: { load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = JSON.parse(JSON.stringify(s)); } },
    now: () => clock.t,
  });
  // What main.js does on every change: saveRequests() -> noteChanges().
  c.add = (r) => { c.requests.unshift({ status: 'new', history: [], ...r }); c.sync.noteChanges(); return c.requests[0]; };
  c.set = async (id, status, text) => {
    const r = c.requests.find((x) => x.id === id);
    r.status = status; r.history.push({ at: clock.t, text });
    c.sync.noteChanges();
    await c.sync.flush();
  };
  return c;
}

const wa = (id, at, text = 'Bhai folder 3034 no data joie che') => ({ id, channel: 'whatsapp', externalId: `wa:Ravi Patel:${at}`, from: { name: 'Ravi Patel', chat: 'Ravi Patel' }, text, receivedAt: at });

// A pretend Gmail IMAP server shared by every "computer" (one fake ImapFlow per session).
function fakeGmail() {
  const server = { boxes: new Map([['INBOX', []], ['[Gmail]/Trash', []]]), nextUid: 1, appended: [], sessions: 0 };
  const connect = () => {
    let selected = null;
    const box = () => server.boxes.get(selected);
    return {
      async connect() { server.sessions++; },
      async logout() {},
      async mailboxCreate(p) { if (server.boxes.has(p)) { const e = new Error('Command failed'); e.serverResponseCode = 'ALREADYEXISTS'; throw e; } server.boxes.set(p, []); },
      async append(p, raw, flags) {
        if (!server.boxes.has(p)) throw new Error('No such mailbox');
        server.appended.push({ box: p, flags, raw });
        server.boxes.get(p).push({ uid: server.nextUid++, raw, date: new Date(server.now ?? Date.now()) });
      },
      async getMailboxLock(p) { selected = p; return { release() { selected = null; } }; },
      get mailbox() { return { uidValidity: 7n }; },
      async search(q) { return box().filter((m) => !q.before || m.date < q.before).map((m) => m.uid); },
      async *fetch(uids, what) {
        for (const m of box().filter((x) => uids.includes(x.uid))) {
          yield what.source ? { uid: m.uid, source: Buffer.from(m.raw, 'latin1') } : { uid: m.uid, headers: Buffer.from(/^X-AVC-File:.*$/m.exec(m.raw)[0]) };
        }
      },
      async list() { return [...server.boxes.keys()].map((p) => ({ path: p, specialUse: p === '[Gmail]/Trash' ? '\\Trash' : undefined })); },
      async messageMove(uids, to) { const b = box(); server.boxes.get(to).push(...b.filter((m) => uids.includes(m.uid))); server.boxes.set(selected, b.filter((m) => !uids.includes(m.uid))); },
      async messageDelete(uids) { server.boxes.set(selected, box().filter((m) => !uids.includes(m.uid))); },
    };
  };
  return { server, connect };
}

test('a reply on the PC shows on the Mac, without echoing back', async () => {
  const dir = tmp(), clock = { t: 1_000_000 };
  const pc = computer('Office PC', new FolderBackend(() => dir), clock), mac = computer('MacBook', new FolderBackend(() => dir), clock);
  pc.add(wa('p1', clock.t));
  mac.add(wa('m1', clock.t + 4000)); // the Mac caught the same message a few seconds later
  clock.t += 60000;
  await pc.set('p1', 'replied', 'Replied on whatsapp: Hi Ravi, here is where it is');

  assert.equal(await mac.sync.poll(), 1);
  const r = mac.requests[0];
  assert.equal(r.status, 'replied');
  assert.match(r.history.at(-1).text, /Replied on whatsapp: Hi Ravi.* — on Office PC$/);
  assert.equal(mac.saved, 1);
  await mac.sync.flush();

  // The Mac does not write the PC's change back, and polling again changes nothing.
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('MacBook')).length, 0);
  assert.equal(await mac.sync.poll(), 0);
  assert.equal(await pc.sync.poll(), 0);
});

test('a computer that was off catches up, even for requests it sees later', async () => {
  const dir = tmp(), clock = { t: 9_000_000 };
  const pc = computer('Office PC', new FolderBackend(() => dir), clock);
  pc.add(wa('p1', clock.t));
  clock.t += 1000; await pc.set('p1', 'replied', 'Replied on whatsapp');
  clock.t += 1000; await pc.set('p1', 'delivered', 'Told Ravi Patel');

  const mac = computer('MacBook', new FolderBackend(() => dir), clock); // starts later, has not caught the message yet
  assert.equal(await mac.sync.poll(), 0);
  assert.equal(mac.sync.info().waiting, 2);
  mac.add(wa('m1', 9_000_000 + 30000)); // WhatsApp Web shows the old message once it loads
  assert.equal(await mac.sync.poll(), 2);
  assert.equal(mac.requests[0].status, 'delivered', 'the latest change wins');
  assert.equal(mac.requests[0].history.filter((h) => / — on Office PC$/.test(h.text)).length, 2, 'each update once');
  assert.equal(mac.sync.info().waiting, 0);
});

test('through the Gmail account: a label, nothing sent, both directions', async () => {
  const gmail = fakeGmail(), clock = { t: Date.UTC(2026, 9, 22, 9) };
  const account = () => ({ user: 'av.archive@gmail.com', pass: 'abcd efgh ijkl mnop' });
  const pc = computer('Office PC', new GmailBackend({ config: account, connect: gmail.connect }), clock);
  const mac = computer('MacBook', new GmailBackend({ config: account, connect: gmail.connect }), clock);
  pc.add(wa('p1', clock.t)); mac.add(wa('m1', clock.t + 2000));

  clock.t += 60000; await pc.set('p1', 'copying', 'Copy queued to E:\\Requests\\Ravi');
  assert.equal(await mac.sync.poll(), 1);
  assert.equal(mac.requests[0].status, 'copying');
  clock.t += 60000; await mac.set('m1', 'closed', 'Marked closed');
  assert.equal(await pc.sync.poll(), 1);
  assert.equal(pc.requests[0].status, 'closed');

  // Saved in the label only, already read; the inbox is untouched and nothing went through SMTP.
  assert.deepEqual([...gmail.server.boxes.keys()].sort(), ['AV Courier sync', 'INBOX', '[Gmail]/Trash']);
  assert.equal(gmail.server.boxes.get('INBOX').length, 0);
  assert.equal(gmail.server.appended.length, 2);
  for (const a of gmail.server.appended) {
    assert.equal(a.box, 'AV Courier sync');
    assert.deepEqual(a.flags, ['\\Seen']);
    assert.match(a.raw, /^To: av\.archive@gmail\.com\r$/m);
  }
  const rec = parseRecord(gmail.server.appended[0].raw);
  assert.match(rec.name, /^Office_PC-[0-9a-f]{6}\.jsonl$/);
  assert.equal(JSON.parse(rec.text).status, 'copying');
  assert.equal(pc.sync.info().where, 'Gmail label “AV Courier sync” in av.archive@gmail.com');
});

test('Gmail: updates made offline are written later; month-old records go to the bin', async () => {
  const gmail = fakeGmail(), clock = { t: Date.UTC(2026, 9, 1) };
  let online = false;
  const connect = (cfg) => { if (!online) throw new Error('getaddrinfo ENOTFOUND imap.gmail.com'); return gmail.connect(cfg); };
  const pc = computer('Office PC', new GmailBackend({ config: () => ({ user: 'a@gmail.com', pass: 'x' }), connect }), clock);
  pc.add(wa('p1', clock.t));
  await pc.set('p1', 'replied', 'Replied');
  assert.equal(pc.sync.info().unsent, 1);
  assert.match(pc.sync.info().error, /ENOTFOUND/);
  online = true;
  gmail.server.now = clock.t;
  await pc.sync.flush();
  assert.equal(pc.sync.info().unsent, 0);
  assert.equal(gmail.server.boxes.get('AV Courier sync').length, 1);

  // 40 days later a fresh start tidies its own old record away.
  clock.t += 40 * 86400000;
  const later = computer('Office PC', new GmailBackend({ config: () => ({ user: 'a@gmail.com', pass: 'x' }), connect: gmail.connect }), clock);
  later.sync.me = pc.sync.me;
  await later.sync.poll();
  assert.equal(gmail.server.boxes.get('AV Courier sync').length, 0);
  assert.equal(gmail.server.boxes.get('[Gmail]/Trash').length, 1);
});

test("Gmail's own reason replaces \"Command failed\"", () => {
  const { imapError } = require('../electron/mail');
  const err = (props) => Object.assign(new Error('Command failed'), props);
  assert.match(imapError(err({ authenticationFailed: true, responseText: 'Invalid credentials (Failure)', serverResponseCode: 'AUTHENTICATIONFAILED' })).message,
    /^Gmail refused the login \(Invalid credentials \(Failure\) \[AUTHENTICATIONFAILED\]\)\..*App Password/);
  assert.match(imapError(err({ responseText: 'IMAP access is disabled for your domain.' })).message, /IMAP access is disabled.*administrator must allow IMAP/);
  assert.match(imapError(err({ responseText: 'Unknown Mailbox: Inbx', serverResponseCode: 'NONEXISTENT' })).message, /no folder or label by that name.*INBOX/);
  assert.equal(imapError(err({ responseText: 'Something new' })).message, 'Gmail: Something new');
  assert.equal(imapError(Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), { code: 'ENOTFOUND' })).message,
    'Could not reach Gmail: no internet, or the network did not answer (ENOTFOUND). It tries again at the next check.');
  assert.equal(imapError(new Error('Something else')).message, 'Something else');
});

test('requests match by email Message-ID, or WhatsApp chat, words and time', () => {
  const at = 1_000_000;
  const email = { channel: 'email', externalId: '<abc@mail.gmail.com>', from: { name: 'Asha', address: 'a@x.in' }, text: 'Please send the Gurupurnima video', receivedAt: at };
  assert.ok(sameRequest(keyOf(email), { ...email, receivedAt: at + 86400000 }), 'same Message-ID, any time');
  assert.ok(!sameRequest(keyOf(email), { ...email, externalId: '<other@mail.gmail.com>' }), 'two different emails');
  const m = wa('a', at);
  assert.ok(sameRequest(keyOf(m), { ...wa('b', at + 5 * 60000), text: '\u202ABhai folder 3034 no data joie che\u202C\nand 3035' }), 'WhatsApp marks and later messages');
  assert.ok(!sameRequest(keyOf(m), wa('b', at + 2 * 3600000)), 'same words two hours later is a new request');
  assert.ok(!sameRequest(keyOf(m), { ...wa('b', at), from: { name: 'Mehul', chat: 'Mehul' } }), 'other chat');
  assert.ok(!sameRequest(keyOf(m), { ...wa('b', at), channel: 'email' }), 'other channel');
});

test('sharing off: nothing is written or read', async () => {
  const clock = { t: 1 };
  const c = computer('PC', null, clock);
  c.add(wa('x', 1));
  await c.set('x', 'replied', 'Replied');
  assert.equal(await c.sync.poll(), 0);
  assert.equal(c.sync.info().where, '');
});
