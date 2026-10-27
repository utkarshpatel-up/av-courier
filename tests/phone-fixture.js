// A small made-up catalogue and the PC's search results for it. The Android app's
// CatalogTest searches the same catalogue with its port (Catalog.kt) and must get the
// same rows, scores and reasons. Run `node tests/phone-fixture.js` to rewrite the files
// in android/app/src/test/resources after changing the search in electron/catalog.js;
// tests/phone-catalog.test.js fails until then.
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { Catalog } = require('../electron/catalog');
const { heuristic } = require('../electron/extract');

const OUT = path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources');

const RAW = [
  ['Raw Video Id', 'Folder No.', 'Day', 'Month', 'Year', 'Author', 'Satsang Type', 'City', 'Event Type', 'Topic/Description', 'Vatsalya Backup', 'Amba Video Backup', 'HDD Backup', 'Disaster Recovery Backup'],
  ['DD-F-4K-3046-E', 3046, 9, 10, 2026, 'DD', 'Formal', 'Hong Kong', 'General', 'General Satsang', '', '', '', ''],
  ['DD-F-HD-3050-E', 3050, 17, 10, 2026, 'DD', 'Formal', 'Adalaj', 'Navratri,Garba', 'Live Garba', '', '', '', ''],
  ['DD-I-HD-2616-1', 2616, 16, 10, 2026, 'DD', 'Informal', 'Adalaj', 'General', 'Informal Satsang', '', '', 'Sankul-6', ''],
  ['DD-F-4K-3034-E', 3034, 15, 9, 2026, 'DD', 'Formal', 'Adalaj', 'Parayan', 'Aptavani-14 Part-05', 'DD MASTER SSD - 123', 'DD MASTER - 112', 'DD MASTER HDD - 057', ''],
  ['DD-I-HD-1543-1', 1543, 20, 7, 2019, 'DD', 'Informal', 'Chicago', 'Gurupurnima', 'Dada Darbar', 'DD VATSALYA - LTO SD Card - 12', 'DD Informal-11', '8', ''],
  ['DD-F-HD-1469-E', 1469, 31, 12, 2019, 'DD', 'Formal', 'Adalaj', 'Gurupurnima', 'New Year message', '', 'DD MASTER - 058', '', ''],
  ['NM-I-DV-0196-1', 196, 1, 1, 1900, 'NM', 'Informal', 'N.A', 'General', 'Machine Demo', 'NM-NA-VAT-MD1-LTO-002', '', '', 'OFS-MD1-NAS-001'],
  ['NM-F-DV-0418-E2', 418, 16, 2, 2003, 'NM', 'Formal', 'Mumbai', 'Satsang', 'Pratikraman Vidhi', '', 'NM MASTER - 21', '', ''],
  ['DD-F-DV-0418-E1', 418, 7, 6, 2007, 'DD', 'Formal', 'Vadodara', 'Shibir', 'Youth Shibir', 'DD MASTER - 040', '', '', ''],
  ['DD-I-HD-2422-1', 2422, 18, 5, 2025, 'DD', 'Informal', 'Adalaj', 'General', 'Trimandir Making', '', '', '', ''],
  ['DD-I-HD-1888-4', 1888, 2, 1, 2022, 'DD', 'Informal', 'Adalaj', 'General', 'Making of New Sankul Building', '', '', '', ''],
  ['DD-F-HD-1796-E', 1796, 5, 2, 2021, 'DD', 'Formal', 'Adalaj', 'Departmental Satsang', 'Departmental Sevarthi Satsang', '', 'DD MASTER - 090', '', ''],
  ['DD-F-HD-1260-E1', 1260, 3, 6, 2011, 'DD', 'Formal', 'Los Angeles', 'Gnanvidhi', 'General', 'DD MASTER - 031', 'HDD-0124', 'LTO-47', ''],
];
const EPISODES = [
  ['Episode Id', 'Series', 'Episode No', 'Raw Video Id', 'Day', 'Month', 'Year', 'Topic/Description', 'City', 'LTO Tape No.'],
  ['DD Vitraag_002350', 'DD Vitraag', 2350, 'DD-F-HD-1260-E1', 3, 6, 2011, 'General', 'Los Angeles', 'DD Vitraag LTO-11'],
  ['DD Vitraag_006955', 'DD Vitraag', 6955, 'DD-F-HD-1796-E', 5, 2, 2021, 'General', 'Adalaj', 'DD Vitraag LTO-21'],
  ['DD Hindi_000953', 'DD Hindi', 953, 'DD-F-4K-1314-M', 9, 5, 2019, 'Hindi Shibir', 'Adalaj', 'DD Hindi - 04'],
  ['Aptavani-14-B2_000014', 'Aptavani-14-B2', 14, 'DD-F-4K-3034-E', 15, 9, 2026, 'Aptavani-14 Part-05', 'Adalaj', ''],
  ['Aptavani-10(P)_000014', 'Aptavani-10(P)', 14, 'DD-F-HD-0999-E', 1, 1, 2016, 'Aptavani-10 Purvardh', 'Adalaj', 'Apt LTO-02'],
];

