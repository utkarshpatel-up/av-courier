// TeraCopy-style queue: one job at a time, one file at a time, hashed while
// copying and verified by re-reading the destination. Jobs and their file lists
// can change while the queue runs; state survives a restart.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PART = '.avcourier-part';
const uid = () => crypto.randomBytes(6).toString('hex');

async function walk(src, base, out) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    for (const name of (await fsp.readdir(src)).sort()) {
      if (name === 'System Volume Information' || name === '$RECYCLE.BIN' || name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db') continue;
      await walk(path.join(src, name), base, out);
    }
  } else if (st.isFile()) {
    out.push({ src, rel: path.relative(base, src), size: st.size, mtimeMs: st.mtimeMs, status: 'pending' });
  }
  return out;
}

// Each source keeps its own name at the destination: copying D:\Event\ to E:\Out
// gives E:\Out\Event\..., like Explorer and TeraCopy.
async function scanSources(sources) {
  const files = [];
  for (const s of sources) await walk(s, path.dirname(path.resolve(s)), files);
  return files;
}

async function uniqueName(p) {
  const { dir, name, ext } = path.parse(p);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${name} (${n})${ext}`);
    try { await fsp.access(candidate); } catch { return candidate; }
  }
}

async function hashFile(p, algo, chunk, shouldStop) {
  const h = crypto.createHash(algo);
  const fh = await fsp.open(p, 'r');
  const buf = Buffer.allocUnsafe(chunk);
  try {
    for (;;) {
      if (shouldStop && shouldStop()) throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
      const { bytesRead } = await fh.read(buf, 0, chunk, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally { await fh.close(); }
  return h.digest('hex');
}

class CopyQueue extends EventEmitter {
  constructor({ statePath, settings = () => ({}) } = {}) {
    super();
    this.statePath = statePath;
    this.settings = settings;
    this.jobs = [];
    this.paused = false;
    this.running = false;
    this.current = null; // { jobId, fileIndex, phase, fileDone, speed }
    this._skip = false;
    this._cancelJob = null;
    this._waiters = [];
    this._load();
  }

  _load() {
    if (!this.statePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.jobs = (saved.jobs || []).map((j) => {
        if (j.status === 'running') j.status = 'queued';
        for (const f of j.files) if (f.status === 'copying' || f.status === 'verifying') f.status = 'pending';
        return j;
      });
      this.paused = !!saved.paused;
    } catch { /* first run */ }
  }

  _save() {
    if (!this.statePath) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const tmp = this.statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ jobs: this.jobs, paused: this.paused }));
      fs.renameSync(tmp, this.statePath);
    }, 300);
  }

  _changed(now = false) {
    this._save();
    const t = Date.now();
    if (now || !this._lastEmit || t - this._lastEmit > 250) {
      this._lastEmit = t;
      this.emit('update', this.snapshot());
    }
  }

  snapshot() {
    return {
      paused: this.paused,
      running: this.running,
      current: this.current,
      jobs: this.jobs.map((j) => ({ ...j, ...this._totals(j) })),
    };
  }

  _totals(j) {
    let bytesTotal = 0, bytesDone = 0, count = 0, done = 0, failed = 0, skipped = 0;
    for (const f of j.files) {
      if (f.status === 'removed') continue;
      count++; bytesTotal += f.size;
      if (f.status === 'done') { done++; bytesDone += f.size; }
      else if (f.status === 'failed') failed++;
      else if (f.status === 'skipped') { skipped++; bytesDone += f.size; }
    }
    if (this.current && this.current.jobId === j.id) bytesDone += this.current.fileDone || 0;
    return { bytesTotal, bytesDone, count, done, failed, skipped };
  }

  get(id) { return this.jobs.find((j) => j.id === id); }

  // held: start on hold with a reason (e.g. waiting for a tape to be ready); you release it.
  async addJob({ sources, dest, name, notify = [], requestId = null, itemId = null, message = '', options = {}, held = '' }) {
    if (!sources?.length) throw new Error('Add at least one file or folder');
    if (!dest) throw new Error('Choose a destination folder');
    // A held job (tape not ready) lists its files only when released: listing reads the source.
    const files = held ? [] : await scanSources(sources);
    const s = this.settings();
    const job = {
      id: uid(),
      name: name || (sources.length === 1 ? path.basename(sources[0]) : `${path.basename(sources[0])} + ${sources.length - 1} more`),
      sources, dest, files, notify, requestId, itemId, message,
      options: { verify: s.verify ?? true, conflict: s.conflict || 'skip-same', ...options },
      status: held ? 'held' : 'queued', holdReason: held || '', needsScan: !!held, createdAt: Date.now(), startedAt: null, finishedAt: null, log: [],
    };
    this.jobs.push(job);
    this._changed(true);
    this._kick();
    return job;
  }

  async addFiles(jobId, sources) {
    const job = this.get(jobId);
    if (!job) throw new Error('Job not found');
    if (job.needsScan) { // still waiting for its tape: list these files later too
      job.sources.push(...sources.filter((x) => !job.sources.includes(x)));
      this._changed(true);
      return job;
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) job.status = 'queued';
    const files = await scanSources(sources);
    const known = new Set(job.files.filter((f) => f.status !== 'removed').map((f) => f.src));
    job.files.push(...files.filter((f) => !known.has(f.src)));
    job.sources.push(...sources.filter((s) => !job.sources.includes(s)));
    this._changed(true);
    this._kick();
    return job;
  }

  removeFile(jobId, index) {
    const job = this.get(jobId);
    const f = job?.files[index];
    if (!f) return;
    if (this.current && this.current.jobId === jobId && this.current.fileIndex === index) { f.removeRequested = true; this._skip = true; this._wake(); }
    else if (f.status === 'pending' || f.status === 'failed' || f.status === 'skipped') f.status = 'removed';
    this._changed(true);
  }

  removeJob(jobId) {
    const job = this.get(jobId);
    if (!job) return;
    if (job.status === 'running') { this._cancelJob = jobId; job.removeAfterCancel = true; this._wake(); return; }
    this.jobs = this.jobs.filter((j) => j.id !== jobId);
    this._changed(true);
  }

  cancelJob(jobId) {
    const job = this.get(jobId);
    if (!job) return;
    if (job.status === 'running') { this._cancelJob = jobId; this._wake(); }
    else if (job.status === 'queued' || job.status === 'held') { job.status = 'cancelled'; this._changed(true); }
  }

  retryFailed(jobId) {
    const job = this.get(jobId);
    if (!job) return;
    for (const f of job.files) if (f.status === 'failed') { f.status = 'pending'; delete f.error; }
    job.status = 'queued'; job.finishedAt = null; job.notified = false;
    this._changed(true);
    this._kick();
  }

  hold(jobId, on) {
    const job = this.get(jobId);
    if (!job || job.status === 'running') return;
    if (on && job.status === 'queued') job.status = 'held';
    if (!on && job.status === 'held') { job.status = 'queued'; job.holdReason = ''; }
    this._changed(true);
    this._kick();
  }

  move(jobId, delta) {
    const i = this.jobs.findIndex((j) => j.id === jobId);
    const k = i + delta;
    if (i < 0 || k < 0 || k >= this.jobs.length) return;
    [this.jobs[i], this.jobs[k]] = [this.jobs[k], this.jobs[i]];
    this._changed(true);
  }

  update(jobId, patch) {
    const job = this.get(jobId);
    if (!job) return;
    for (const key of ['name', 'notify', 'message', 'requestId']) if (key in patch) job[key] = patch[key];
    this._changed(true);
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => !['done', 'cancelled'].includes(j.status));
    this._changed(true);
  }

  pause() { this.paused = true; this._changed(true); }
  resume() { this.paused = false; this._wake(); this._changed(true); this._kick(); }
  skipCurrent() { this._skip = true; this._wake(); }

  _wake() { const w = this._waiters; this._waiters = []; w.forEach((r) => r()); }
  async _gate() { while (this.paused && !this._skip && !this._cancelJob) await new Promise((r) => this._waiters.push(r)); }

  _kick() { if (!this.running) this._run().catch((e) => this.emit('error', e)); }

  async _run() {
    this.running = true;
    try {
      for (;;) {
        await this._gate();
        const job = this.jobs.find((j) => j.status === 'queued');
        if (!job) break;
        await this._runJob(job);
      }
    } finally {
      this.running = false;
      this.current = null;
      this._changed(true);
      this.emit('idle');
    }
  }

  async _runJob(job) {
    job.status = 'running';
    job.startedAt = job.startedAt || Date.now();
    this._changed(true);
    if (job.needsScan) {
      try { job.files = await scanSources(job.sources); job.needsScan = false; this._changed(true); }
      catch (e) { return this._finish(job, 'failed', `Could not read the source: ${e.message}`); }
    }
    try { await fsp.mkdir(job.dest, { recursive: true }); } catch (e) { return this._finish(job, 'failed', `Destination unavailable: ${e.message}`); }

    // Free space check covers what is still to be copied.
    try {
      const need = job.files.filter((f) => f.status === 'pending').reduce((a, f) => a + f.size, 0);
      const st = await fsp.statfs(job.dest);
      const free = Number(st.bavail) * Number(st.bsize);
      if (need > free) return this._finish(job, 'failed', `Not enough space: needs ${fmtBytes(need)}, ${fmtBytes(free)} free`);
    } catch { /* statfs unsupported on some network shares */ }

    // Index loop, re-reading the array: files added while running are picked up.
    for (let i = 0; i < job.files.length; i++) {
      await this._gate();
      if (this._cancelJob === job.id) break;
      const f = job.files[i];
      if (f.status !== 'pending') continue;
      await this._copyOne(job, f, i);
      if (this._cancelJob === job.id) break;
    }

    if (this._cancelJob === job.id) {
      this._cancelJob = null;
      if (job.removeAfterCancel) { this.jobs = this.jobs.filter((j) => j !== job); this._changed(true); return; }
      return this._finish(job, 'cancelled');
    }
    const t = this._totals(job);
    this._finish(job, t.failed ? 'failed' : 'done');
  }

  _finish(job, status, error) {
    job.status = status;
    job.finishedAt = Date.now();
    if (error) job.error = error;
    this.current = null;
    this._changed(true);
    this.emit('job-finished', { ...job, ...this._totals(job) });
  }

  async _copyOne(job, f, index) {
    const s = this.settings();
    const chunk = Math.max(1, s.bufferMB || 4) * 1024 * 1024;
    let target = path.join(job.dest, f.rel);
    this._skip = false;
    this.current = { jobId: job.id, fileIndex: index, file: f.rel, size: f.size, fileDone: 0, phase: 'copying', speed: 0 };
    f.status = 'copying';
    this._changed(true);
    const stop = () => this._skip || this._cancelJob === job.id;

    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const existing = await fsp.stat(target).catch(() => null);
      if (existing) {
        const policy = job.options.conflict;
        const same = existing.size === f.size && Math.abs(existing.mtimeMs - f.mtimeMs) < 2000;
        if (policy === 'skip' || (policy === 'skip-same' && same)) {
          f.status = 'skipped'; f.note = 'already at destination'; return;
        }
        if (policy === 'rename' || (policy === 'skip-same' && !same)) target = await uniqueName(target);
      }
      f.target = target;

      const part = target + PART;
      const hash = crypto.createHash(job.options.verify ? (s.hash || 'md5') : 'md5');
      const src = await fsp.open(f.src, 'r');
      const out = await fsp.open(part, 'w');
      const buf = Buffer.allocUnsafe(chunk);
      let windowStart = Date.now(), windowBytes = 0;
      try {
        for (;;) {
          await this._gate();
          if (stop()) throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
          const { bytesRead } = await src.read(buf, 0, chunk, null);
          if (!bytesRead) break;
          const slice = buf.subarray(0, bytesRead);
          hash.update(slice);
          await out.write(slice);
          this.current.fileDone += bytesRead;
          windowBytes += bytesRead;
          const dt = Date.now() - windowStart;
          if (dt > 1000) { this.current.speed = windowBytes / (dt / 1000); windowStart = Date.now(); windowBytes = 0; }
          this._changed();
        }
        await out.sync();
      } finally { await src.close(); await out.close(); }

      await fsp.rename(part, target);
      await fsp.utimes(target, new Date(), new Date(f.mtimeMs)).catch(() => {});
      f.hash = hash.digest('hex');

      if (job.options.verify) {
        this.current.phase = 'verifying';
        f.status = 'verifying';
        this._changed(true);
        const check = await hashFile(target, s.hash || 'md5', chunk, stop);
        if (check !== f.hash) throw new Error('Verification failed: destination differs from source');
        f.verified = true;
      }
      f.status = 'done';
    } catch (e) {
      await fsp.unlink(target + PART).catch(() => {});
      if (e.code === 'STOPPED') {
        if (this._cancelJob === job.id) f.status = 'pending';
        else if (f.removeRequested) f.status = 'removed';
        else { f.status = 'skipped'; f.note = 'skipped by you'; }
      } else {
        f.status = 'failed';
        f.error = e.message;
      }
    } finally {
      this._skip = false;
      this.current && (this.current.fileDone = 0);
      this._changed(true);
    }
  }
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

module.exports = { CopyQueue, scanSources, hashFile, fmtBytes };
