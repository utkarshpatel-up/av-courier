const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { CopyQueue } = require('../electron/copyqueue');
const { Catalog, ids, dates } = require('../electron/catalog');
const { heuristic } = require('../electron/extract');
const { DriveIndex, parseDayFolder } = require('../electron/locate');
const { fill, rowLine } = require('../electron/notifier');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avc-'));
const finished = (q) => new Promise((r) => q.once('job-finished', r));

test('copies a folder, keeps its name, verifies every file', async () => {
  const src = path.join(tmp(), 'Event 01');
  fs.mkdirSync(path.join(src, 'Cam-01'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Program.mov'), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(src, 'Cam-01', 'a.mov'), 'abc');
  const dest = tmp();
  const q = new CopyQueue({ settings: () => ({ bufferMB: 1 }) });
  const done = finished(q);
  await q.addJob({ sources: [src], dest });
  const job = await done;
  assert.equal(job.status, 'done');
  assert.equal(job.done, 2);
  assert.ok(job.files.every((f) => f.verified));
  assert.equal(fs.readFileSync(path.join(dest, 'Event 01', 'Cam-01', 'a.mov'), 'utf8'), 'abc');
});

test('skips identical files, renames different ones', async () => {
  const dir = tmp();
  const f = path.join(dir, 'clip.mov');
  fs.writeFileSync(f, 'one');
  const dest = tmp();
  const q = new CopyQueue();
  let done = finished(q); await q.addJob({ sources: [f], dest }); await done;
  done = finished(q); await q.addJob({ sources: [f], dest }); const again = await done;
  assert.equal(again.skipped, 1);
  fs.writeFileSync(f, 'different');
  done = finished(q); await q.addJob({ sources: [f], dest }); await done;
  assert.ok(fs.existsSync(path.join(dest, 'clip (2).mov')));
});

test('files added to a queued job and removed files are honoured', async () => {
  const dir = tmp();
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, n), n);
  const dest = tmp();
  const q = new CopyQueue();
  q.pause();
  const job = await q.addJob({ sources: [path.join(dir, 'a'), path.join(dir, 'b')], dest });
  await q.addFiles(job.id, [path.join(dir, 'c')]);
  q.removeFile(job.id, 1);
  const done = finished(q);
  q.resume();
  const out = await done;
  assert.deepEqual(fs.readdirSync(dest).sort(), ['a', 'c']);
  assert.equal(out.count, 2);
});

test('queue order and persistence', async () => {
  const state = path.join(tmp(), 'q.json');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  const q = new CopyQueue({ statePath: state });
  q.pause();
  const a = await q.addJob({ sources: [path.join(dir, 'x')], dest: tmp(), name: 'A' });
  await q.addJob({ sources: [path.join(dir, 'x')], dest: tmp(), name: 'B' });
  q.move(a.id, 1);
  assert.deepEqual(q.jobs.map((j) => j.name), ['B', 'A']);
  await new Promise((r) => setTimeout(r, 400));
  const q2 = new CopyQueue({ statePath: state });
  assert.deepEqual(q2.jobs.map((j) => j.name), ['B', 'A']);
  assert.equal(q2.paused, true);
});

test('drive and tape numbers match however they are written', () => {
  assert.ok(ids('HDD-0123').includes('d:123'));
  assert.ok(ids('drive no 123').includes('d:123'));
  assert.ok(ids('LTO 045').includes('t:45'));
  assert.deepEqual(dates('Dt-16-Aug-26'), ['2026-08-16']);
  assert.ok(dates('on 16/08/2026').includes('2026-08-16'));
});

function workbook(rows) {
  const file = path.join(tmp(), 'db.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Archive');
  XLSX.writeFile(wb, file);
  return file;
}

