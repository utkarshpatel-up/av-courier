// Gmail with an App Password: IMAP to watch for requests, SMTP to answer them
// in the same thread they arrived in.
const nodemailer = require('nodemailer');
const { isSheet } = require('./sheet');

const validAddress = (v) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(String(v || ''));

// Signs in with an App Password, or with a token from "Sign in with Google" (google-auth.js).
const imapAuth = ({ user, pass, accessToken }) => (accessToken ? { user, accessToken } : { user, pass: String(pass).replace(/\s/g, '') });

function smtp(user, pass, accessToken) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: accessToken ? { type: 'OAuth2', user, accessToken } : { user, pass: pass.replace(/\s/g, '') },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

// reply: { messageId, references, subject } of the request email, when there is one.
async function sendEmail({ user, pass, accessToken, to, subject, text, reply }) {
  if (!validAddress(user)) throw new Error('Enter your Gmail address on the Channels page');
  if (!pass && !accessToken) throw new Error('Save a Google App Password, or sign in with Google, on the Channels page');
  if (!validAddress(to)) throw new Error(`Not an email address: ${to}`);
  const t = smtp(user, pass, accessToken);
  try {
    const mail = { from: user, to, subject, text };
    if (reply?.messageId) {
      mail.subject = /^re:/i.test(reply.subject || '') ? reply.subject : `Re: ${reply.subject || subject}`;
      mail.inReplyTo = reply.messageId;
      mail.references = [...(reply.references || []), reply.messageId];
    }
    const r = await t.sendMail(mail);
    if (!r.accepted?.length) throw new Error('Gmail did not accept the recipient');
    return r;
  } finally { t.close(); }
}

// IMAP errors say only "Command failed"; Gmail's own reply is in the details.
function imapError(e) {
  if (['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(e.code)) {
    return new Error(`Could not reach Gmail: no internet, or the network did not answer (${e.code}). It tries again at the next check.`);
  }
  const said = [e.responseText, e.serverResponseCode && `[${e.serverResponseCode}]`].filter(Boolean).join(' ').trim();
  const all = `${said} ${e.message}`;
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted/i.test(all)) {
    return new Error(`Gmail refused the login${said ? ` (${said})` : ''}. Check the address, and make a new App Password for that same account. On a work (Google Workspace) account the administrator must allow App Passwords.`);
  }
  if (/IMAP.*(disabled|not enabled)|enable IMAP|WEBALERT|Web login required/i.test(all)) {
    return new Error(`Gmail: ${said || e.message}. On a work (Google Workspace) account the administrator must allow IMAP for your account.`);
  }
  if (/NONEXISTENT|Unknown Mailbox|doesn.t exist/i.test(all)) return new Error(`Gmail has no folder or label by that name${said ? ` (${said})` : ''}. Use INBOX.`);
  return new Error(said ? `Gmail: ${said}` : e.message);
}

class GmailWatcher {
  // getAuth(): optional, async — { pass } or { accessToken } for this check.
  constructor({ getConfig, getAuth, onMessage, log }) {
    this.getConfig = getConfig;
    this.getAuth = getAuth;
    this.onMessage = onMessage;
    this.log = log;
    this.timer = null;
    this.status = 'off';
    this.lastError = '';
  }

  start() {
    this.stop();
    const { intervalMin = 3 } = this.getConfig();
    this.status = 'watching';
    const tick = () => this.check().catch((e) => { this.status = 'error'; this.lastError = e.message; this.log?.(`Gmail: ${e.message}`); });
    tick();
    this.timer = setInterval(tick, Math.max(1, intervalMin) * 60000);
  }

  stop() { clearInterval(this.timer); this.timer = null; this.status = 'off'; }

  async check() {
    const cfg = { ...this.getConfig(), ...(this.getAuth ? await this.getAuth() : {}) };
    if (!cfg.user || !(cfg.pass || cfg.accessToken)) throw new Error('Gmail address, App Password or Google sign-in missing');
    const { ImapFlow } = require('imapflow');
    const { simpleParser } = require('mailparser');
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: imapAuth(cfg), logger: false });
    let lock;
    try {
      await client.connect();
      lock = await client.getMailboxLock(cfg.folder || 'INBOX');
    } catch (e) {
      await client.logout().catch(() => {});
      throw imapError(e);
    }
    let found = 0;
    try {
      const since = new Date(Date.now() - (cfg.lookbackDays || 3) * 86400000);
      const uids = await client.search({ since }, { uid: true });
      const fresh = uids.filter((u) => u > (cfg.lastUid || 0));
      for await (const msg of client.fetch(fresh, { uid: true, source: true }, { uid: true })) {
        const mail = await simpleParser(msg.source);
        const from = mail.from?.value?.[0] || {};
        if (!from.address || from.address.toLowerCase() === cfg.user.toLowerCase()) continue;
        if (mail.headers.has('list-unsubscribe') || mail.headers.has('list-id')) continue; // newsletters
        const domains = (cfg.domains || '').split(/[,\s]+/).filter(Boolean).map((d) => d.toLowerCase().replace(/^@/, ''));
        if (domains.length && !domains.some((d) => from.address.toLowerCase().endsWith('@' + d) || from.address.toLowerCase().endsWith('.' + d))) continue;
        const images = mail.attachments
          .filter((a) => /^image\/(png|jpeg|gif|webp)$/.test(a.contentType) && a.size < 4.5 * 1024 * 1024)
          .slice(0, 5)
          .map((a) => `data:${a.contentType};base64,${a.content.toString('base64')}`);
        // A list of recordings sent as a spreadsheet: read row by row (sheet.js).
        const files = mail.attachments
          .filter((a) => isSheet(a.filename, a.contentType) && a.size < 10 * 1024 * 1024)
          .slice(0, 5)
          .map((a) => ({ name: a.filename || 'request.xlsx', data: a.content.toString('base64') }));
        // Keep only the new text, not the quoted thread under it.
        const body = (mail.text || '').split(/\n(?:On .+wrote:|-{2,}\s*Original Message|From: .+)\n/)[0].trim();
        await this.onMessage({
          channel: 'email',
          externalId: mail.messageId || `uid-${msg.uid}`,
          from: { name: from.name || from.address, address: from.address },
          subject: mail.subject || '',
          text: [mail.subject, body].filter(Boolean).join('\n\n'),
          images,
          files,
          receivedAt: (mail.date || new Date()).getTime(),
          reply: { messageId: mail.messageId, references: [].concat(mail.references || []), subject: mail.subject || '' },
        });
        found++;
      }
      if (uids.length) cfg.saveLastUid?.(Math.max(cfg.lastUid || 0, ...uids));
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
    this.status = 'watching';
    this.lastError = '';
    this.lastCheck = Date.now();
    return found;
  }
}

module.exports = { sendEmail, GmailWatcher, validAddress, imapError, imapAuth };
