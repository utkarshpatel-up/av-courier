// A plain-text log on this computer, one file per day in <data>/logs, kept for 14 days.
// What the app did and every error, in more detail than the Activity page, so a problem
// can be looked into afterwards. Never passwords or keys; message text is cut short.
// "Save diagnostics…" (Settings) puts the recent days into one file to send on.
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 14;
const day = (t = Date.now()) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const clip = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s; };

class LogFile {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._prune();
  }

  _prune() {
    const oldest = day(Date.now() - KEEP_DAYS * 86400000);
    for (const f of fs.readdirSync(this.dir)) if (/^\d{4}-\d{2}-\d{2}\.log$/.test(f) && f.slice(0, 10) < oldest) try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* in use */ }
  }

  // level: info | warn | error. data: anything JSON-able, shortened.
  write(level, text, data) {
    const t = new Date();
    const extra = data === undefined ? '' : ` ${clip(data instanceof Error ? data.stack || data.message : typeof data === 'string' ? data : JSON.stringify(data), 2000)}`;
    const line = `${t.toISOString()} ${level.toUpperCase().padEnd(5)} ${clip(text, 1000)}${extra}\n`;
    try {
      const f = path.join(this.dir, `${day(+t)}.log`);
      if (this._day !== day(+t)) { this._day = day(+t); this._prune(); }
      fs.appendFileSync(f, line);
    } catch { /* disk full or read-only: the app carries on */ }
  }

  info(text, data) { this.write('info', text, data); }
  warn(text, data) { this.write('warn', text, data); }
  error(text, data) { this.write('error', text, data); }

  // The last `days` days of log, oldest first.
  recent(days = 7) {
    const from = day(Date.now() - days * 86400000);
    return fs.readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f) && f.slice(0, 10) >= from).sort()
      .map((f) => `===== ${f}\n${fs.readFileSync(path.join(this.dir, f), 'utf8')}`).join('\n');
  }
}

module.exports = { LogFile, clip };