test('catalogue finds rows by drive number, date and words', () => {
  const file = workbook([
    ['Archive export Q3 2026'],
    ['Sr', 'Drive No', 'Tape No', 'Event', 'Place', 'Date', 'Folder'],
    [1, 'HDD-0123', 'LTO-45', 'Janmashtami Sabha', 'Ahmedabad', '16-08-2026', 'D:/2026/Janmashtami'],
    [2, 'HDD-0124', 'LTO-46', 'Guru Purnima Satsang', 'Vadodara', '10-07-2026', 'D:/2026/GuruPurnima'],
    [3, 'HDD-0124', 'LTO-47', 'Youth Shibir', 'Coppell', '02-08-2026', 'D:/2026/Shibir'],
  ]);
  const c = new Catalog();
  const stats = c.load([file]);
  assert.equal(stats.rows, 3);
  assert.deepEqual(stats.sheets[0].roles.locations, [1, 2]);
  assert.equal(stats.sheets[0].roles.path, 6);
  assert.equal(c.search('drive 123')[0].event, 'Janmashtami Sabha');
  assert.equal(c.search('need guru purnima vadodra footage')[0].locations[0].value, 'HDD-0124');
  assert.equal(c.search({ dates: ['2026-08-02'] })[0].place, 'Coppell');
  assert.equal(Catalog.fromJSON(JSON.parse(JSON.stringify(c))).search('lto 47')[0].event, 'Youth Shibir');
});

test('searching before any catalogue is imported finds nothing instead of failing', () => {
  const c = new Catalog();
  assert.deepEqual(c.search('Please send DD-F-4K-3034-E folder 3034 from drive 123'), []);
  assert.deepEqual(c.search({ text: 'Satsang video', ids: ['d:123'], dates: ['2026-08-16'], keywords: ['Adalaj'] }), []);
});

test('request detection', () => {
  assert.ok(heuristic('Bhai please send Janmashtami sabha footage of 16 Aug').isRequest);
  assert.ok(!heuristic('ok thanks').isRequest);
});

test('message templates', () => {
  assert.equal(fill('Hi {name}, {files} files ({size})', { name: 'Ravi', files: 3, size: '2 GB' }), 'Hi Ravi, 3 files (2 GB)');
});

