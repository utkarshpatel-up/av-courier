// "Sign in with Google" for Gmail, instead of an App Password.
// Google's own page opens in the normal browser (OAuth for desktop apps, with
// PKCE and a one-time address on this computer), so the app never sees the
// password. Google hands back a token the app may use for this mailbox over
// IMAP and SMTP; it is kept encrypted and can be withdrawn from the Google
// account at any time (Security → Third-party connections).
const http = require('http');
const crypto = require('crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const SCOPE = 'openid email https://mail.google.com/';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

class GoogleAuth {
  // client(): { id, secret } of the OAuth client (type "Desktop app").
  // tokens: { load(), save(t | null) } — kept encrypted by the app.
  // openUrl(url): opens the browser.
  constructor({ client, tokens, openUrl, fetch = globalThis.fetch, now = Date.now, signInTimeoutMs = 5 * 60000 }) {
    Object.assign(this, { client, tokens, openUrl, fetch, now, signInTimeoutMs });
    this.access = null; // { token, expiresAt }
  }

  get email() { return this.tokens.load()?.email || ''; }
  get signedIn() { return !!this.tokens.load()?.refresh_token; }

  async signIn() {
    const { id, secret } = this.client() || {};
    if (!id) throw new Error('Paste the Google OAuth client ID first');
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    // A one-time address on this computer that Google's page sends the browser back to.
    const server = http.createServer();
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const redirect = `http://127.0.0.1:${server.address().port}`;
    let timer;
    try {
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Google sign-in was not finished in the browser')), this.signInTimeoutMs);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirect);
          if (u.pathname !== '/') { res.writeHead(404).end(); return; }
          const ok = u.searchParams.get('state') === state && !!u.searchParams.get('code');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>AV Courier</title><body style="font-family:sans-serif;padding:40px">`
            + `<h2>${ok ? 'Signed in ✓' : 'Sign-in did not finish'}</h2><p>You can close this tab and go back to AV Courier.</p>`);
          if (ok) resolve(u.searchParams.get('code'));
          else reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : `Google sign-in failed${u.searchParams.get('error') ? `: ${u.searchParams.get('error')}` : ''}`));
        });
        const url = `${AUTH}?${new URLSearchParams({
          client_id: id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state,
          code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
        })}`;
        Promise.resolve(this.openUrl(url)).catch(reject);
      });
      const t = await this._tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: id, ...(secret ? { client_secret: secret } : {}) });
      if (!t.refresh_token) throw new Error('Google did not grant lasting access: sign in again');
      if (!String(t.scope || SCOPE).includes('https://mail.google.com/')) throw new Error('Mail access was not granted: tick the Gmail permission on Google’s page');
      let email = '';
      try { email = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch { /* no id token */ }
      this.tokens.save({ refresh_token: t.refresh_token, email });
      this.access = { token: t.access_token, expiresAt: this.now() + (t.expires_in || 3600) * 1000 };
      return email;
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }

  async signOut() {
    const t = this.tokens.load();
    this.tokens.save(null);
    this.access = null;
    if (t?.refresh_token) await this.fetch(`${REVOKE}?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }

  async _tokenCall(params) {
    const res = await this.fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`Google: ${body.error_description || body.error || res.status}`);
      e.code = body.error;
      throw e;
    }
    return body;
  }

  // A fresh access token for IMAP/SMTP (they last an hour; renewed as needed).
  async token() {
    if (this.access && this.now() < this.access.expiresAt - 60000) return this.access.token;
    const t = this.tokens.load();
    if (!t?.refresh_token) throw new Error('Not signed in to Google: Channels → Gmail → Sign in with Google');
    const { id, secret } = this.client() || {};
    try {
      const r = await this._tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: id, ...(secret ? { client_secret: secret } : {}) });
      this.access = { token: r.access_token, expiresAt: this.now() + (r.expires_in || 3600) * 1000 };
      return this.access.token;
    } catch (e) {
      if (e.code === 'invalid_grant') { this.tokens.save(null); this.access = null; throw new Error('Google sign-in has expired or was withdrawn: sign in again'); }
      throw e;
    }
  }
}

// The client file Google Cloud offers as "Download JSON": { installed: { client_id, client_secret, … } }.
function readClientFile(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('That is not the JSON file from Google Cloud'); }
  const c = j.installed || j.web;
  if (!c?.client_id) throw new Error('No OAuth client in that file: download the JSON of the Desktop app client');
  if (!j.installed) throw new Error('That client is a "Web application": create one of type "Desktop app" instead');
  return { id: c.client_id, secret: c.client_secret || '' };
}

module.exports = { GoogleAuth, SCOPE, readClientFile };
