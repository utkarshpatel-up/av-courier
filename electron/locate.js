// Finds catalogue rows on the drives that are plugged in.
//
// Two layouts exist on the drives:
//  - HD/4K years: one folder per recording day, "3034 Dt-15 Sep 2026" (sometimes
//    "(Part-02)"), inside range folders "0701 to 0720"; session folders inside it
//    ("01 Adalaj … Parayan Mor. Dt-10-09-18 …", "… Satsang E. Dt-16-Aug-26 …").
//  - DV years: numbered folders or single files inside range folders, no date:
//      Pujyashree Deepakbhai\Formal\DVCAM\DD Master (1310 to 1329)\…
//      Pujyashree Deepakbhai\Informal\DVCAM\DD Mini DV (0741 to 0792)\DD Mini DV 741.avi
//      Niruma\Formal\DVCAM\NM MASTER - 0418 to 0438\NM-0418\
//      Niruma\Informal\DVCAM\NM Mini DV (181 to 228)\NM Master Mini Dv - 196.avi
// Folder numbers repeat across series (author × Formal/Informal × DV or HD era), so
// the series is read from the path and the drive label ("DD-FOR-VAT-MD1-LTO-015",
// "NM-NA-VAT-MD1-LTO-002") and must agree with the row's Raw Video Id.
// Episodes ("…\Episode\DVCAM\Gujarati\DD Vitraag-2301-2400\…") are indexed by series + number.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_FOLDER = /^0*(\d{1,5})\s*(?:[-_.]\s*)?(?:Dt\.?[-\s]*)?(\d{1,2})[-\s.]+([A-Za-z]{3,9})[-\s.,']+(\d{2,4})\b/i;
const RANGE = /0*(\d{1,5})\s*(?:to|-|–)\s*0*(\d{1,5})\s*\)?\s*$/i;
const RAW_ITEM = /^(?:(DD|NM)\b[\s_-]*)?(?:(?:master|mini|dv|dvcam)\b[\s_-]*)*0*(\d{1,5})(?:\s*\(part[-\s]*\d+\))?(?:\.(?:avi|mov|mp4|mxf|m2t|mts|dv|mkv))?$/i;
const VIDEO = /\.(avi|mov|mp4|mxf|m2t|mts|dv|mkv|mpg|mpeg|wmv)$/i;
const SKIP = /^(\$|\.|System Volume Information$|Windows$|Program Files|ProgramData$|Users$|AppData$|node_modules$|Recovery$|PerfLogs$|MSOCache$)/i;
const pad = (n) => String(n).padStart(2, '0');
const seriesKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function parseDayFolder(name) {
  const m = DAY_FOLDER.exec(name);
  if (!m) return null;
  const mo = MONTHS[m[3].toLowerCase().slice(0, 3)];
  let y = +m[4];
  if (y < 100) y += 2000;
  if (!mo || +m[2] < 1 || +m[2] > 31) return null;
  return { number: String(+m[1]), date: `${y}-${pad(mo)}-${pad(+m[2])}` };
}

// Series clues in one path part or drive label. Deeper parts override shallower ones.
function clues(part) {
  const p = String(part);
  const c = {};
  if (/\bniruma\b|^nm\b|\bnm[\s_-]/i.test(p)) c.author = 'NM';
  else if (/pujyashree|deepakbhai|^dd\b|\bdd[\s_-]/i.test(p)) c.author = 'DD';
  if (/\binformal\b|[-_]inf[-_]/i.test(p)) c.type = 'I';
  else if (/\bformal\b|[-_]for[-_]/i.test(p)) c.type = 'F';
  else if (/\bmini\s*dv\b/i.test(p)) c.typeHint = 'I';
  else if (/\bmaster\b/i.test(p)) c.typeHint = 'F';
  if (/\bvhs\b/i.test(p)) c.era = 'VHS';
  else if (/\b(dvcam|mini\s*dv|dv)\b/i.test(p)) c.era = 'DV';
  else if (/\b(hd|4k)\b/i.test(p)) c.era = 'HD';
  if (/\bepisodes?\b|[-_]epi[-_]/i.test(p)) c.episode = true;
  return c;
}