test('Raw Video Data layout: ids, folders, split dates, backup columns', () => {
  const H = ['Raw Video Id', 'Folder No.', 'Day', 'Month', 'Year', 'Activity', 'Author', 'Format', 'Satsang Type', 'City', 'State', 'Country', 'Place Details', 'Session', 'Event Type', 'Topic/Description', 'Remarks', 'Language', 'Duration', 'No. Of Clips', 'Assigned To', 'Editing Done', 'Vatsalya Backup', 'Amba Video Backup', 'HDD Backup', 'Disaster Recovery Backup', 'Created By', 'Creation Date', 'Last Modified By', 'Modified Date'];
  const row = (id, folder, d, m, y, city, ev, topic, backups, created) => [id, folder, d, m, y, 'General', 'DD', 'HD', 'Formal', city, '', '', '', 'E', ev, topic, '', 'Gujarati', '1:00:00', 1, '', '', ...backups, 'Someone', created, 'Someone', created];
  const file = workbook([H,
    row('DD-F-HD-3050-E', 3050, 17, 10, 2026, 'Adalaj', 'Navratri,Garba', 'Live Garba', ['', '', '', ''], '18-Oct-2026'),
    row('DD-I-HD-2616-1', 2616, 16, 10, 2026, 'Adalaj', 'General', 'Informal Satsang', ['', '', 'Sankul-6', ''], '17-Oct-2026'),
    row('DD-F-4K-3034-E', 3034, 15, 9, 2026, 'Adalaj', 'Parayan', 'Aptavani-14 Part-05', ['DD MASTER SSD - 123', 'DD MASTER - 112', 'DD MASTER HDD - 057', ''], '15-Sep-2026'),
    row('DD-I-HD-1543-1', 1543, 20, 7, 2019, 'Chicago', 'Gurupurnima', 'Dada Darbar', ['DD VATSALYA - LTO SD Card - 12', 'DD Informal-11', '8', ''], '20-Jul-2019'),
    row('DD-F-HD-1469-E', 1469, 31, 12, 2019, 'Adalaj', 'Bhakti', 'New Year message', ['', 'DD MASTER - 058', '', ''], '01-Jan-2020'),
    row('NM-I-DV-0354-1', 354, 1, 1, 1900, 'N.A', 'General', 'Machine Demo', ['NM-NA-VAT-MD1-LTO-002', '', '', 'OFS-MD1-NAS-001'], '08-Feb-2022'),
  ]);
  const c = new Catalog();
  const { sheets: [s] } = c.load([file]);
  const name = (i) => s.headers[i];
  assert.deepEqual(s.roles.locations.map(name), ['Vatsalya Backup', 'Amba Video Backup', 'HDD Backup', 'Disaster Recovery Backup']);
  assert.equal(name(s.roles.title), 'Topic/Description');
  assert.equal(name(s.roles.event), 'Event Type');
  assert.equal(name(s.roles.folder), 'Folder No.');
  assert.equal(c.search('please send DD-F-4K-3034-E')[0].folder, '3034');
  assert.equal(c.search('folder 2616')[0].id, 'DD-I-HD-2616-1');
  assert.equal(c.search('drive 2616').length, 0, 'a raw video id is not a drive number');
  assert.equal(c.search('master ssd 123')[0].id, 'DD-F-4K-3034-E');
  assert.equal(c.search('lto 002')[0].id, 'NM-I-DV-0354-1');
  const garba = c.search('navratri garba 17 oct 2026');
  assert.equal(garba[0].id, 'DD-F-HD-3050-E');
  assert.equal(garba[0].date, '17 Oct 2026');
  assert.equal(c.search({ dates: ['2026-10-18'] }).length, 0, 'creation dates are not recording dates');
  assert.equal(c.search('gurupurnima 2019 adalaj')[0].id, 'DD-I-HD-1543-1');
  assert.equal(c.search('machine demo')[0].date, '', 'year 1900 means unknown');
  assert.ok(rowLine(c.search('folder 3034')[0]).includes('Vatsalya: DD MASTER SSD - 123'));
  assert.ok(rowLine(c.search('folder 3050')[0]).includes('not on any backup yet'));
});

test('a request naming a folder gets that folder, not rows sharing a word', () => {
  const H = ['Raw Video Id', 'Folder No.', 'Day', 'Month', 'Year', 'Topic/Description', 'City', 'Vatsalya Backup'];
  const raw = workbook([H,
    ['DD-F-4K-3046-E', 3046, 9, 10, 2026, 'General Satsang', 'Adalaj', 'DD MASTER SSD - 130'],
    ['DD-I-HD-2422-1', 2422, 18, 5, 2025, 'Trimandir Making', 'Adalaj', ''],
    ['DD-I-HD-1888-4', 1888, 2, 1, 2022, 'Making of New Sankul Building video', 'Adalaj', ''],
  ]);
  const c = new Catalog();
  c.load([raw]);
  const text = 'Raw data requirement\n\nNeed raw folder 3046 for making prachaar video';
  const [hit] = c.search({ text });
  assert.equal(hit.id, 'DD-F-4K-3046-E');
  assert.deepEqual(hit.backups, ['Vatsalya Backup'], 'backup columns are listed even when a row has none filled');
  assert.equal(c.search('folder 2422')[0].locations.length, 0);
  assert.deepEqual(c.search('folder 2422')[0].backups, ['Vatsalya Backup']);
  // Not in the catalogue: nothing, rather than unrelated "making" rows.
  assert.deepEqual(c.search({ text: 'Need raw folder 3099 for making prachaar video' }), []);
  // Without a folder or id, words still find things.
  assert.equal(c.search('trimandir making')[0].id, 'DD-I-HD-2422-1');
});