// Free-text searches (Find Data) and request messages (read by heuristic() first).
const FIND = [
  'folder 3046', 'DD-F-4K-3034-E', 'dd f 4k 3034 e', 'master ssd 123', 'lto 002', 'navratri garba 2026', 'gurupurnima 2019 adalaj',
  'nm mini dv 196', 'NM master 418', 'DD Vitraag 2350', 'Aptavani-14-B2 episode 14', 'aptavani 14', 'trimandir making', 'making of sankul bulding',
  'HDD-0124', 'drive 124', 'sevarthi satsang feb 2021', 'satsang hong kong', 'folder 3099 making', 'DD-F-HD-1796-E',
];
const REQUESTS = [
  'Raw data requirement\n\nNeed raw folder 3046 for making prachaar video',
  'Please send DD-F-4K-3034-E',
  'Bhai folder 2616 no data joie che',
  'Vitraag episode 2350 mokalo',
  'Gurupurnima 2019 Chicago ni recording bhejo',
  'drive no 124 ma shu che?',
  'Need raw folder 3099 for making prachaar video',
];

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-phone-'));
  const file = (name, rows, sheet) => {
    const p = path.join(dir, name);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
    XLSX.writeFile(wb, p);
    return p;
  };
  const c = new Catalog();
  c.load([file('raw_fixture.xlsx', RAW, 'Raw Video Data'), file('episode_fixture.xlsx', EPISODES, 'Episode Data')]);
  c.importedAt = 1761000000000; // fixed, so the files only change when the search does
  const x = c.phoneExport();
  const ndjson = [JSON.stringify({ version: x.version, sheets: x.sheets, rows: x.rows.length }), ...x.rows.map((r) => JSON.stringify(r))].join('\n') + '\n';
  const out = (rows) => rows.map((r) => ({ id: r.id, score: r.score, why: r.why }));
  const expected = [
    ...FIND.map((q) => ({ mode: 'find', q, results: out(c.search(q, 100)) })),
    ...REQUESTS.map((q) => {
      const a = heuristic(q);
      return { mode: 'request', q, results: out(c.search({ text: q, ids: a.ids, numbers: a.numbers, dates: a.dates, keywords: a.keywords }, 15)) };
    }),
  ];
  return { ndjson, expected: JSON.stringify(expected, null, 1) + '\n', catalog: c };
}

module.exports = { build, OUT };

if (require.main === module) {
  const { ndjson, expected } = build();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'catalog-fixture.ndjson'), ndjson);
  fs.writeFileSync(path.join(OUT, 'catalog-expected.json'), expected);
  console.log(`Wrote ${path.join(OUT, 'catalog-fixture.ndjson')} and catalog-expected.json`);
}
