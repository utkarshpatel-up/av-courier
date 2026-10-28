const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readSheet, isSheet } = require('../electron/sheet');
const { requestItems } = require('../electron/extract');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-sheet-'));
function xlsx(name, rows) {
  const p = path.join(dir, name);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), 'Needed');
  XLSX.writeFile(wb, p);
  return p;
}

test('a sheet of recordings: one labelled line per row, dates as words', () => {
  const p = xlsx('request.xlsx', [
    ['Sr', 'Folder No.', 'Date', 'City', 'Topic'],
    [1, 3050, new Date(2026, 9, 17), 'Adalaj', 'Live Garba'],
    [],
    [2, 1260, new Date(2011, 5, 3), 'Los Angeles', 'Gnanvidhi'],
    [3, '', '', 'Udaipur', 'Sevarthi Shibir Part 098'],
  ]);
  const s = readSheet(p);
  assert.equal(s.rows, 3);
  const lines = s.text.split('\n');
  assert.equal(lines[0], '• Sr: 1 · Folder No.: 3050 · Date: 17 Oct 2026 · City: Adalaj · Topic: Live Garba');
  assert.equal(lines[1], '• Sr: 2 · Folder No.: 1260 · Date: 3 Jun 2011 · City: Los Angeles · Topic: Gnanvidhi');
  assert.equal(lines[2], '• Sr: 3 · City: Udaipur · Topic: Sevarthi Shibir Part 098');
  // With the message around it, each row is its own checklist item.
  const items = requestItems(`Please send these, list attached\n\n${s.text}`);
  assert.equal(items.length, 3);
  assert.match(items[1], /^Sr: 2 · Folder No\.: 1260/);
});

test('a CSV with no header row keeps every row', () => {
  const p = path.join(dir, 'list.csv');
  fs.writeFileSync(p, 'DD-F-HD-3050-E,Live Garba\nDD-F-HD-1260-E1,Gnanvidhi\n');
  const s = readSheet(p);
  assert.equal(s.rows, 2);
  assert.equal(s.text, '• DD-F-HD-3050-E · Live Garba\n• DD-F-HD-1260-E1 · Gnanvidhi');
});

test('spreadsheets are told apart from other attachments', () => {
  for (const n of ['a.xlsx', 'B.XLS', 'c.csv', 'd.ods', 'e.xlsm']) assert.ok(isSheet(n), n);
  assert.ok(isSheet('noname', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  for (const n of ['a.pdf', 'b.jpg', 'c.docx']) assert.ok(!isSheet(n, 'application/pdf'), n);
});

test('the phone reads the same spreadsheets the same way (fixture is current)', () => {
  // Sheet.kt's test compares against this file: rewrite it with `node tests/sheet-fixture.js`.
  const { write, OUT } = require('./sheet-fixture');
  const now = write(fs.mkdtempSync(path.join(os.tmpdir(), 'avc-sheetfx-')));
  assert.deepStrictEqual(now, JSON.parse(fs.readFileSync(path.join(OUT, 'sheet-expected.json'), 'utf8')));
});