function context(parts) {
  const ctx = {};
  for (const part of parts) {
    const c = clues(part);
    for (const k of ['author', 'type', 'era']) if (c[k]) ctx[k] = c[k];
    if (c.typeHint && !ctx.type) ctx.typeHint = c.typeHint;
    if (c.episode) ctx.episode = true;
  }
  if (!ctx.type && ctx.typeHint) ctx.type = ctx.typeHint;
  delete ctx.typeHint;
  return ctx;
}

// ---------------------------------------------------------------- drives
// LTO tapes (LTFS) must not be touched while the drive loads the tape: wait until its
// light is steady. So drive letters are listed with Windows' own drive bitmask, which
// never asks the media anything; volume details are fetched in the background with a
// time limit; tapes are only read when you press "Tape ready".
const runPS = (cmd, timeout = 15000) => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
  { timeout, windowsHide: true }, (err, out) => res(err ? null : String(out))));

async function driveLetters() {
  if (process.platform !== 'win32') return ['/Volumes', '/media', '/mnt'].filter(fs.existsSync).flatMap((d) => fs.readdirSync(d).map((n) => path.join(d, n)));
  const out = await runPS('[Environment]::GetLogicalDrives() -join "|"', 10000);
  return out ? out.trim().split('|').filter((d) => /^[A-Z]:\\$/i.test(d)).map((d) => d.toUpperCase()) : [];
}

// { 'E:\\': { label, fs, network } } for the given letters. A drive still loading may not answer.
async function volumeInfo(letters) {
  if (process.platform !== 'win32' || !letters.length) return {};
  const ids = letters.map((r) => `'${r.slice(0, 2)}'`).join(',');
  const out = await runPS(`Get-CimInstance Win32_LogicalDisk | Where-Object { @(${ids}) -contains $_.DeviceID } | ForEach-Object { $_.DeviceID + '|' + $_.VolumeName + '|' + $_.FileSystem + '|' + $_.DriveType + '|' + $_.ProviderName }`, 20000);
  const map = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    const [dev, label, fsys, type, provider] = line.split('|');
    if (!dev || !dev.trim()) continue;
    map[`${dev.trim().toUpperCase()}\\`] = { label: (label || '').trim() || (provider || '').trim().split('\\').pop() || '', fs: (fsys || '').trim(), network: +type === 4 };
  }
  return map;
}

// Network shares mounted on a Mac or Linux (smb, afp, nfs, webdav): "//nas/Share01 on /Volumes/Share01 (smbfs, …)".
async function networkMounts() {
  if (process.platform === 'win32') return new Set();
  const out = await new Promise((res) => execFile('mount', [], { timeout: 10000 }, (err, o) => res(err ? '' : String(o))));
  const set = new Set();
  for (const line of out.split('\n')) {
    const m = /^(.+?) on (.+?) \(([^,)]+)/.exec(line);
    if (m && /^(smbfs|afpfs|nfs|webdav|cifs|smb3?|fuse\.sshfs|sshfs)$/i.test(m[3].trim())) set.add(m[2]);
  }
  return set;
}
// \\server\share, or a mapped network drive letter (Windows says so), or a mounted share.
const isNetworkPath = (p) => /^\\\\/.test(p) || /^\/\//.test(p);

const isTape = (info) => !!info && (/ltfs/i.test(info.fs || '') || /(^|[^a-z])lto([^a-z]|$)/i.test(info.label || ''));

