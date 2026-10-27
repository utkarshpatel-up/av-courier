// The archive catalogue: Excel (or CSV) exports of the database, re-imported
// every few months. Columns are recognised from their headers, so a changed
// export layout still loads; every column except record-keeping ones is searched.
//
// Built around the Raw Video Data export: Raw Video Id, Folder No., Day/Month/Year,
// Event Type, Topic/Description, City, and one column per backup set (Vatsalya,
// Amba Video, HDD, Disaster Recovery) that names the drive, SSD, LTO or NAS.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_WORDS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/;

// First matching header wins each single role.
const ROLE_PATTERNS = {
  id: /\b(raw ?video ?id|video ?id|id|code|ref(erence)? ?(no)?)\b/i,
  folder: /\bfolder ?(no|number|#)\.?/i,
  title: /\b(topic|description|title|subject|program(me)?)\b/i,
  event: /\bevent\b/i,
  date: /\b(date|recorded on|dt)\b/i,
  day: /^\s*day\s*$/i,
  month: /^\s*month\s*$/i,
  year: /^\s*year\s*$/i,
  place: /\b(city|place|venue|location)\b/i,
  session: /^\s*session\s*$/i,
  path: /\b(path|directory)\b|^\s*folder\s*$/i,
  // Episode export: "DD Vitraag" episode 2350, made from raw recording "DD-F-HD-0582-E1".
  rawId: /^\s*raw ?(video ?)?id\s*$/i,
  series: /^\s*series\s*$/i,
  episodeNo: /\bepisode ?(no|number|#)\.?/i,
};
// Every column naming where a copy lives ("Episode Drive Language" describes, it does not locate).
const LOCATION = /\b(backup|drive|hdd|ssd|tape|lto|nas|disk|storage|archive|media)\b/i;
const NOT_LOCATION = /\b(language|event|album|type|format|count)\b/i;

// Raw Video Id = Author-Type-Format-Folder-Session: "DD-F-DV-0302-E2", "NM-I-DV-0249-6", "NM, DD-F-DV-0010-E".
// Folder numbers run in separate series: per author in the DV years, and restarted for
// HD (4K shares HD's numbers) in 2013. Author + F/I + era + folder names one recording day.
function parseRawId(id) {
  const m = /^\s*([A-Z]{2,4}(?:\s*,\s*[A-Z]{2,4})*)-([FI])-(DV|HD|4K)-0*(\d{1,5})(?:-(\w+))?\s*$/i.exec(String(id || ''));
  if (!m) return null;
  const authors = m[1].toUpperCase().split(/\s*,\s*/);
  const format = m[3].toUpperCase();
  return { authors, author: authors[0], type: m[2].toUpperCase(), format, era: format === 'DV' ? 'DV' : 'HD', number: String(+m[4]), session: m[5] || '' };
}
const seriesLabel = (s) => s && `${s.authors.join('/')} ${s.type === 'F' ? 'Formal' : 'Informal'} ${s.era === 'DV' ? 'DV' : 'HD/4K'}`;
// Record keeping, not content: no dates, ids or words taken from these.
const META = /\b(created|creation|modified|updated|entered|assigned)\b/i;

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 1 || /\d/.test(t));
const compact = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Media names: "DD MASTER SSD - 123", "HDD-0123", "LTO 002", "drive no 7".
// Each also gets a family form ("ssd123", "hdd123", "drive123" all add "d:123")
// so "drive 123" finds "HDD-0123". Month names are never a prefix ("oct 2026").
const FAMILY = { hdd: 'd', hd: 'd', drive: 'd', disk: 'd', disc: 'd', ssd: 'd', d: 'd', master: 'd', tape: 't', t: 't', tp: 't', lto: 't', bt: 't', nas: 'n', card: 'c', sd: 'c' };
function ids(text) {
  const out = new Set();
  const re = /\b([a-z]{1,8})[\s\-_#./:]*(?:no\.?\s*|number\s*)?0*(\d{1,6})\b/gi;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    const p = m[1].toLowerCase();
    if (MONTH_WORDS.test(p)) continue;
    out.add(p + m[2]);
    if (FAMILY[p]) out.add(`${FAMILY[p]}:${m[2]}`);
  }
  return [...out];
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(y, mo, d) {
  if (y < 100) y += 2000;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1950 && y < 2100)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
const monthOf = (w) => MONTHS[String(w).toLowerCase().slice(0, 4)] || MONTHS[String(w).toLowerCase().slice(0, 3)];

// Dates the way people write them: 16-08-26, 16/8/2026, 16 Aug 26, Dt-16-Aug-26, Aug 16 2026, 2026-08-16.
// Partial dates come back as "2026-08" (Aug 2026) and, with years: true, "2019".
function dates(text, opts = {}) {
  const s = String(text ?? '');
  const out = new Set();
  let m;
  const ymd = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = ymd.exec(s))) { const d = isoDate(+m[1], +m[2], +m[3]); d && out.add(d); }
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g;
  while ((m = dmy.exec(s))) { const d = isoDate(+m[3], +m[2], +m[1]); d && out.add(d); }
  const dMonY = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([a-z]{3,9})[\s\-/.,]*(\d{2,4})\b/gi;
  while ((m = dMonY.exec(s))) { const mo = monthOf(m[2]); const d = mo && isoDate(+m[3], mo, +m[1]); d && out.add(d); }
  const monDY = /\b([a-z]{3,9})[\s\-/.]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-/.]+(\d{4})\b/gi;
  while ((m = monDY.exec(s))) { const mo = monthOf(m[1]); const d = mo && isoDate(+m[3], mo, +m[2]); d && out.add(d); }
  const covered = [...out].map((d) => d.slice(0, 7));
  const monY = /\b([a-z]{3,9})[\s\-/.,']*(\d{4})\b/gi;
  while ((m = monY.exec(s))) { const mo = monthOf(m[1]); if (mo && +m[2] > 1950 && +m[2] < 2100) { const ym = `${m[2]}-${pad(mo)}`; if (!covered.includes(ym)) out.add(ym); } }
  // "16 Aug" with no year: the most recent 16 Aug.
  if (opts.noYear !== false) {
    const dMon = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?![\s\-/.,']*\d)/gi;
    const now = new Date();
    while ((m = dMon.exec(s))) {
      const mo = MONTHS[m[2].toLowerCase()];
      let y = now.getFullYear();
      if (new Date(y, mo - 1, +m[1]) > now) y--;
      const d = isoDate(y, mo, +m[1]); d && out.add(d);
    }
  }
  if (opts.years) for (const y of s.match(/\b(19[5-9]\d|20\d\d)\b/g) || []) if (![...out].some((d) => d.startsWith(y))) out.add(y);
  return [...out];
}

function cellText(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return v == null ? '' : String(v).trim();
}

// Header row = first of the top 15 rows with at least two text cells and no number-only majority.
function findHeader(rows) {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const cells = rows[i].map(cellText);
    const text = cells.filter((c) => c && !/^[\d\s.\-/:]+$/.test(c));
    if (text.length >= 2 && text.length >= cells.filter(Boolean).length * 0.6) return i;
  }
  return 0;
}

