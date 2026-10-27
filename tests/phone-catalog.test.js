const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { build, OUT } = require('./phone-fixture');
const { Remote } = require('../electron/remote');

test('the Android search fixture matches the PC search (run node tests/phone-fixture.js if not)', () => {
  const { ndjson, expected } = build();
  assert.equal(fs.readFileSync(path.join(OUT, 'catalog-fixture.ndjson'), 'utf8'), ndjson);
  assert.equal(fs.readFileSync(path.join(OUT, 'catalog-expected.json'), 'utf8'), expected);
});

test('paired phones download the catalogue, gzipped, one row per line', async (t) => {
  const { catalog } = build();
  const api = { state: () => ({ version: '0', queue: { jobs: [] }, requests: [], status: {}, templates: {}, catalog: catalog.stats() }), phoneCatalog: () => catalog.phoneExport() };
  let saved = [];
  const r = new Remote({ api, store: { load: () => saved, save: (d) => { saved = d; } }, encrypt: (s) => s, decrypt: (s) => s });
  await r.start(0, '127.0.0.1');
  t.after(() => r.stop());
  const base = `http://127.0.0.1:${r.port}`;
  assert.equal((await fetch(`${base}/api/catalog`)).status, 401, 'not without pairing');
  const { code } = r.startPairing();
  const { token } = await (await fetch(`${base}/pair`, { method: 'POST', body: JSON.stringify({ code }) })).json();

  const raw = await new Promise((resolve, reject) => require('http').get(`${base}/api/catalog`, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } }, (res) => {
    const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(parts) }));
  }).on('error', reject));
  assert.equal(raw.res.headers['content-encoding'], 'gzip');
  assert.equal(raw.res.headers['x-catalog-version'], String(catalog.importedAt));
  const lines = zlib.gunzipSync(raw.body).toString('utf8').trim().split('\n');
  const head = JSON.parse(lines[0]);
  assert.equal(head.rows, 21);
  assert.equal(lines.length, 22);
  assert.deepEqual(head.sheets.map((s) => s.kind), ['raw', 'episode']);
  const row = JSON.parse(lines.find((l) => l.includes('"DD-F-4K-3046-E"') && l.includes('"raw":"DD-F-4K-3046-E"')));
  assert.deepEqual(row.loc, ['', '', '', ''], 'empty backup columns travel too');
  assert.equal(r.state().catalogVersion, catalog.importedAt, 'the phone learns about new imports from the state');
});
