// Messages to requesters, sent back on the channel the request came from.
const { fmtBytes } = require('./copyqueue');

const TEMPLATES = {
  copyDone: 'Hi {name}, the data you asked for is ready.\n{job}: {files} files, {size}, copied to {dest} and verified.',
  copyFailed: 'Hi {name}, the copy of {job} stopped: {done} of {files} files copied, {failed} failed. I am looking into it.',
  located: 'Hi {name}, here is where it is:\n{rows}',
  notFound: 'Hi {name}, I could not find "{query}" in the archive. Can you send the date, place or drive/tape number?',
  // A request with a checklist: one message once every item is through.
  requestDone: 'Hi {name}, all the data you asked for is ready in {dest}, copied and verified:\n{done}',
  requestPartial: 'Hi {name}, part of the data you asked for is ready in {dest}, copied and verified:\n{done}\n\nNot done:\n{issues}',
};

// The requester's own words, so a reply is clearly about their message: WhatsApp's quote
// format ("> …", shown with a bar beside it) when a real quoted reply is not possible.
const quoteLine = (s) => (String(s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '').slice(0, 200);
const withQuote = (text, quote) => { const q = quoteLine(quote); return q ? `> ${q}\n\n${text}` : String(text); };

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
const firstName = (n) => String(n || '').replace(/\s*\(.*\)$/, '').split(/\s+/)[0] || 'there';

function jobVars(job, recipient) {
  return {
    name: firstName(recipient.name), job: job.name, files: job.count, done: job.done, failed: job.failed,
    size: fmtBytes(job.bytesTotal), dest: job.dest,
  };
}

// "• Live Garba (Navratri,Garba), Adalaj, 17 Oct 2026 · Folder 3050 · DD-F-HD-3050-E
//    Vatsalya Backup: DD MASTER SSD - 123 · Amba Video Backup: DD MASTER - 112"
function rowLine(r) {
  const what = [r.title, r.event && r.event !== r.title ? `(${r.event})` : ''].filter(Boolean).join(' ') || r.cells.filter(Boolean).slice(0, 2).join(' ');
  const head = [r.kind === 'episode' ? `Episode ${r.series} ${r.episodeNo}: ${what}` : what, r.place, r.date].filter(Boolean).join(', ');
  // "Episode DD Vitraag 2350: General, Los Angeles, 3 Jun 2011 · from DD-F-DV-1260-E1"
  const ref = r.kind === 'episode' ? (r.rawId ? `from ${r.rawId}` : '') : [r.folder && `Folder ${r.folder}`, r.id].filter(Boolean).join(' · ');
  const where = (r.locations || []).map((l) => `${l.label.replace(/\s*backup$/i, '')}: ${l.value}`).join(' · ')
    || (r.locations ? 'not on any backup yet' : [r.drive && `Drive ${r.drive}`, r.tape && `Tape ${r.tape}`, r.path].filter(Boolean).join(' · '));
  return `• ${head}${ref ? ` · ${ref}` : ''}${where ? `\n   ${where}` : ''}`;
}

class Notifier {
  // phone: the paired Android phone ({ available(), sendViaPhone(to, text, subject) }), optional.
  constructor({ getTemplates, sendEmail, whatsapp, phone, log }) {
    this.getTemplates = getTemplates;
    this.sendEmail = sendEmail;
    this.whatsapp = whatsapp;
    this.phone = phone;
    this.log = log;
  }

  template(key) { return (this.getTemplates() || {})[key] || TEMPLATES[key]; }

  async _viaPhone(recipient, text, subject, why) {
    const r = await this.phone.sendViaPhone(recipient, text, subject);
    const route = r?.route || 'phone';
    this.log?.(`Sent to ${recipient.name} on ${recipient.channel} through the phone (${route})${why ? ` — ${why}` : ''}`);
    return route;
  }

  // recipient: { channel: 'whatsapp'|'email'|'phone', name, chat?, address?, reply?, quote? }
  // quote: the message being answered (WhatsApp); email answers in its own thread instead.
  // Returns the route used: 'whatsapp-web', 'email', or a phone route.
  // WhatsApp goes through WhatsApp Web on this PC; when that is not linked or
  // fails, the paired phone sends it instead.
  async send(recipient, text, subject = 'Your data request') {
    const phoneUp = () => !!this.phone?.available();
    if (recipient.channel === 'phone') {
      if (!phoneUp()) throw new Error('No phone connected');
      return this._viaPhone({ ...recipient, channel: recipient.via || 'whatsapp' }, text, subject);
    }
    if (recipient.channel === 'whatsapp') {
      const linked = this.whatsapp?.status === 'ready' || this.whatsapp?.status === 'loading';
      if (!linked && phoneUp()) return this._viaPhone(recipient, text, subject, `WhatsApp Web on the PC is ${this.whatsapp?.status || 'off'}`);
      try {
        const r = await this.whatsapp.send(recipient.chat || recipient.name, text, { quote: recipient.quote });
        if (r?.quoted === 'reply') { this.log?.(`Sent to ${recipient.name} on whatsapp as a reply to their message (WhatsApp Web on the PC)`); return 'whatsapp-web'; }
      } catch (e) {
        if (!phoneUp()) throw e;
        return this._viaPhone(recipient, text, subject, `WhatsApp Web failed: ${e.message}`);
      }
      this.log?.(`Sent to ${recipient.name} on whatsapp (WhatsApp Web on the PC)`);
      return 'whatsapp-web';
    }
    if (recipient.channel === 'email') {
      // A Gmail request caught on the phone may have no address, only a name.
      if (!recipient.address && phoneUp()) return this._viaPhone(recipient, text, subject, 'no email address known');
      await this.sendEmail({ to: recipient.address, subject, text, reply: recipient.reply });
      this.log?.(`Sent to ${recipient.name} on email`);
      return 'email';
    }
    throw new Error(`No channel for ${recipient.name}`);
  }

  messageForJob(job, recipient) {
    const key = job.status === 'done' ? 'copyDone' : 'copyFailed';
    const base = fill(job.message && job.status === 'done' ? job.message : this.template(key), jobVars(job, recipient));
    return base;
  }

  async jobFinished(job) {
    const results = [];
    for (const r of job.notify || []) {
      try { const route = await this.send(r, this.messageForJob(job, r), `Ready: ${job.name}`); results.push({ to: r.name, ok: true, route }); }
      catch (e) { results.push({ to: r.name, ok: false, error: e.message }); this.log?.(`Could not notify ${r.name}: ${e.message}`); }
    }
    return results;
  }
}

module.exports = { Notifier, TEMPLATES, fill, firstName, rowLine, jobVars, withQuote, quoteLine };
