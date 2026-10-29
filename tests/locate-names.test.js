const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nameMatcher, datesIn, searchNames } = require('../electron/locate');

test('dates are read from file names in the ways people write them', () => {
  assert.deepStrictEqual([...datesIn('3018 Adalaj Soneri Satsang E. Dt-20-Aug-26 Dur-1h0m')], ['2026-08-20']);
  assert.deepStrictEqual([...datesIn('3018 Dt-20 August 2026')], ['2026-08-20']);
  assert.deepStrictEqual([...datesIn('3018 2026-08-20 export')], ['2026-08-20']);
  assert.deepStrictEqual([...datesIn('3018 20.08.26')], ['2026-08-20']);
  assert.deepStrictEqual([...datesIn('3018 Adalaj')], []);
});

test('a recording is found by its folder number and date; another day or number is not', () => {
  const m = nameMatcher({ folder: '3018', iso: '2026-08-20' });
  assert.deepStrictEqual(m('3018 Adalaj Soneri Satsang with SMHT MHTs E. Dt-20-Aug-26 Dur-1h0m-Bipinbhai Question'), { exact: true });
  assert.strictEqual(m('3018 Dt-21-Aug-26'), null);
  assert.strictEqual(m('30180 Dt-20-Aug-26'), null);
  assert.strictEqual(m('Adalaj 3018 Dt-20-Aug-26'), null);
  assert.deepStrictEqual(m('03018 Adalaj'), { exact: false }); // no date in the name: shown, to be checked
  assert.strictEqual(nameMatcher({ title: 'no number' }), null);
});

test('an episode is found by its series and number', () => {
  const m = nameMatcher({ kind: 'episode', series: 'DD Sevarthi Satsang', episodeNo: '98' });
  assert.ok(m('Sevarthi Satsang - 098'));
  assert.strictEqual(m('Sevarthi Satsang - 0980'), null);
  assert.strictEqual(m('Vitraag - 098'), null);
});

test('every copy on every disk is listed, and a matching folder is not searched inside', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-names-'));
  const a = path.join(tmp, 'NAS', 'Editing', 'Utkarsh'), b = path.join(tmp, 'USB', '3018 Dt-20-Aug-26');
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, '3018 Adalaj Soneri Satsang E. Dt-20-Aug-26.mp4'), 'x'.repeat(10));
  fs.writeFileSync(path.join(a, '3018 notes.txt'), 'not a video');
  fs.writeFileSync(path.join(b, '3018 Dt-20-Aug-26 cam2.mp4'), 'inside the folder');
  const { hits, timedOut } = await searchNames([path.join(tmp, 'NAS'), path.join(tmp, 'USB')], [{ key: 'i', test: nameMatcher({ folder: '3018', iso: '2026-08-20' }) }]);
  assert.strictEqual(timedOut, false);
  assert.deepStrictEqual(hits.i.map((h) => [path.basename(h.path), h.isFile, h.size]), [
    ['3018 Adalaj Soneri Satsang E. Dt-20-Aug-26.mp4', true, 10],
    ['3018 Dt-20-Aug-26', false, 0],
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hard drives are searched by default; a NAS only when chosen, alone or with everything', () => {
  const { DriveIndex } = require('../electron/locate');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-roots-'));
  const [hdd, nas, tape] = ['HDD', 'NAS', 'TAPE'].map((n) => { const p = path.join(tmp, n); fs.mkdirSync(p); return p; });
  const d = new DriveIndex();
  d.drives.set(hdd, { root: hdd, status: 'disk' });
  d.drives.set(nas, { root: nas, status: 'disk', network: true });
  d.drives.set(tape, { root: tape, status: 'tape-waiting', tape: true });
  assert.deepStrictEqual(d.diskRoots(), [hdd]);
  assert.deepStrictEqual(d.diskRoots(nas), [nas]);
  assert.deepStrictEqual(d.diskRoots('all'), [hdd, nas]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
