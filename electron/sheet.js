// Requests that come as a spreadsheet (Excel, CSV, OpenDocument): each row becomes one
// "• " line of the request's words, labelled with its column names, so a sheet of recordings
// is searched row by row and drafts one checklist item per row (extract.js requestItems).
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SHEET_EXT = /\.(xlsx|xlsm|xls|xlsb|csv|ods)$/i;
const SHEET_TYPE = /(spreadsheet|excel|csv|opendocument\.spreadsheet)/i;
const isSheet = (name, type = '') => SHEET_EXT.test(String(name || '')) || SHEET_TYPE.test(String(type || ''));
const MAX_ROWS = 150;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function cellText(v) {
  if (v == null) return '';
  // Excel keeps dates as dates: written the way the catalogue search reads them ("3 Jun 2011").
  if (v instanceof Date && !Number.isNaN(+v)) {
    const d = new Date(v.getTime() + 12 * 3600000); // SheetJS dates sit at local midnight: avoid the day before
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

// A first row of only words (no digits anywhere: "Folder No.", not "DD-F-HD-3050-E") names the columns.
const isHeader = (row) => row.filter((c) => cellText(c)).length >= 2 && row.every((c) => c == null || c === '' || (typeof c === 'string' && !/\d/.test(c)));

// { text, rows, sheets }: text is "• Folder No.: 3050 · City: Adalaj · …", one line per row.
function readSheet(file) {
  const wb = XLSX.read(fs.readFileSync(file), { cellDates: true, dense: true });
  const lines = [];
  let rows = 0;
  const sheets = [];
  for (const name of wb.SheetNames) {
    const all = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
      .filter((r) => r.some((c) => cellText(c)));
    if (!all.length) continue;
    const head = isHeader(all[0]) ? all[0].map(cellText) : null;
    const body = head ? all.slice(1) : all;
    sheets.push({ name, rows: body.length });
    for (const r of body) {
      if (rows >= MAX_ROWS) break;
      const cells = r.map((c, i) => [head?.[i], cellText(c)]).filter(([, v]) => v);
      if (!cells.length) continue;
      lines.push(`• ${cells.map(([h, v]) => (h ? `${h}: ${v}` : v)).join(' · ')}`);
      rows++;
    }
  }
  const more = sheets.reduce((n, s) => n + s.rows, 0) - rows;
  return { text: lines.join('\n') + (more > 0 ? `\n\n(${more} more rows not read)` : ''), rows, sheets, name: path.basename(file) };
}

module.exports = { readSheet, isSheet, cellText };