function detectRoles(headers) {
  const roles = { locations: [], meta: [] };
  headers.forEach((h, i) => {
    if (META.test(h)) roles.meta.push(i);
    else if (LOCATION.test(h) && !NOT_LOCATION.test(h)) roles.locations.push(i);
  });
  const taken = new Set([...roles.meta, ...roles.locations]);
  for (const [role, re] of Object.entries(ROLE_PATTERNS)) {
    const idx = headers.findIndex((h, i) => re.test(h) && !taken.has(i));
    if (idx >= 0) { roles[role] = idx; taken.add(idx); }
  }
  return roles;
}

function readWorkbook(file) {
  const wb = XLSX.read(fs.readFileSync(file), { cellDates: true, dense: true });
  const sheets = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    if (!rows.length) continue;
    const h = findHeader(rows);
    const headers = rows[h].map((c, i) => cellText(c) || `Column ${i + 1}`);
    const roles = detectRoles(headers);
    const data = [];
    for (let r = h + 1; r < rows.length; r++) {
      const cells = headers.map((_, i) => cellText(rows[r][i]));
      if (cells.every((c) => !c)) continue;
      data.push({ cells, row: r + 1 });
    }
    sheets.push({ sheetName, headers, roles, kind: sheetKind(roles), rows: data });
  }
  return sheets;
}