// Walk one root and collect recordings (raw) and episodes. Day folders keep their
// session sub-folder names so nothing has to be read again later.
async function walkRoot(root, label, maxDepth) {
  const items = [], episodes = [];
  const walk = async (dir, depth, parts) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const isDir = e.isDirectory();
      if (!isDir && !(e.isFile() && VIDEO.test(e.name))) continue;
      const p = path.join(dir, e.name);
      const here = [...parts, e.name];
      const ctx = context(here);

      if (ctx.episode) {
        // "DD Vitraag-2350 …", "NM-900 Pati-Patni …"; range folders are walked into.
        const base = e.name.replace(VIDEO, '');
        if (isDir && RANGE.test(base) && /[a-z]/i.test(base)) { if (depth < maxDepth) await walk(p, depth + 1, here); continue; }
        // Matched later by series-name prefix + number, so "Aptavani-14-B2 - 014" works too.
        if (/\d/.test(base)) episodes.push({ kind: 'episode', key: seriesKey(base), path: p, root, isFile: !isDir });
        if (isDir && depth < maxDepth) await walk(p, depth + 1, here);
        continue;
      }

      if (isDir) {
        const day = parseDayFolder(e.name);
        if (day) {
          const year = +day.date.slice(0, 4);
          let subs = [];
          try { subs = (await fsp.readdir(p, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => x.name); } catch { /* unreadable */ }
          items.push({ kind: 'raw', ...ctx, era: ctx.era || (year >= 2014 ? 'HD' : year <= 2012 ? 'DV' : undefined), ...day, path: p, root, isFile: false, subs });
          continue;
        }
        if (RANGE.test(e.name)) { if (depth < maxDepth) await walk(p, depth + 1, here); continue; }
      }
      const m = RAW_ITEM.exec(e.name);
      // A bare number needs series clues around it; "01 Adalaj …" style names never match.
      if (m && (ctx.author || ctx.type || ctx.era)) {
        const own = clues(e.name);
        items.push({ kind: 'raw', ...ctx, author: own.author || ctx.author, number: String(+m[2]), path: p, root, isFile: !isDir });
        continue;
      }
      if (isDir && depth < maxDepth) await walk(p, depth + 1, here);
    }
  };
  await walk(root, 1, [label || '']);
  return { items, episodes };
}

class DriveIndex {
  // store: { load() -> saved tapes, save(tapes) } keeps what each tape holds between runs.
  constructor({ getConfig = () => ({}), log, store } = {}) {
    this.getConfig = getConfig;
    this.log = log;
    this.store = store;
    this.drives = new Map(); // root -> { root, label, fs, tape, ready, status, items, episodes, scannedAt }
    this.tapes = (store && store.load()) || {}; // label -> { scannedAt, items, episodes, root }
    this.scannedAt = 0;
    this._busy = Promise.resolve();
  }

  // Everything findable: mounted drives that were scanned, plus tapes remembered from earlier.
  get items() { return this._all('items'); }
  get episodes() { return this._all('episodes'); }
  get folders() { return this.items; } // older callers
  get roots() { return [...this.drives.keys()]; }
  get labels() { return Object.fromEntries([...this.drives.values()].map((d) => [d.root.toUpperCase(), d.label])); }

  _all(kind) {
    const mounted = new Set();
    const out = [];
    for (const d of this.drives.values()) {
      if (d.tape) mounted.add(d.label);
      if (d.items) out.push(...d[kind]);
    }
    for (const [label, t] of Object.entries(this.tapes)) {
      const d = [...this.drives.values()].find((x) => x.tape && x.label === label);
      if (d?.items) continue; // freshly scanned copy above
      // The same tape may come back under another drive letter.
      const move = (p) => (d && t.root && d.root !== t.root && p.startsWith(t.root) ? d.root + p.slice(t.root.length) : p);
      for (const it of t[kind] || []) out.push({ ...it, path: move(it.path), root: d ? d.root : it.root, tape: label, offline: !mounted.has(label) });
    }
    return out;
  }

  status() {
    return {
      scannedAt: this.scannedAt,
      drives: [...this.drives.values()].map((d) => ({ root: d.root, label: d.label, tape: d.tape, network: !!d.network, status: d.status, recordings: d.items?.length || 0, episodes: d.episodes?.length || 0, scannedAt: d.scannedAt })),
      tapes: Object.entries(this.tapes).map(([label, t]) => ({ label, scannedAt: t.scannedAt, recordings: t.items.length, episodes: t.episodes.length })),
      recordings: this.items.length,
      episodes: this.episodes.length,
    };
  }

  // One thing at a time: scans never run side by side (and never two on one tape).
  _queue(fn) { const run = this._busy.then(fn, fn); this._busy = run.catch(() => {}); return run; }

