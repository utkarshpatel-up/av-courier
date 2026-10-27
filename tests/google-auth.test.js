const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { GoogleAuth } = require('../electron/google-auth');
const { imapAuth } = require('../electron/mail');
const { GmailBackend } = require('../electron/sync');

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

// Google, played by the test: checks what the app sends, answers like the real token endpoint.
function fakeGoogle({ grant = {}, refresh = {} } = {}) {
  const g = { calls: [], challenge: null };
  g.fetch = async (url, opts = {}) => {
    const body = Object.fromEntries(new URLSearchParams(opts.body || ''));
    g.calls.push({ url, body });
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    if (body.grant_type === 'authorization_code') {
      const ok = crypto.createHash('sha256').update(body.code_verifier).digest('base64url') === g.challenge;
      if (!ok || body.code !== 'the-code') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'access-1', expires_in: 3599, refresh_token: 'refresh-1', scope: 'openid https://mail.google.com/ email', id_token: jwt({ email: 'you@example.org' }), ...grant });
    }
    if (body.grant_type === 'refresh_token') return refresh.error ? json(400, { error: refresh.error }) : json(200, { access_token: 'access-2', expires_in: 3599 });
    return json(404, {});
  };
  // The "browser": reads Google's sign-in address and comes back to the app's one-time address.
  g.browser = (answer = (u) => ({ code: 'the-code', state: u.searchParams.get('state') })) => async (url) => {
    const u = new URL(url);
    g.signInUrl = u;
    g.challenge = u.searchParams.get('code_challenge');
    const back = new URL(u.searchParams.get('redirect_uri'));
    for (const [k, v] of Object.entries(answer(u))) back.searchParams.set(k, v);
    setTimeout(() => fetch(back).catch(() => {}), 5);
  };
  return g;
}

function auth(g, opts = {}) {
  let saved = null;
  const clock = { t: 1_000_000 };
  const a = new GoogleAuth({
    client: () => ({ id: 'client-1.apps.googleusercontent.com', secret: 'GOCSPX-test' }),
    tokens: { load: () => saved, save: (t) => { saved = t; } },
    openUrl: opts.openUrl || g.browser(), fetch: g.fetch, now: () => clock.t, signInTimeoutMs: 3000,
  });
  return { a, clock, stored: () => saved };
}

test('sign in with Google: browser page, one-time local address, PKCE, mail permission', async () => {
  const g = fakeGoogle();
  const { a, stored } = auth(g);
  assert.equal(await a.signIn(), 'you@example.org');

  const u = g.signInUrl;
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.ok(u.searchParams.get('scope').split(' ').includes('https://mail.google.com/'));

  assert.deepEqual(stored(), { refresh_token: 'refresh-1', email: 'you@example.org' }, 'only the lasting token and the address are kept');
  assert.ok(a.signedIn);
  assert.equal(await a.token(), 'access-1', 'no refresh while the token is fresh');
});

test('sign-in: cancelled, or a reply that is not ours, is refused', async () => {
  const g = fakeGoogle();
  await assert.rejects(auth(g, { openUrl: g.browser(() => ({ error: 'access_denied' })) }).a.signIn(), /cancelled/);
  const forged = auth(g, { openUrl: g.browser(() => ({ code: 'the-code', state: 'someone-else' })) });
  await assert.rejects(forged.a.signIn(), /failed/);
  assert.equal(forged.stored(), null);
  const noMail = fakeGoogle({ grant: { scope: 'openid email' } });
  await assert.rejects(auth(noMail).a.signIn(), /Mail access was not granted/);
});

test('tokens renew after an hour; a withdrawn sign-in asks to sign in again', async () => {
  const g = fakeGoogle();
  const { a, clock, stored } = auth(g);
  await a.signIn();
  clock.t += 3600 * 1000;
  assert.equal(await a.token(), 'access-2');
  assert.equal(g.calls.at(-1).body.refresh_token, 'refresh-1');

  const revoked = fakeGoogle({ refresh: { error: 'invalid_grant' } });
  const r = auth(revoked);
  await r.a.signIn();
  r.clock.t += 3600 * 1000;
  await assert.rejects(r.a.token(), /sign in again/);
  assert.equal(r.stored(), null);
  assert.equal(r.a.signedIn, false);

  await a.signOut();
  assert.equal(stored(), null);
  assert.match(g.calls.at(-1).url, /revoke\?token=refresh-1/);
});

test('the client JSON downloaded from Google Cloud is read as is', () => {
  const { readClientFile } = require('../electron/google-auth');
  const file = { installed: { client_id: '123-abc.apps.googleusercontent.com', project_id: 'av-courier', auth_uri: 'https://accounts.google.com/o/oauth2/auth', client_secret: 'GOCSPX-xyz', redirect_uris: ['http://localhost'] } };
  assert.deepEqual(readClientFile(JSON.stringify(file)), { id: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-xyz' });
  assert.throws(() => readClientFile(JSON.stringify({ web: { client_id: 'x' } })), /Desktop app/);
  assert.throws(() => readClientFile('{"type":"service_account"}'), /No OAuth client/);
  assert.throws(() => readClientFile('not json'), /not the JSON file/);
});

test('IMAP and the Gmail sync log in with the token instead of a password', async () => {
  assert.deepEqual(imapAuth({ user: 'u@x.org', accessToken: 'tok' }), { user: 'u@x.org', accessToken: 'tok' });
  assert.deepEqual(imapAuth({ user: 'u@x.org', pass: 'abcd efgh' }), { user: 'u@x.org', pass: 'abcdefgh' });

  let seen;
  const b = new GmailBackend({
    config: () => ({ user: 'you@example.org' }),
    auth: async () => ({ accessToken: 'access-1' }),
    isReady: () => true,
    connect: (cfg) => { seen = cfg; throw Object.assign(new Error('Command failed'), { responseText: 'stop here' }); },
  });
  await assert.rejects(b.append('x.jsonl', 'y'), /stop here/);
  assert.deepEqual(seen, { user: 'you@example.org', accessToken: 'access-1' });
});