test('Gujarati and Hindi requests are recognised', () => {
  for (const t of ['Bhai folder 3034 no data joie che', 'Hong kong peak visit no video mokalo ne', 'janma jayanti 2012 raw data chahiye']) assert.ok(heuristic(t).isRequest, t);
  for (const t of ['Satsang saras hato', 'Jai Sachchidanand, kem cho?']) assert.ok(!heuristic(t).isRequest, t);
});

test('day folder names', () => {
  assert.deepEqual(parseDayFolder('3017 Dt-16 Aug 2026'), { number: '3017', date: '2026-08-16' });
  assert.deepEqual(parseDayFolder('0354 Dt-01-Jan-26'), { number: '354', date: '2026-01-01' });
  assert.equal(parseDayFolder('3017 to 3050'), null);
  assert.equal(parseDayFolder('Clips for Insert'), null);
});

test('finds recordings on drives in both the DV and the HD layout', async () => {
  const drive = tmp();
  const mk = (...p) => fs.mkdirSync(path.join(drive, ...p), { recursive: true });
  const touch = (...p) => { mk(...p.slice(0, -1)); fs.writeFileSync(path.join(drive, ...p), 'x'); };
  // HD/4K: day folders with sessions.
  mk('Pujyashree Deepakbhai', 'Formal', 'HD, 4K', '3017 to 3050', '3034 Dt-15 Sep 2026', 'Adalaj Aptavani-14 Part-05 Parayan M. Dt-15-Sep-26 Dur-1h2m');
  mk('Pujyashree Deepakbhai', 'Formal', 'HD, 4K', '3017 to 3050', '3034 Dt-15 Sep 2026', 'Adalaj Aptavani-14 Part-05 Parayan E. Dt-15-Sep-26 Dur-58m');
  mk('Pujyashree Deepakbhai', 'Formal', 'HD, 4K', '1146 to 1152', '1151 Dt-10 Sep 2018 (Part-02)', '01 Adalaj Aptvani 13U Parayan Mor. Dt-10-09-18');
  mk('Pujyashree Deepakbhai', 'Formal', 'HD, 4K', '1146 to 1152', '1151 Dt-10 Sep 2018 (Part-02)', '02 Adalaj Aptvani 13U Parayan Eve. Dt-10-09-18');
  // DV: numbered folders and single files, no dates.
  mk('Pujyashree Deepakbhai', 'Formal', 'DVCAM', 'DD Master (0401 to 0420)', '0418');
  touch('Pujyashree Deepakbhai', 'Informal', 'DVCAM', 'DD Mini DV (0741 to 0792)', 'DD Mini DV 741.avi');
  mk('Niruma', 'Formal', 'DVCAM', 'NM MASTER - 0418 to 0438', 'NM-0418');
  touch('Niruma', 'Informal', 'DVCAM', 'NM Mini DV (181 to 228)', 'NM Master Mini Dv - 196.avi');
  mk('Niruma', 'Formal', 'VHS', 'Niruma VHS (1 to 137)', '0418');
  // Episodes.
  touch('Pujyashree Deepakbhai', 'Episode', 'DVCAM', 'Gujarati', 'DD Vitraag-0001-3476', 'DD Vitraag-2301-2400', 'DD Vitraag-2350.mp4');
  touch('Pujyashree Deepakbhai', 'Episode', 'HD', 'Aptavani-14-B2', 'Aptavani-14-B2 - 014.mp4');

  const idx = new DriveIndex({ getConfig: () => ({ scanDrives: false, extraRoots: [drive] }) });
  await idx.scan();
  const { parseRawId } = require('../electron/catalog');
  const raw = (id, iso = '') => ({ kind: 'raw', ser: parseRawId(id), folder: parseRawId(id).number, iso, session: parseRawId(id).session });
  const one = (row) => { const f = idx.find(row); assert.equal(f.length, 1, JSON.stringify(f)); return f[0]; };

  const hd = one(raw('DD-F-4K-3034-E', '2026-09-15'));
  assert.ok(hd.exact);
  assert.match(hd.session, /Parayan E\. Dt/);
  assert.match(one(raw('DD-F-HD-1151-E', '2018-09-10')).session, /Eve\. Dt/);
  assert.match(one(raw('DD-F-HD-1151-M', '2018-09-10')).session, /Mor\. Dt/);

  // Folder 418 exists for DD Formal DV, NM Formal DV and NM VHS: the Raw Id picks one.
  assert.match(one(raw('DD-F-DV-0418-E1', '2007-06-07')).path, /DD Master \(0401 to 0420\)[\\/]0418$/);
  assert.match(one(raw('NM-F-DV-0418-E2', '2003-02-16')).path, /NM-0418$/);
  assert.equal(idx.find(raw('DD-F-HD-0418-M', '2015-02-16')).length, 0, 'HD folder 418 is not on this drive');
  const mini = one(raw('DD-I-DV-0741-1', '2009-07-22'));
  assert.ok(mini.isFile && mini.exact);
  assert.match(one(raw('NM-I-DV-0196-1')).path, /Mini Dv - 196\.avi$/);
  assert.equal(idx.find(raw('NM-F-DV-0196-E')).length, 0, 'informal file is not the formal recording');

  assert.match(idx.find({ kind: 'episode', series: 'DD Vitraag', episodeNo: '2350' })[0].path, /DD Vitraag-2350\.mp4$/);
  assert.equal(idx.find({ kind: 'episode', series: 'DD Vitraag', episodeNo: '235' }).length, 0);
  assert.match(idx.find({ kind: 'episode', series: 'Aptavani-14-B2', episodeNo: '14' })[0].path, /B2 - 014\.mp4$/);
});