  async _list() {
    const cfg = this.getConfig();
    const sys = (process.env.SystemDrive || 'C:').toUpperCase() + '\\';
    const letters = cfg.scanDrives === false ? [] : (await driveLetters()).filter((r) => cfg.includeSystemDrive || r !== sys);
    const extra = (cfg.extraRoots || []).map((r) => path.resolve(r));
    return { letters, extra, all: [...new Set([...letters, ...extra])] };
  }

  // New drive letters: ask Windows what they are (in the background); disks get scanned,
  // tapes wait for you. Gone drives are dropped; their tape contents stay remembered.
  async _refreshList({ scanDisks = true, force = false } = {}) {
    const cfg = this.getConfig();
    const { letters, extra, all } = await this._list();
    for (const root of [...this.drives.keys()]) if (!all.includes(root)) this.drives.delete(root);
    const fresh = letters.filter((r) => force || !this.drives.has(r));
    const info = await volumeInfo(fresh);
    const net = await networkMounts();
    // Windows is asked about each letter; on a Mac whatever is under /Volumes is mounted and ready.
    const win = process.platform === 'win32';
    for (const root of fresh) {
      const v = info[root];
      const tape = isTape(v) || (cfg.tapeRoots || []).includes(root);
      const prev = this.drives.get(root);
      this.drives.set(root, { ...(prev || {}), root, label: v?.label || prev?.label || (win ? '' : path.basename(root)), fs: v?.fs || '', tape,
        network: !!v?.network || net.has(root),
        status: prev?.items && !force ? prev.status : tape ? 'tape-waiting' : v || !win ? 'disk' : 'not-ready' });
    }
    for (const root of extra) {
      if (this.drives.has(root) && !force) continue;
      const tape = (cfg.tapeRoots || []).map((r) => path.resolve(r)).includes(root);
      this.drives.set(root, { ...(this.drives.get(root) || {}), root, label: (cfg.tapeLabels || {})[root] || '', tape, network: isNetworkPath(root) || net.has(root), status: tape ? 'tape-waiting' : 'disk' });
    }
    if (scanDisks) {
      for (const d of this.drives.values()) {
        // NAS shares are big and slow: only searched when you choose one (searchNames).
        if (d.tape || d.network || d.status === 'not-ready' || (d.items && !force)) continue;
        await this._scanOne(d);
      }
    }
  }

  async _scanOne(d) {
    const cfg = this.getConfig();
    d.status = 'scanning';
    const { items, episodes } = await walkRoot(d.root, d.label, cfg.depth || 7);
    Object.assign(d, { items, episodes, scannedAt: Date.now(), status: d.tape ? 'tape-scanned' : 'disk' });
    this.scannedAt = Date.now();
    if (d.tape && d.label) {
      this.tapes[d.label] = { scannedAt: d.scannedAt, root: d.root, items: items.map(strip), episodes: episodes.map(strip) };
      this.store?.save(this.tapes);
    }
    this.log?.(`${d.tape ? 'Tape' : 'Drive'} ${d.root}${d.label ? ` (${d.label})` : ''} scanned: ${items.length} recordings, ${episodes.length} episodes`);
  }

  // Startup and the Rescan button: disks only. Tapes are never read from here.
  scan() { return this._queue(async () => { await this._refreshList({ force: true }); return this.items.length; }); }

  // "Tape ready": only after the drive light is steady.
  scanTape(root) {
    return this._queue(async () => {
      const d = this.drives.get(root) || this.drives.get(path.resolve(root));
      if (!d) throw new Error(`${root} is not connected`);
      if (/^[A-Z]:\\$/i.test(d.root)) {
        const v = (await volumeInfo([d.root]))[d.root];
        if (!v) { d.status = 'not-ready'; throw new Error(`${d.root} is not answering yet. Wait until the drive light is steady, then press Tape ready again.`); }
        d.label = v.label || d.label;
      }
      await this._scanOne(d);
      return d.items.length;
    });
  }

  forgetTape(label) { delete this.tapes[label]; this.store?.save(this.tapes); }

