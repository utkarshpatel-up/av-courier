// Spreadsheets as the PC reads them (electron/sheet.js). The Android app's SheetTest reads the
// same files with its own reader (Sheet.kt) and must get the same lines. Run
// `node tests/sheet-fixture.js` to rewrite the files in android/app/src/test/resources after
// changing electron/sheet.js; tests/sheet.test.js fails until then.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { readSheet } = require('../electron/sheet');

const OUT = path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources');

const ROWS = [
  ['Sr', 'Raw Video Id', 'Folder No.', 'Date', 'City', 'Topic'],
  [1, 'DD-F-HD-3050-E', 3050, new Date(2026, 9, 17), 'Adalaj', 'Live Garba'],
  [],
  [2, 'DD-F-HD-1260-E1', 1260, new Date(2011, 5, 3), 'Los Angeles', 'Gnanvidhi  (part 2)'],
  [3, '', '', '', 'Udaipur', 'Sevarthi Shibir Part 098'],
  [4, 'NM-F-DV-0418-E2', 418, new Date(2003, 1, 16), 'Mumbai', 3.5],
];

// Two ways Excel files are written: words kept once in a shared list (as Excel does), or in each cell.
const FILES = { 'sheet-shared.xlsx': { bookSST: true }, 'sheet-inline.xlsx': { bookSST: false } };

function write(dir) {
  const out = {};
  for (const [name, opts] of Object.entries(FILES)) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ROWS, { cellDates: true }), 'Needed');
    // A second sheet with no header row: read too.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['DD-F-4K-3046-E', 'General Satsang'], ['DD-I-HD-2616-1', 'Informal Satsang']]), 'More');
    const p = path.join(dir, name);
    XLSX.writeFile(wb, p, { bookType: 'xlsx', ...opts });
    out[name] = readSheet(p).text;
  }
  const csv = path.join(dir, 'sheet-list.csv');
  fs.writeFileSync(csv, 'Event,Place,Folder No.\n"Janmashtami Sabha, evening",Ahmedabad,3034\nGuru Purnima Satsang,Vadodara,1543\n');
  out['sheet-list.csv'] = readSheet(csv).text;
  return out;
}

module.exports = { write, OUT };

if (require.main === module) {
  const expected = write(OUT);
  fs.writeFileSync(path.join(OUT, 'sheet-expected.json'), JSON.stringify(expected, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(expected).length} spreadsheets and sheet-expected.json to ${OUT}`);
}