test('series in Raw Video Ids and requests', () => {
  const { parseRawId, seriesHints } = require('../electron/catalog');
  assert.deepEqual(parseRawId('NM, DD-F-DV-0010-E'), { authors: ['NM', 'DD'], author: 'NM', type: 'F', format: 'DV', era: 'DV', number: '10', session: 'E' });
  assert.equal(parseRawId('DD-I-4K-2615-2').era, 'HD');
  assert.deepEqual(seriesHints('NM mini dv 196'), { author: 'NM', type: 'I', era: 'DV' });
});

test('LTO tapes are never read until you say the drive is ready', async () => {
  const disk = tmp(), tape = tmp();
  fs.mkdirSync(path.join(disk, 'Pujyashree Deepakbhai', 'Formal', 'HD, 4K', '3017 to 3050', '3034 Dt-15 Sep 2026'), { recursive: true });
  fs.mkdirSync(path.join(tape, 'Niruma', 'Formal', 'DVCAM', 'NM MASTER - 0418 to 0438', 'NM-0418'), { recursive: true });
  let saved = {};
  const store = { load: () => JSON.parse(JSON.stringify(saved)), save: (t) => { saved = JSON.parse(JSON.stringify(t)); } };
  const cfg = { scanDrives: false, extraRoots: [disk, tape], tapeRoots: [tape], tapeLabels: { [path.resolve(tape)]: 'NM-NA-VAT-MD1-LTO-002' } };
  const idx = new DriveIndex({ getConfig: () => cfg, store });
  const { parseRawId } = require('../electron/catalog');
  const nm418 = { kind: 'raw', ser: parseRawId('NM-F-DV-0418-E2'), folder: '418', iso: '2003-02-16' };

  await idx.scan();
  assert.equal(idx.status().drives.find((d) => d.tape).status, 'tape-waiting');
  assert.equal(idx.find(nm418).length, 0, 'the tape was not read');
  assert.equal(idx.find({ kind: 'raw', ser: parseRawId('DD-F-4K-3034-E'), folder: '3034', iso: '2026-09-15' }).length, 1, 'disks are scanned');

  await idx.scanTape(path.resolve(tape));
  const hit = idx.find(nm418)[0];
  assert.equal(hit.tape, 'NM-NA-VAT-MD1-LTO-002');
  assert.equal(hit.offline, false);
  assert.ok(saved['NM-NA-VAT-MD1-LTO-002'], 'what the tape holds is remembered');

  // Next day: the tape is not in the drive, but the app still knows where folder 418 is.
  const later = new DriveIndex({ getConfig: () => ({ scanDrives: false, extraRoots: [disk] }), store });
  await later.scan();
  const away = later.find(nm418)[0];
  assert.equal(away.offline, true);
  assert.equal(away.tape, 'NM-NA-VAT-MD1-LTO-002');
});