const sheetKind = (roles) => (roles.episodeNo != null || (roles.series != null && roles.rawId != null) ? 'episode' : 'raw');

// What a request says about the series: "NM", "niruma", "informal", "mini dv", "HD", "episode"...
function seriesHints(text) {
  const t = String(text || '');
  const h = {};
  if (/\b(nm|niruma)\b/i.test(t)) h.author = 'NM';
  else if (/\b(dd|deepakbhai|pujyashree)\b/i.test(t)) h.author = 'DD';
  if (/\binformal\b|\bmini ?dv\b/i.test(t)) h.type = 'I';
  else if (/\bformal\b|\bmaster\b/i.test(t)) h.type = 'F';
  if (/\b(dv|dvcam|mini ?dv)\b/i.test(t)) h.era = 'DV';
  else if (/\b(hd|4k)\b/i.test(t)) h.era = 'HD';
  if (/\bepisodes?\b|\bep\.?\s*\d/i.test(t)) h.kind = 'episode';
  else if (/\braw\b/i.test(t)) h.kind = 'raw';
  return h;
}
const SERIES_OPTIONAL = new Set(['dd', 'satsang']);
const seriesAsked = (tok, said) => {
  const need = [...tok].filter((t) => !SERIES_OPTIONAL.has(t));
  return need.length ? need.every((t) => said.has(t)) : [...tok].every((t) => t === 'dd' || said.has(t));
};
const HINT_WORDS = new Set(['nm', 'niruma', 'dd', 'deepakbhai', 'pujyashree', 'informal', 'formal', 'master', 'mini', 'dv', 'dvcam', 'hd', '4k', 'episode', 'episodes', 'ep', 'raw']);

// The recording date of a row: a date column, or Day/Month/Year columns (year 1900 = unknown).
function rowDate(roles, cells) {
  if (roles.year != null) {
    const y = +cells[roles.year], mo = +cells[roles.month], d = +cells[roles.day];
    if (!(y > 1950)) return '';
    return isoDate(y, mo, d) || (mo >= 1 && mo <= 12 ? `${y}-${pad(mo)}` : String(y));
  }
  if (roles.date != null) return dates(cells[roles.date], { noYear: false })[0] || '';
  return '';
}

function displayDate(iso) {
  const [y, m, d] = String(iso).split('-');
  const mon = m && Object.keys(MONTHS).find((k) => MONTHS[k] === +m && k.length === 3);
  return d ? `${+d} ${mon[0].toUpperCase() + mon.slice(1)} ${y}` : m ? `${mon[0].toUpperCase() + mon.slice(1)} ${y}` : y || '';
}

class Catalog {
  constructor() { this.sheets = []; this.files = []; this.importedAt = null; this._index = []; this._byId = new Map(); }

  load(files) {
    const sheets = [];
    for (const file of files) for (const s of readWorkbook(file)) sheets.push({ ...s, file: path.basename(file), filePath: file });
    this.sheets = sheets;
    this.files = files;
    this.importedAt = Date.now();
    this._build();
    return this.stats();
  }

  toJSON() { return { v: 4, sheets: this.sheets, files: this.files, importedAt: this.importedAt }; }
  static fromJSON(o) {
    const c = new Catalog();
    Object.assign(c, o);
    // Older saved catalogues: recognise the columns again with today's rules.
    if (o.v !== 4) for (const s of c.sheets) { s.roles = detectRoles(s.headers); s.kind = sheetKind(s.roles); }
    c._build();
    return c;
  }