  // Notices drives being plugged in or removed. Lists letters only; never reads a tape.
  watch(onChange, everyMs = 15000) {
    this.timer = setInterval(() => this._queue(async () => {
      const before = this.roots.join('|');
      await this._refreshList();
      if (this.roots.join('|') !== before) onChange?.();
    }), everyMs);
  }

  // row: a catalogue result ({ kind, folder, iso, session, ser, series, episodeNo }).
  // exact = the series agrees on everything known and the date (if both have one) matches.
  // offline = remembered from a tape that is not in the drive now.
  find(row) {
    if (!row) return [];
    const where = (x) => ({ path: x.path, root: x.root, isFile: x.isFile, tape: x.tape || this._tapeOf(x.root), offline: !!x.offline });
    if (row.kind === 'episode') {
      const n = String(+row.episodeNo);
      const keys = [...new Set([seriesKey(row.series), seriesKey(row.series).replace(/^dd/, '')])].filter(Boolean);
      const hit = (e) => keys.some((k) => {
        if (!e.key.startsWith(k)) return false;
        const rest = e.key.slice(k.length).replace(/^0+/, '');
        return rest.startsWith(n) && !/\d/.test(rest[n.length] || '');
      });
      // A folder and the files in it can both match: keep the outermost.
      const found = this.episodes.filter(hit);
      return found.filter((e) => !found.some((o) => o !== e && e.path.startsWith(o.path + path.sep)))
        .map((e) => ({ ...where(e), exact: true })).sort((a, b) => a.offline - b.offline);
    }
    const ser = row.ser || {};
    const n = String(+(row.folder || ser.number) || '');
    if (!n) return [];
    const out = [];
    for (const it of this.items) {
      if (it.number !== n) continue;
      let agree = 0, clash = false;
      if (it.author && ser.authors) { if (ser.authors.includes(it.author)) agree++; else clash = true; }
      if (it.type && ser.type) { if (it.type === ser.type) agree++; else clash = true; }
      if (it.era && ser.era) { if (it.era === ser.era) agree++; else clash = true; }
      if (clash) continue;
      const dateOk = it.date && row.iso ? it.date === row.iso : null;
      if (dateOk === false && agree < 3) continue; // a different day of an unknown series
      const exact = dateOk === true || (dateOk === null && agree === 3);
      out.push({ ...where(it), exact, agree, date: it.date, session: it.isFile ? null : sessionFolder(it.path, row.session || ser.session, it.subs) });
    }
    return out.sort((a, b) => a.offline - b.offline || b.exact - a.exact || b.agree - a.agree);
  }

  _tapeOf(root) { const d = this.drives.get(root); return d?.tape ? d.label || root : ''; }

  // Where to search by name. where: 'disks' (hard drives plugged in, the default: no NAS),
  // 'all' (NAS shares too), or one drive's root. Never tapes, never this computer's own system disk.
  diskRoots(where = 'disks') {
    return [...this.drives.values()]
      .filter((d) => !d.tape && d.status !== 'not-ready' && (where === 'all' ? true : where === 'disks' ? !d.network : d.root === where))
      .map((d) => d.root).filter((r) => {
        try { const real = fs.realpathSync(r); return /^[A-Z]:\\$/i.test(r) || real !== path.parse(real).root; } catch { return false; }
      });
  }

  // Name search, one at a time like the scans. opts.where: see diskRoots.
  searchNames(wants, opts = {}) { return this._queue(() => searchNames(this.diskRoots(opts.where), wants, opts)); }

  // Drives plugged in since the last look are listed (and hard drives scanned); nothing else is read again.
  refresh() { return this._queue(() => this._refreshList()); }
}

const strip = ({ offline, tape, ...x }) => x;

// ---------------------------------------------------------------- search by name
// For a checklist item the index cannot place (a file on a NAS, an edit export, a copy
// on another disk): every file or folder whose name carries its folder number and date,
// or its episode series and number, on every connected disk. The same recording can be
// on several drives, so all of them are listed.
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
function datesIn(name) {
  const out = new Set();
  const y4 = (y) => (+y < 100 ? 2000 + +y : +y);
  const add = (y, m, d) => { if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.add(`${y4(y)}-${pad(m)}-${pad(d)}`); };
  for (const m of name.matchAll(new RegExp(`(\\d{1,2})[-\\s.]+${MONTH_RE}[-\\s.,']+(\\d{2,4})(?!\\d)`, 'gi'))) add(m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  for (const m of name.matchAll(/(?<!\d)(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})(?!\d)/g)) add(m[1], +m[2], +m[3]);
  for (const m of name.matchAll(/(?<!\d)(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})(?!\d)/g)) add(m[3], +m[2], +m[1]);
  return out;
}