test('a held copy does not touch its source until released', async () => {
  const q = new CopyQueue();
  const job = await q.addJob({ sources: [path.join(tmp(), 'not-there-yet')], dest: tmp(), held: 'Waiting for tape X' });
  assert.equal(job.status, 'held');
  assert.equal(job.files.length, 0);
  assert.ok(job.needsScan);
});

test('bank, bill and promo messages are not data requests', () => {
  for (const t of [
    'Dear Customer, Premium under your policy was due on 01-Oct-2026. Please note the grace period',
    'Payment for your ICICI Bank card XXXX-4002 is due on October 30, 2026. Bill amount: ₹304.00',
    'Return request for your product has been accepted. Initially delivered item',
    '*Talk as long as you want for free* Stay close with voice and video calls',
    'Satsang saras hato',
    // Polite instructions about recording are not requests for archive data.
    'Darshan will continue at the beginning of Satsang in the afternoon.  Please plan the video setup accordingly.',
    'Kindly check the audio mixer before satsang',
  ]) assert.ok(!heuristic(t).isRequest, t);
  for (const t of [
    'Prachar mate Raw joie Chhe DD-F-HD-1062-M  CC Udaybhai',
    '‪Please send the Gurupurnima satsang video‬',
    'Vitraag episode 2350 mokalo',
  ]) assert.ok(heuristic(t).isRequest, t);
});

// ---------------------------------------------------------------- requests listing several recordings
const { requestItems } = require('../electron/extract');

const ALPA = `Jsca,
પાયલબેન સાથે વાત થયા પ્રમાણે અમને નીચેના બે સત્સંગના original parts જોઈએ છે.

1) Recent Satsang - Night Satsang 20 August 2026 _ Gujarati _ Pujyashree Deepakbhai - Bipinbhai Gutka - 35:00 to
39:00
2) General - Part 098 - Sevarthi Shibir Udaipur 2012 - DD - Sevarthi Episode -
098

આ parts તમે \\dbffs24\Share01 આ path પર મૂકી દેશો ?`;

test('a numbered list is split into its items, wrapped lines kept', () => {
  assert.deepStrictEqual(requestItems(ALPA), [
    'Recent Satsang - Night Satsang 20 August 2026 _ Gujarati _ Pujyashree Deepakbhai - Bipinbhai Gutka - 35:00 to 39:00',
    'General - Part 098 - Sevarthi Shibir Udaipur 2012 - DD - Sevarthi Episode - 098',
  ]);
  assert.deepStrictEqual(requestItems('need folder 3046\nfrom hdd 12'), ['need folder 3046\nfrom hdd 12']);
  assert.deepStrictEqual(requestItems('• DD Vitraag 2350\n• master 418'), ['DD Vitraag 2350', 'master 418']);
});

test('Gujarati script asking words make a request', () => {
  assert.ok(heuristic(ALPA).isRequest);
  assert.ok(heuristic('અમને આ સત્સંગ મોકલજો').isRequest);
  assert.ok(!heuristic('સત્સંગ સરસ હતો').isRequest);
});