  _build() {
    this._index = [];
    this._byId = new Map();
    const addId = (k, e) => { if (!this._byId.has(k)) this._byId.set(k, []); this._byId.get(k).push(e); };
    this.sheets.forEach((s, si) => {
      const R = s.roles;
      const meta = new Set(R.meta || []);
      const skipIds = new Set([...meta, R.id, R.rawId, R.folder, R.day, R.month, R.year, R.episodeNo, R.series].filter((x) => x != null));
      s.rows.forEach((r, ri) => {
        const content = r.cells.filter((_, i) => !meta.has(i)).join(' | ');
        // Media numbers come from the backup columns when there are any; otherwise
        // from every column except ids ("DD-I-HD-2616-1" is not hard disk 2616).
        const idSource = R.locations?.length ? R.locations.map((i) => r.cells[i]) : r.cells.filter((_, i) => !skipIds.has(i));
        const idSet = new Set(idSource.flatMap(ids));
        for (const v of idSource) for (const id of ids(v)) { const n = id.match(/(\d+)$/); n && idSet.add(`#${+n[1]}`); }
        const date = rowDate(R, r.cells);
        const dateSet = new Set();
        if (date) { dateSet.add(date); dateSet.add(date.slice(0, 7)); dateSet.add(date.slice(0, 4)); }
        const e = {
          si, ri,
          tok: new Set(tokens(content)),
          // Words of the event and topic: what people usually ask by.
          what: new Set(tokens([R.event, R.title].filter((x) => x != null).map((i) => r.cells[i]).join(' '))),
          ids: idSet,
          dates: dateSet,
          folder: R.folder != null ? String(+r.cells[R.folder] || r.cells[R.folder]) : '',
          text: norm(content),
          kind: s.kind || 'raw',
          ser: parseRawId(r.cells[R.rawId ?? R.id]),
          epNo: R.episodeNo != null ? String(+r.cells[R.episodeNo] || '') : '',
          seriesTok: R.series != null ? new Set(tokens(r.cells[R.series])) : null,
        };
        this._index.push(e);
        if (R.id != null && r.cells[R.id]) addId(compact(r.cells[R.id]), e);
        // An episode is also found by the raw recording it was cut from.
        if (R.rawId != null && r.cells[R.rawId]) addId(compact(r.cells[R.rawId]), e);
      });
    });
  }

  // The search index for the Android app, which searches it offline (android/…/Catalog.kt
  // ports search()). Each row carries what the search needs, ready made, and what is shown.
  phoneExport() {
    const keys = new Map(); // row -> its exact-id keys
    for (const [k, list] of this._byId) for (const e of list) { if (!keys.has(e)) keys.set(e, []); keys.get(e).push(k); }
    return {
      version: this.importedAt || 0,
      sheets: this.sheets.map((s) => ({ name: s.sheetName, file: s.file, kind: s.kind || 'raw', backups: (s.roles.locations || []).map((i) => s.headers[i]) })),
      rows: this._index.map((e) => {
        const s = this.sheets[e.si];
        const R = s.roles;
        const r = s.rows[e.ri];
        const pick = (role) => (R[role] != null ? String(r.cells[R[role]] ?? '') : '');
        const iso = rowDate(R, r.cells);
        return {
          s: e.si, t: e.text, w: [...e.what].join(' '), i: [...e.ids], k: keys.get(e) || [],
          f: e.folder, n: e.epNo, st: e.seriesTok ? [...e.seriesTok].join(' ') : null,
          ser: e.ser ? [e.ser.authors.join(','), e.ser.type, e.ser.era] : null,
          d: iso,
          // Shown on the phone.
          id: pick('id'), raw: pick('rawId') || (e.kind === 'raw' ? pick('id') : ''), title: pick('title'), event: pick('event'),
          place: pick('place'), date: iso ? displayDate(iso) : pick('date'), series: pick('series'), sl: seriesLabel(e.ser) || '',
          loc: (R.locations || []).map((i) => String(r.cells[i] ?? '')), row: r.row,
        };
      }),
    };
  }

  stats() {
    return {
      files: this.files.map((f) => path.basename(f)),
      importedAt: this.importedAt,
      rows: this.sheets.reduce((a, s) => a + s.rows.length, 0),
      sheets: this.sheets.map((s) => ({ file: s.file, sheet: s.sheetName, rows: s.rows.length, headers: s.headers, roles: s.roles })),
    };
  }