// row -> (name) => null | { exact }. Null when the row has nothing to look for by name.
function nameMatcher(row) {
  if (!row) return null;
  if (row.kind === 'episode') {
    const key = seriesKey(row.series).replace(/^dd/, '');
    const n = String(+row.episodeNo || '');
    if (!key || !n) return null;
    const num = new RegExp(`(^|\\D)0*${n}(\\D|$)`);
    return (name) => (seriesKey(name).includes(key) && num.test(name) ? { exact: true } : null);
  }
  const n = String(+(row.folder || row.ser?.number) || '');
  if (!n || n === '0') return null;
  const lead = new RegExp(`^0*${n}(?!\\d)`);
  return (name) => {
    if (!lead.test(name.trim())) return null;
    const ds = datesIn(name);
    if (row.iso && ds.size) return ds.has(row.iso) ? { exact: true } : null;
    return { exact: false }; // number only: check before copying
  };
}

// wants: [{ key, test(name) }]. Resolves { key: [{ path, root, isFile, size, exact }] }.
// Tapes are never read here; stops after `timeMs` and says so.
async function searchNames(roots, wants, { depth = 9, timeMs = 120000, maxHits = 25 } = {}) {
  const hits = Object.fromEntries(wants.map((w) => [w.key, []]));
  const end = Date.now() + timeMs;
  let timedOut = false;
  const walk = async (dir, d, root) => {
    if (Date.now() > end) { timedOut = true; return; }
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const isDir = e.isDirectory();
      if (!isDir && !(e.isFile() && VIDEO.test(e.name))) continue;
      const p = path.join(dir, e.name);
      let matched = false;
      for (const w of wants) {
        const m = hits[w.key].length < maxHits && w.test(e.name.replace(VIDEO, ''));
        if (!m) continue;
        matched = true;
        let size = 0;
        if (!isDir) try { size = (await fsp.stat(p)).size; } catch { /* gone */ }
        hits[w.key].push({ path: p, root, isFile: !isDir, size, exact: m.exact });
      }
      // A matching folder is the recording: its insides are not searched again.
      if (isDir && !matched && d < depth) await walk(p, d + 1, root);
    }
  };
  for (const root of roots) await walk(root, 1, root);
  for (const k of Object.keys(hits)) hits[k].sort((a, b) => b.exact - a.exact);
  return { hits, timedOut };
}

// Inside a day folder each session has its own folder ("… Satsang E. Dt-16-Aug-26 …",
// "02 Adalaj … Parayan Eve. Dt-10-09-18 …"). Picked only when exactly one fits.
// Uses the names saved by the scan, so a tape is not read again.
function sessionFolder(dayPath, session, subs) {
  const s = String(session || '').toUpperCase();
  if (!s) return null;
  if (!subs) {
    try { subs = fs.readdirSync(dayPath, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  }
  const letter = s[0];
  const words = letter === 'E' ? 'E|Eve|Evening' : letter === 'M' ? 'M|Mor|Morning' : s.replace(/[^A-Z0-9]/g, '');
  const re = new RegExp(`(^|[\\s_-])(${words})\\.?(\\s|$)`, 'i');
  let hits = subs.filter((x) => re.test(x));
  // "E2" = the second evening session: the second matching folder in name order.
  const nth = +s.slice(1);
  if (hits.length > 1 && nth >= 1 && /^[EM]\d+$/.test(s)) hits = [...hits].sort().slice(nth - 1, nth);
  return hits.length === 1 ? path.join(dayPath, hits[0]) : null;
}

module.exports = { DriveIndex, nameMatcher, datesIn, searchNames, networkMounts, parseDayFolder, sessionFolder, context, clues, isTape };
