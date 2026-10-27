const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ocr, clean } = require('../electron/ocr');
const { heuristic } = require('../electron/extract');

test('clean drops symbol-only lines and squeezes spaces', () => {
  assert.strictEqual(clean('  Folder   3046 \n | \n—\nHDD 123\n'), 'Folder 3046\nHDD 123');
});

test('reads a request out of a picture, offline', { timeout: 120000 }, async () => {
  const ocr = new Ocr(fs.mkdtempSync(path.join(os.tmpdir(), 'avc-ocr-')));
  try {
    const text = await ocr.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'ocr-sample.png')));
    assert.match(text, /folder 3046/i);
    assert.match(text, /HDD 123/i);
    const a = heuristic(text);
    assert.ok(a.isRequest, `not a request: ${text}`);
    assert.ok(a.numbers.includes('123') || a.ids.some((i) => /123/.test(i)), JSON.stringify(a));
  } finally { await ocr.close(); }
});
