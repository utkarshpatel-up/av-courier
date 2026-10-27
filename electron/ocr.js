// Reads the text in a picture (screenshot, photo of a monitor, poster) on this computer:
// Tesseract, offline and free, in English, Gujarati and Hindi. It reads letters only; the
// pattern reader in extract.js then finds folder numbers, IDs, dates and keywords in them.
const fs = require('fs');
const path = require('path');

const LANGS = ['eng', 'guj', 'hin'];

class Ocr {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'ocr');
    this.worker = null;
    this.idleTimer = null;
  }

  // The language files ship inside the app; Tesseract wants them in one plain folder.
  _langFiles() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const l of LANGS) {
      const dest = path.join(this.dir, `${l}.traineddata.gz`);
      if (fs.existsSync(dest)) continue;
      const src = path.join(path.dirname(require.resolve(`@tesseract.js-data/${l}/package.json`)), '4.0.0_best_int', `${l}.traineddata.gz`);
      fs.writeFileSync(dest, fs.readFileSync(src));
    }
  }

  async _worker() {
    if (this.worker) return this.worker;
    this._langFiles();
    const { createWorker } = require('tesseract.js');
    this.worker = createWorker(LANGS.join('+'), 1, { langPath: this.dir, cachePath: this.dir, gzip: true, logger: () => {} });
    try { return await this.worker; } catch (e) { this.worker = null; throw e; }
  }

  /** Text of one picture: a data URL, a file path or a Buffer. '' when nothing readable. */
  async read(image) {
    clearTimeout(this.idleTimer);
    const w = await this._worker();
    let input = image;
    if (typeof image === 'string' && image.startsWith('data:')) input = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    const { data } = await w.recognize(input);
    // Free the memory (about 100 MB) when no pictures have come for a while.
    this.idleTimer = setTimeout(() => this.close(), 5 * 60000);
    return clean(data.text);
  }

  async close() {
    clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => {});
  }
}

// Tesseract's line noise: lone symbols and blank runs.
function clean(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.replace(/[^\p{L}\p{N}]/gu, '').length >= 2).join('\n');
}

module.exports = { Ocr, clean };