  // query: free text, or { text, ids, numbers, dates, keywords } from the request reader.
  search(query, limit = 50) {
    const q = typeof query === 'string' ? { text: query } : query || {};
    const text = [q.text, ...(q.keywords || [])].filter(Boolean).join(' ');

    // Exact Raw Video Ids ("DD-F-4K-3049-E", "dd f 4k 3049 e").
    const exact = new Set();
    // Any run of 3-6 short parts inside the text ("please send DD-F-4K-3049-E").
    const parts = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      for (let k = Math.min(6, parts.length - i); k >= 3; k--) {
        const hit = this._byId.get(compact(parts.slice(i, i + k).join('')));
        if (hit) { hit.forEach((e) => exact.add(e)); i += k - 1; break; }
      }
    }

    // "folder 3049", "fld 3049", "f no 3049", "#3049", and bare 3-4 digit numbers that are not years.
    const folders = new Set((text.match(/\b(?:folder|fld|f)\s*(?:no\.?|number|#)?\s*0*(\d{1,5})\b/gi) || []).map((s) => String(+s.match(/(\d+)$/)[1])));
    // The request names a recording outright ("folder 3046", "DD-F-4K-3046-E").
    const namesRecording = folders.size > 0 || /\b[A-Z]{2,4}-[FI]-(?:HD|4K|DV)-\d{3,5}\b/i.test(text);
    // "hdd 123" is a drive, not folder 123. "DD Master 418" stays a folder: DV-era Master folders
    // are numbered that way, and people ask by them far more than by Amba drive names.
    const mediaNumbers = new Set(ids(text).filter((x) => x.includes(':') && !/^master\d/.test(ids(text).find((y) => y.endsWith(x.split(':')[1]) && !y.includes(':')) || '')).map((x) => x.split(':')[1]));
    for (const n of text.matchAll(/(?:^|[\s#])0*(\d{3,4})\b/g)) if (!(+n[1] >= 1950 && +n[1] < 2100) && !mediaNumbers.has(String(+n[1]))) folders.add(String(+n[1]));

    const qIds = new Set([...(q.ids || []).flatMap((x) => (ids(x).length ? ids(x) : [x])), ...ids(text)]);
    for (const n of q.numbers || []) qIds.add(`#${+n}`);
    for (const f of folders) { qIds.delete(`folder${f}`); qIds.delete(`fld${f}`); qIds.delete(`f${f}`); }
    const qDates = new Set([...(q.dates || []), ...dates(text, { years: true })].filter((d) => /^\d{4}(-\d{2}){0,2}$/.test(d)));
    const stop = new Set(['the', 'and', 'for', 'please', 'send', 'need', 'data', 'copy', 'from', 'with', 'of', 'to', 'me', 'pls', 'plz', 'kindly', 'can', 'you', 'give', 'want', 'footage', 'video', 'videos', 'all', 'that', 'this', 'on', 'in', 'at', 'is', 'it', 'hi', 'hello', 'bhai', 'ji', 'folder', 'fld', 'no', 'number', 'drive', 'tape', 'raw', 'files', 'file', 'recording', 'i', 'think', 'was', 'which', 'where', 'is']);
    const hints = seriesHints(text);
    const allWords = [...new Set(tokens(text))].filter((t) => !stop.has(t) && !/^\d+$/.test(t) && !MONTH_WORDS.test(t));
    const words = allWords.filter((t) => !HINT_WORDS.has(t));
    // Episode numbers come right after the series name ("vitraag 2350", "DD Hindi ep 12",
    // "Aptavani-14-B2 episode 14"): each number keeps the few words before it.
    const tl = norm(text).split(' ').filter(Boolean);
    const epWindow = new Map();
    tl.forEach((t, i) => { if (/^\d{1,5}$/.test(t) && !(+t >= 1950 && +t < 2100)) epWindow.set(String(+t), new Set([...(epWindow.get(String(+t)) || []), ...tl.slice(Math.max(0, i - 5), i)])); });
    const nums = new Set(epWindow.keys());
    if (!exact.size && !folders.size && !qIds.size && !qDates.size && !words.length && !nums.size) return [];

    const results = [];
    for (const e of this._index) {
      let score = 0;
      const why = [];
      if (exact.has(e)) { score += e.kind === 'episode' && e.ser && !e.epNo ? 120 : 200; why.push('id'); }
      if (e.folder && folders.has(e.folder)) { score += 70; why.push(`folder ${e.folder}`); }
      // Every word of the series name must be asked for: "aptavani 14" is not episode 14 of Aptavani-10(P).
      // "DD" and "Satsang" may be left out: "Sevarthi episode 98" is DD Sevarthi Satsang 98.
      if (e.epNo && nums.has(e.epNo) && e.seriesTok && seriesAsked(e.seriesTok, epWindow.get(e.epNo))) { score += 150; why.push(`episode ${e.epNo}`); }
      // The same folder number exists in several series: what the request says decides.
      if (e.ser) {
        for (const k of ['author', 'type', 'era']) {
          if (!hints[k]) continue;
          const ok = k === 'author' ? e.ser.authors.includes(hints[k]) : e.ser[k] === hints[k];
          if (ok) { score += 15; why.push(hints[k]); } else score -= 25;
        }
      }
      // One message often asks for both ("master 418 and Vitraag episode 2350"): favour, never punish.
      if (hints.kind === e.kind) score += 10;
      for (const id of qIds) if (e.ids.has(id)) { score += id.startsWith('#') ? 20 : id.includes(':') ? 30 : 40; why.push(id); }
      for (const d of qDates) if (e.dates.has(d)) { score += d.length === 10 ? 40 : d.length === 7 ? 25 : 20; why.push(d); }
      let hits = 0;
      for (const w of words) {
        if (e.tok.has(w)) { hits++; score += e.what.has(w) ? 16 : 10; }
        else if (w.length >= 4 && e.text.includes(w)) { hits++; score += 6; }
        else if (w.length >= 5) for (const t of e.tok) if (Math.abs(t.length - w.length) <= 1 && near(t, w)) { hits++; score += 4; break; }
      }
      if (words.length > 1 && hits === words.length) score += 10;
      // A date or number that was asked for and is missing counts against the row.
      if (qDates.size && ![...qDates].some((d) => e.dates.has(d))) score -= 8;
      if (score > 0 && why.length + hits > 0) results.push({ score, why, e });
    }
    results.sort((a, b) => b.score - a.score);
    // When the request names the recording, rows sharing only a word with it ("making",
    // "video") are noise: keep rows matched by id, folder, episode, media number or date.
    const named = (r) => r.why.some((w) => w === 'id' || /^(folder|episode) /.test(w));
    const kept = namesRecording || results.some(named) ? results.filter((r) => r.why.length) : results;
    return kept.slice(0, limit).map(({ score, why, e }) => this._row(e, score, why));
  }

  _row(e, score, why) {
    const s = this.sheets[e.si];
    const r = s.rows[e.ri];
    const R = s.roles;
    const pick = (role) => (R[role] != null ? r.cells[R[role]] : '');
    const iso = rowDate(R, r.cells);
    const locations = (R.locations || []).map((i) => ({ label: s.headers[i], value: r.cells[i] })).filter((l) => l.value);
    return {
      score, why,
      file: s.file, sheet: s.sheetName, row: r.row,
      headers: s.headers, cells: r.cells,
      id: pick('id'), folder: pick('folder'), title: pick('title'), event: pick('event'),
      date: iso ? displayDate(iso) : pick('date'), iso: iso.length === 10 ? iso : '', session: pick('session'),
      place: pick('place'), path: pick('path'),
      locations,
      // Every backup column of the sheet, filled or not: an empty one means "not backed up there yet".
      backups: (R.locations || []).map((i) => s.headers[i]),
      kind: e.kind || 'raw',
      rawId: pick('rawId') || (e.kind === 'raw' ? pick('id') : ''),
      series: pick('series'), episodeNo: e.epNo || '',
      ser: e.ser, seriesLabel: seriesLabel(e.ser) || '',
    };
  }
}

// One edit apart (typo tolerance for names).
function near(a, b) {
  if (a === b) return true;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

module.exports = { Catalog, ids, dates, tokens, norm, readWorkbook, detectRoles, parseRawId, seriesHints };
