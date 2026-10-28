const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const call = (m, ...a) => window.api.call(m, ...a);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');

function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function dur(s) {
  if (!isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now'; if (m < 60) return `${m}m`; if (m < 1440) return `${Math.round(m / 60)}h`;
  return new Date(t).toLocaleDateString();
}
function toast(text, bad) {
  const d = document.createElement('div');
  d.textContent = text; if (bad) d.className = 'bad';
  $('#toast').append(d); setTimeout(() => d.remove(), bad ? 7000 : 3500);
}
async function run(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText); return r; }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method 'call': (Error: )?/, ''), true); }
}

let S = null;
let page = localStorage.getItem('page') || 'queue';
let openJobs = new Set();
let reqFilter = 'open';
let selReq = null;
const reqTabs = {}; // request id -> 'checklist' | 'matches', the tab last chosen on it
const ticked = new Set(); // requests ticked for "Not a request"

// ---------------------------------------------------------------- navigation
function go(p) {
  page = p; localStorage.setItem('page', p);
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  $$('.page').forEach((s) => s.classList.toggle('active', s.id === `page-${p}`));
  render();
}
$$('.nav').forEach((b) => b.onclick = () => go(b.dataset.page));

// ---------------------------------------------------------------- queue
const STATUS = {
  queued: ['Queued', ''], held: ['On hold', 'warn'], running: ['Copying', 'info'], done: ['Done', 'ok'],
  failed: ['Errors', 'bad'], cancelled: ['Cancelled', ''],
};
const FSTATUS = { pending: '', copying: 'info', verifying: 'info', done: 'ok', skipped: 'warn', failed: 'bad', removed: '' };

function renderQueue() {
  const q = S.queue;
  $('#q-pause').textContent = q.paused ? 'Resume' : 'Pause';
  $('#q-pause').classList.toggle('primary', q.paused);
  const run = q.jobs.find((j) => j.status === 'running');
  const now = $('#q-now');
  if (run && q.current) {
    const c = q.current;
    const filePct = c.size ? (c.fileDone / c.size) * 100 : 100;
    const totPct = run.bytesTotal ? (run.bytesDone / run.bytesTotal) * 100 : 0;
    const eta = c.speed ? (run.bytesTotal - run.bytesDone) / c.speed : NaN;
    now.style.display = '';
    now.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="file">${c.phase === 'verifying' ? 'Verifying' : 'Copying'}: ${esc(c.file)}</div>
        <div class="row"><button class="btn sm" data-a="skip">Skip file</button></div>
      </div>
      <div class="bar thin ${q.paused ? 'paused' : ''}"><div style="width:${c.phase === 'verifying' ? 100 : filePct}%"></div></div>
      <div class="small">${run.name ? esc(run.name) : ''} — ${run.done + run.skipped} of ${run.count} files</div>
      <div class="bar ${q.paused ? 'paused' : ''}"><div style="width:${totPct}%"></div></div>
      <div class="stats"><span>${totPct.toFixed(1)}%</span><span>${bytes(run.bytesDone)} of ${bytes(run.bytesTotal)}</span>
        <span>${c.speed ? bytes(c.speed) + '/s' : ''}</span><span>${q.paused ? 'Paused' : 'Remaining ' + dur(eta)}</span>
        <span>→ ${esc(run.dest)}</span></div>`;
  } else {
    now.style.display = q.jobs.length ? 'none' : '';
    now.innerHTML = `<div class="empty">Nothing copying. Drop files here, use <b>+ New copy</b>, or right-click in Explorer → Send to → AV Courier.</div>`;
  }

  $('#q-jobs').innerHTML = q.jobs.map((j, idx) => {
    const [label, cls] = STATUS[j.status] || [j.status, ''];
    const pct = j.bytesTotal ? (j.bytesDone / j.bytesTotal) * 100 : 0;
    const who = (j.notify || []).map((n) => `<span class="chip">${n.channel === 'whatsapp' ? 'WA' : '✉'} ${esc(n.name)}</span>`).join('');
    const told = (j.notified || []).map((n) => `<span class="badge ${n.ok ? 'ok' : 'bad'}" title="${esc(n.error || '')}">${n.ok ? 'told' : 'not told'} ${esc(n.to)}</span>`).join(' ');
    const open = openJobs.has(j.id);
    return `<div class="job ${j.status}" data-id="${j.id}">
      <div class="job-head" data-a="toggle">
        <div class="row"><span class="name">${esc(j.name)}</span><span class="badge ${cls}">${label}</span>${j.autoSend === false && j.notify?.length ? '<span class="badge">manual notify</span>' : ''}</div>
        <div class="acts">
          ${idx > 0 ? '<button class="btn sm ghost" data-a="up" title="Move up">▲</button>' : ''}
          ${idx < q.jobs.length - 1 ? '<button class="btn sm ghost" data-a="down" title="Move down">▼</button>' : ''}
          <button class="btn sm" data-a="add" title="Add files to this job">+ Files</button>
          ${j.status === 'queued' ? '<button class="btn sm" data-a="hold">Hold</button>' : ''}
          ${j.status === 'held' ? `<button class="btn sm ${j.holdReason ? 'primary' : ''}" data-a="unhold" title="${esc(j.holdReason || '')}">${j.holdReason ? 'Tape ready — start' : 'Release'}</button>` : ''}
          ${j.status === 'running' ? '<button class="btn sm danger" data-a="cancel">Cancel</button>' : ''}
          ${j.failed ? '<button class="btn sm" data-a="retry">Retry failed</button>' : ''}
          ${['done', 'failed'].includes(j.status) && j.notify?.length ? '<button class="btn sm" data-a="notify">Notify now</button>' : ''}
          ${j.report ? '<button class="btn sm ghost" data-a="report">Report</button>' : ''}
          <button class="btn sm ghost" data-a="dest" title="Open destination">📂</button>
          <button class="btn sm ghost danger" data-a="remove" title="Remove from queue">✕</button>
        </div>
        <div class="small">${j.needsScan ? `${j.sources.length} item(s), files listed when the tape is ready` : `${j.count} files · ${bytes(j.bytesTotal)}`} → ${esc(j.dest)}${j.holdReason ? ` · <span style="color:var(--warn)">⏸ ${esc(j.holdReason)}</span>` : ''}${j.error ? ` · <span style="color:var(--bad)">${esc(j.error)}</span>` : ''}${j.failed ? ` · ${j.failed} failed` : ''}${j.skipped ? ` · ${j.skipped} skipped` : ''}</div>
        <div><div class="bar thin ${j.status === 'done' ? 'ok' : ''}"><div style="width:${pct}%"></div></div><div class="chips">${who} ${told}</div></div>
      </div>
      ${open ? `<div class="files"><table>${j.files.map((f, i) => `<tr class="${f.status}">
        <td class="st"><span class="badge ${FSTATUS[f.status] || ''}">${f.status}</span></td>
        <td title="${esc(f.src)}">${esc(f.rel)}</td><td>${bytes(f.size)}</td>
        <td class="small">${esc(f.error || f.note || (f.verified ? 'verified' : ''))}</td>
        <td>${['pending', 'failed', 'skipped', 'copying', 'verifying'].includes(f.status) ? `<button class="btn sm ghost" data-a="rmfile" data-i="${i}" title="Remove from this job">✕</button>` : ''}</td></tr>`).join('')}</table></div>` : ''}
    </div>`;
  }).join('');
  const waiting = q.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length;
  $('#nav-queue').textContent = waiting || '';
}

$('#q-now').onclick = (e) => { if (e.target.dataset.a === 'skip') call('skip'); };
$('#q-jobs').onclick = async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  const id = e.target.closest('.job')?.dataset.id;
  if (!a || !id) return;
  const j = S.queue.jobs.find((x) => x.id === id);
  if (a === 'toggle') { openJobs.has(id) ? openJobs.delete(id) : openJobs.add(id); return renderQueue(); }
  e.stopPropagation();
  if (a === 'up') call('moveJob', id, -1);
  if (a === 'down') call('moveJob', id, 1);
  if (a === 'hold') call('holdJob', id, true);
  if (a === 'unhold' && (!j.holdReason || confirm(`${j.holdReason}\n\nIs the tape drive light steady now?`))) call('holdJob', id, false);
  if (a === 'cancel' && confirm(`Cancel copying ${j.name}? Files already copied stay.`)) call('cancelJob', id);
  if (a === 'retry') call('retryJob', id);
  if (a === 'remove' && (j.status !== 'running' || confirm(`Stop and remove ${j.name}?`))) call('removeJob', id);
  if (a === 'rmfile') call('removeFile', id, +e.target.dataset.i);
  if (a === 'dest') call('openPath', j.dest);
  if (a === 'report') call('reveal', j.report);
  if (a === 'notify') { const r = await run(() => call('notifyJob', id)); r && toast(r.map((x) => `${x.to}: ${x.ok ? 'sent' : x.error}`).join('\n'), r.some((x) => !x.ok)); }
  if (a === 'add') {
    const kind = await choose('Add to this job', ['Files', 'Folders']);
    if (!kind) return;
    const p = await call('pick', kind === 'Files' ? 'files' : 'folder');
    if (p.length) run(() => call('addFiles', id, p), `Added ${p.length} item(s) to ${j.name}`);
  }
};
$('#q-pause').onclick = () => call(S.queue.paused ? 'resume' : 'pause');
$('#q-clear').onclick = () => call('clearFinished');
$('#q-new').onclick = () => newJob({});

// Drag and drop anywhere on the queue page; onto a job adds to that job.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const paths = files.map((f) => window.api.pathFor(f)).filter(Boolean);
  if (page === 'requests') {
    // A spreadsheet onto an open request adds to it; anywhere else it starts a new request.
    const sheets = paths.filter(isSheetPath);
    if (sheets.length && selReq && e.target.closest('#r-detail')) return run(() => call('attachToRequest', selReq, sheets), 'Spreadsheet read into this request');
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length || sheets.length) return newRequest({ images: await Promise.all(imgs.map(readImage)), files: sheets });
  }
  if (!paths.length) return;
  const onJob = e.target.closest('.job')?.dataset.id;
  if (onJob) return run(() => call('addFiles', onJob, paths), `Added ${paths.length} item(s)`);
  if (page !== 'queue') go('queue');
  newJob({ sources: paths });
});
const isSheetPath = (p) => /\.(xlsx|xlsm|xls|xlsb|csv|ods)$/i.test(p);
const baseName = (p) => String(p).split(/[\\/]/).pop().replace(/^[0-9a-f]{8} /, '');
const readImage = (f) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });

window.api.on('add-files', (paths) => { go('queue'); newJob({ sources: paths }); });

// ---------------------------------------------------------------- dialogs
const dlg = $('#dlg');
function choose(title, options) {
  return new Promise((res) => {
    $('#dlg-body').innerHTML = `<h2>${esc(title)}</h2><div class="dlg-actions">${options.map((o) => `<button class="btn" value="${esc(o)}">${esc(o)}</button>`).join('')}<button class="btn ghost" value="">Cancel</button></div>`;
    dlg.onclose = () => res(dlg.returnValue || null);
    dlg.showModal();
  });
}

function recipientChip(r, i) {
  return `<span class="chip">${r.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}: ${esc(r.name)}${r.address ? ` &lt;${esc(r.address)}&gt;` : ''}<button type="button" data-rm="${i}">✕</button></span>`;
}

// o: { sources, dest, name, notify, requestId, message }
async function newJob(o) {
  const st = { sources: o.sources || [], dest: o.dest || S.settings.recentDest[0] || '', notify: o.notify || [], autoSend: S.settings.notify.autoSend };
  const body = $('#dlg-body');
  const draw = async () => {
    body.innerHTML = `
      <h2>New copy${o.requestId ? ' for a request' : ''}</h2>
      <label>Copy these</label>
      <div class="srclist">${st.sources.map((s, i) => `<div><span>${esc(s)}</span><button type="button" class="btn sm ghost" data-rmsrc="${i}">✕</button></div>`).join('') || '<span class="muted">Nothing yet — add files or folders, or drop them here</span>'}</div>
      <div class="row" style="margin-bottom:12px"><button type="button" class="btn sm" id="j-files">+ Files</button><button type="button" class="btn sm" id="j-folders">+ Folders</button></div>
      <label>To this folder
        <div class="row"><input id="j-dest" list="j-recent" style="flex:1" value="${esc(st.dest)}"><button type="button" class="btn" id="j-browse">Browse</button></div>
        <datalist id="j-recent">${S.settings.recentDest.map((d) => `<option value="${esc(d)}">`).join('')}</datalist>
      </label>
      <label>Job name<input id="j-name" value="${esc(o.name || '')}" placeholder="defaults to the first folder name"></label>
      <label>Tell when finished</label>
      <div class="chips" id="j-who" style="margin-bottom:8px">${st.notify.map(recipientChip).join('') || '<span class="muted small">No one</span>'}</div>
      <div class="row" style="margin-bottom:10px">
        <select id="j-ch"><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select>
        <input id="j-to" list="j-contacts" placeholder="WhatsApp chat name, or email address" style="flex:1">
        <datalist id="j-contacts">${S.settings.contacts.map((c) => `<option value="${esc(c.chat || c.address)}">${esc(c.name)}</option>`).join('')}</datalist>
        <button type="button" class="btn sm" id="j-addwho">Add</button>
      </div>
      <label>Message (blank = the “Copy finished” template)<textarea id="j-msg" rows="3" placeholder="${esc(S.templates.copyDone)}">${esc(o.message || '')}</textarea></label>
      <label class="switch"><input type="checkbox" id="j-auto" ${st.autoSend ? 'checked' : ''}> Send automatically when the copy finishes</label>
      <div class="dlg-actions"><button class="btn ghost" value="">Cancel</button><button type="button" class="btn primary" id="j-go">Add to queue</button></div>`;
    const keep = () => { st.dest = $('#j-dest').value; o.name = $('#j-name').value; o.message = $('#j-msg').value; st.autoSend = $('#j-auto').checked; };
    $('#j-files').onclick = async () => { keep(); st.sources.push(...await call('pick', 'files')); draw(); };
    $('#j-folders').onclick = async () => { keep(); st.sources.push(...await call('pick', 'folder')); draw(); };
    $('#j-browse').onclick = async () => { keep(); const [d] = await call('pick', 'dest'); if (d) st.dest = d; draw(); };
    body.querySelectorAll('[data-rmsrc]').forEach((b) => b.onclick = () => { keep(); st.sources.splice(+b.dataset.rmsrc, 1); draw(); });
    body.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { keep(); st.notify.splice(+b.dataset.rm, 1); draw(); });
    $('#j-addwho').onclick = () => {
      keep();
      const v = $('#j-to').value.trim(); if (!v) return;
      const ch = $('#j-ch').value;
      const known = S.settings.contacts.find((c) => (c.chat || c.address) === v);
      st.notify.push(known || (ch === 'email' ? { channel: 'email', name: v.split('@')[0], address: v } : { channel: 'whatsapp', name: v, chat: v }));
      draw();
    };
    $('#j-go').onclick = async () => {
      keep();
      const id = await run(() => call('addJob', { sources: st.sources, dest: st.dest, name: o.name, notify: st.notify, requestId: o.requestId, message: o.message, autoSend: st.autoSend }));
      if (id) { dlg.close(); toast('Added to the queue'); go('queue'); }
    };
  };
  await draw();
  dlg.onclose = null;
  if (!dlg.open) dlg.showModal();
}

// ---------------------------------------------------------------- requests
const OPEN = ['new', 'attention'], PROGRESS = ['copying', 'ready'], DONE = ['replied', 'delivered', 'closed'];
const RSTATUS = { new: ['New', 'bad'], maybe: ['Maybe', ''], attention: ['Needs attention', 'bad'], copying: ['Copying', 'info'], ready: ['Copied', 'info'], replied: ['Replied', 'ok'], delivered: ['Delivered', 'ok'], closed: ['Closed', ''], dismissed: ['Dismissed', ''] };

function filteredRequests() {
  const r = S.requests;
  if (reqFilter === 'open') return r.filter((x) => OPEN.includes(x.status));
  if (reqFilter === 'maybe') return r.filter((x) => x.status === 'maybe');
  if (reqFilter === 'progress') return r.filter((x) => PROGRESS.includes(x.status));
  if (reqFilter === 'done') return r.filter((x) => DONE.includes(x.status));
  return r;
}

function renderRequests() {
  const counts = { open: S.requests.filter((x) => OPEN.includes(x.status)).length, maybe: S.requests.filter((x) => x.status === 'maybe').length, progress: S.requests.filter((x) => PROGRESS.includes(x.status)).length };
  $('#nav-requests').textContent = counts.open || '';
  $$('#r-tabs button').forEach((b) => { b.classList.toggle('active', b.dataset.f === reqFilter); const n = counts[b.dataset.f]; b.textContent = b.textContent.replace(/ \(\d+\)$/, '') + (n ? ` (${n})` : ''); });
  const list = filteredRequests();
  // Ticked requests (several false alarms at once): only those still listed stay ticked.
  for (const id of [...ticked]) if (!list.some((r) => r.id === id)) ticked.delete(id);
  const untickedShown = list.filter((r) => !ticked.has(r.id) && r.status !== 'dismissed').length;
  $('#r-bulk').style.display = ticked.size ? '' : 'none';
  $('#r-bulk').innerHTML = ticked.size ? `<b>${ticked.size} ticked</b>
    <button class="btn" id="r-dismiss">Not a request</button>
    <button class="btn" id="r-ignore" title="Also ignore everything these senders send from now on">Not a request · ignore sender${ticked.size > 1 ? 's' : ''}</button>
    ${untickedShown ? `<button class="btn ghost" id="r-tickall">Tick all shown (${list.filter((r) => r.status !== 'dismissed').length})</button>` : ''}
    <button class="btn ghost" id="r-untick">Clear</button>` : '';
  $('#r-list').innerHTML = list.map((r) => {
    const [label, cls] = RSTATUS[r.status] || [r.status, ''];
    const old = OPEN.includes(r.status) && Date.now() - r.receivedAt > S.settings.reminders.afterMin * 60000;
    return `<div class="req ${r.id === selReq ? 'sel' : ''} ${old ? 'old' : ''} ${ticked.has(r.id) ? 'ticked' : ''}" data-id="${r.id}">
      <div class="who">${r.status === 'dismissed' ? '' : `<input type="checkbox" class="tick" title="Tick to mark several as not a request" ${ticked.has(r.id) ? 'checked' : ''}>`}<span class="ch ${r.channel}">${r.channel === 'whatsapp' ? 'WA' : r.channel === 'email' ? 'MAIL' : 'ADDED'}</span>${esc(r.from.name)}<span class="t">${ago(r.receivedAt)}</span></div>
      <div class="sum">${esc(r.analysis?.summary || r.text)}</div>
      <div class="row" style="margin-top:6px"><span class="badge ${cls}">${label}</span>${r.matches?.length ? `<span class="badge info">${r.matches.length} match${r.matches.length > 1 ? 'es' : ''}</span>` : '<span class="badge">no match</span>'}${r.images?.length || r.hasMedia ? '<span class="badge">picture</span>' : ''}${r.files?.length ? '<span class="badge">spreadsheet</span>' : ''}</div>
    </div>`;
  }).join('') || '<div class="empty">Nothing here</div>';
  renderRequestDetail();
}

$('#r-tabs').onclick = (e) => { if (e.target.dataset.f) { reqFilter = e.target.dataset.f; renderRequests(); } };
$('#r-list').onclick = (e) => {
  const id = e.target.closest('.req')?.dataset.id;
  if (!id) return;
  if (e.target.classList.contains('tick')) { e.target.checked ? ticked.add(id) : ticked.delete(id); renderRequests(); return; }
  selReq = id; renderRequests();
};
$('#r-bulk').onclick = (e) => {
  if (e.target.id === 'r-untick') { ticked.clear(); renderRequests(); }
  if (e.target.id === 'r-tickall') { for (const r of filteredRequests()) if (r.status !== 'dismissed') ticked.add(r.id); renderRequests(); }
  if (e.target.id === 'r-ignore') run(async () => {
    const ids = [...ticked];
    const names = [...new Set(S.requests.filter((r) => ticked.has(r.id)).map((r) => r.channel === 'email' ? r.from.address || r.from.name : r.from.chat || r.from.name))];
    if (!confirm(`Never treat messages from these as requests?\n\n${names.join('\n')}\n\nUndo in Settings → Never a request.`)) return;
    await call('ignoreSenders', ids);
    await call('dismissRequests', ids);
    ticked.clear();
    await refresh();
    toast(`Ignoring ${names.length} sender${names.length > 1 ? 's' : ''}`);
  });
  if (e.target.id === 'r-dismiss') run(async () => {
    const n = await call('dismissRequests', [...ticked]);
    ticked.clear();
    await refresh();
    toast(`${n} marked as not a request (still under All)`);
  });
};
window.api.on('open-request', (id) => { selReq = id; reqFilter = 'all'; go('requests'); });
window.api.on('go', (p) => go(p));

function matchTable(rows, selectable) {
  if (!rows.length) return '<div class="empty">No catalogue rows match. Try Find Data with other words, or ask for the date / drive number.</div>';
  // Raw recordings and episodes side by side: the first column says which, and of which series.
  rows = rows.map((r) => ({ ...r, what: r.kind === 'episode' ? `Episode · ${r.series} ${r.episodeNo}` : r.seriesLabel, from: r.kind === 'episode' ? r.rawId : '' }));
  const NAMES = { what: 'Series', id: 'Id', from: 'From raw', folder: 'Folder', date: 'Date', place: 'Place', event: 'Event', title: 'Topic', path: 'Path' };
  const has = Object.keys(NAMES).filter((c) => rows.some((r) => r[c]));
  // Every backup column is shown, even when empty: "—" there means not backed up on it yet.
  const locs = [...new Set(rows.flatMap((r) => [...(r.backups || []), ...(r.locations || []).map((l) => l.label)]))];
  const showCells = has.length + locs.length < 3;
  const head = showCells ? rows[0].headers : [...has.map((c) => NAMES[c]), ...locs.map((l) => l.replace(/\s*backup$/i, ''))];
  const cells = (r) => showCells ? r.cells : [...has.map((c) => r[c]), ...locs.map((l) => (r.locations || []).find((x) => x.label === l)?.value || '—')];
  const disk = (r) => {
    const f = r.found || [];
    if (!f.length) return '<span class="muted">—</span>';
    const best = f[0];
    const where = best.offline ? `Tape ${best.tape} · not loaded` : best.tape ? `${best.root.replace(/[\\/]+$/, '')} · tape ${best.tape}` : best.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return `<span class="badge ${best.offline ? 'info' : best.exact ? 'ok' : 'warn'}" title="${esc(f.map((x) => x.path).join('\n'))}">${esc(where)}${best.exact ? '' : ' · check'}${best.isFile ? ' · file' : ''}</span>`;
  };
  const anyDisk = rows.some((r) => r.found);
  return `<div class="reswrap"><table class="res"><thead><tr>${selectable ? '<th></th>' : ''}${anyDisk ? '<th>On disk</th>' : ''}${head.map((h) => `<th>${esc(h)}</th>`).join('')}<th>Why</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr>${selectable ? `<td><input type="checkbox" data-row="${i}" ${i === 0 ? 'checked' : ''}></td>` : ''}${anyDisk ? `<td class="nw">${disk(r)}</td>` : ''}${cells(r).map((c, k) => `<td${!showCells && ['id', 'from', 'folder', 'date'].includes(has[k]) ? ' class="nw"' : ''}>${esc(c)}</td>`).join('')}<td class="score">${esc(r.why.join(' ')) || 'words'}<br>row ${r.row}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function renderRequestDetail() {
  const r = S.requests.find((x) => x.id === selReq);
  const d = $('#r-detail');
  if (!r) { d.innerHTML = '<div class="empty">Select a request</div>'; return; }
  const a = r.analysis || {};
  const [label, cls] = RSTATUS[r.status] || [r.status, ''];
  // Checklist and matches side by side as tabs: the checklist first once there is one.
  const tab = reqTabs[r.id] || (r.checklist?.items.length ? 'checklist' : 'matches');
  const cl = r.checklist;
  const clCount = cl ? (cl.state === 'draft' ? `draft · ${cl.items.length}` : `${cl.items.filter((i) => i.status === 'done').length} of ${cl.items.length} done`) : '';
  d.innerHTML = `
    <div class="title-row"><h2 style="margin:0">${esc(r.from.name)} <span class="ch ${r.channel}">${r.channel}</span></h2><span class="badge ${cls}">${label}</span></div>
    <div class="small">${new Date(r.receivedAt).toLocaleString()}${r.from.address ? ' · ' + esc(r.from.address) : ''}${r.from.chat && r.from.chat !== r.from.name ? ' · chat ' + esc(r.from.chat) : ''}</div>
    <div class="msg">${esc(r.text)}</div>
    ${r.images?.length ? `<div class="thumbs">${r.images.map((p) => `<img src="${fileUrl(p)}" data-open="${esc(p)}">`).join('')}</div>` : ''}
    ${Object.values(r.ocr || {}).some(Boolean) ? `<details class="small" style="margin:4px 0 8px"><summary>Words read from the picture</summary><div class="msg">${esc(Object.values(r.ocr).filter(Boolean).join('\n'))}</div></details>` : ''}
    <div class="chips" style="margin-bottom:8px">${(r.files || []).map((f) => { const s = r.sheets?.[f]; return `<span class="chip sheet" data-open="${esc(f)}" title="Open the spreadsheet">📊 ${esc(baseName(f))}${s ? ` · ${s.error ? 'could not be read' : `${s.rows} row${s.rows === 1 ? '' : 's'}`}` : ''}</span>`; }).join('')}<button class="btn sm ghost" id="rd-sheet" title="Or drop a spreadsheet on this request">+ Spreadsheet</button></div>
    ${Object.values(r.sheets || {}).some((s) => s.text) ? `<details class="small" style="margin:4px 0 8px"><summary>Rows read from the spreadsheet</summary><div class="msg">${esc(Object.values(r.sheets).map((s) => s.text).filter(Boolean).join('\n\n'))}</div></details>` : ''}
    ${r.hasMedia && !r.images?.length ? '<p class="small">This message had a picture. Open the chat in the WhatsApp window and use <b>From open WhatsApp chat</b> to bring it in.</p>' : ''}
    <div class="chips" style="margin-bottom:8px">
      <span class="chip">${a.source === 'claude' ? 'Read by Claude' : 'Read by patterns'}</span>
      ${(a.ids || []).filter((x) => !x.includes(':')).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}
      ${(a.dates || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}
      ${(a.keywords || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}
    </div>
    ${a.summary && a.source === 'claude' ? `<p><b>${esc(a.summary)}</b></p>` : ''}
    <div class="tabs rd-tabs">
      <button data-tab="checklist" class="${tab === 'checklist' ? 'active' : ''}">Checklist${clCount ? ` (${clCount})` : ''}</button>
      <button data-tab="matches" class="${tab === 'matches' ? 'active' : ''}">Matches (${(r.matches || []).length})</button>
    </div>
    <div class="rd-panel" data-panel="checklist" ${tab === 'checklist' ? '' : 'hidden'}>${checklistHtml(r)}</div>
    <div class="rd-panel" data-panel="matches" ${tab === 'matches' ? '' : 'hidden'}>
      <div class="row"><input id="rd-q" placeholder="Search the catalogue for this request" style="flex:1" value="${esc(a.searchText || '')}"><button class="btn sm" id="rd-search">Search</button><button class="btn sm ghost" id="rd-re">Read again</button></div>
      <div id="rd-matches">${matchTable(r.matches || [], true)}</div>
      <div class="row">
        <button class="btn primary" id="rd-locate">Reply with location</button>
        <button class="btn" id="rd-copy">Copy selected…</button>
      </div>
    </div>
    <div class="row">
      <button class="btn" id="rd-notfound">Reply: not found</button>
      <button class="btn" id="rd-reply">Write reply…</button>
      <span style="flex:1"></span>
      ${r.status === 'maybe' ? '<button class="btn" id="rd-isreq">It is a request</button>' : ''}
      <button class="btn ghost" id="rd-close">${OPEN.includes(r.status) || r.status === 'maybe' ? 'Mark done' : 'Reopen'}</button>
      <button class="btn ghost danger" id="rd-del">Delete</button>
    </div>
    <div class="history">${r.history.map((h) => `<div>${new Date(h.at).toLocaleString()} — ${esc(h.text)}</div>`).join('')}</div>`;

  d.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    reqTabs[r.id] = b.dataset.tab;
    d.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    d.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  });
  const selected = () => $$('#rd-matches input[data-row]:checked').map((c) => r.matches[+c.dataset.row]);
  wireChecklist(r, selected);
  d.querySelectorAll('[data-open]').forEach((img) => img.onclick = () => call('openPath', img.dataset.open));
  $('#rd-sheet').onclick = async () => { const p = await call('pick', 'sheet'); if (p.length) run(() => call('attachToRequest', r.id, p), 'Spreadsheet read into this request'); };
  $('#rd-search').onclick = async () => { r.matches = await call('search', $('#rd-q').value); $('#rd-matches').innerHTML = matchTable(r.matches, true); call('setRequest', r.id, { matches: r.matches }); };
  $('#rd-q').onkeydown = (e) => e.key === 'Enter' && $('#rd-search').click();
  $('#rd-re').onclick = () => run(() => call('reanalyse', r.id), 'Read again');
  if ($('#rd-isreq')) $('#rd-isreq').onclick = () => call('setRequest', r.id, { status: 'new' });
  $('#rd-close').onclick = () => call('setRequest', r.id, { status: OPEN.includes(r.status) || r.status === 'maybe' ? 'closed' : 'new' });
  $('#rd-del').onclick = () => confirm('Delete this request?') && call('deleteRequest', r.id);
  $('#rd-locate').onclick = async () => {
    const rows = selected();
    if (!rows.length) return toast('Tick the matching rows first', true);
    replyDialog(r, await call('locatedMessage', r.id, rows));
  };
  $('#rd-notfound').onclick = async () => replyDialog(r, await call('notFoundMessage', r.id));
  $('#rd-reply').onclick = () => replyDialog(r, '');
  $('#rd-copy').onclick = async () => {
    const rows = selected();
    const sources = [], missing = [], unsure = [], offline = new Set();
    for (const row of rows) {
      const f = (row.found || [])[0];
      if (f?.offline) { offline.add(f.tape); continue; }
      if (f) { sources.push(f.session || f.path); if (!f.exact) unsure.push(row.folder); }
      else if (row.path && await call('exists', row.path)) sources.push(row.path);
      else missing.push(row.folder || row.id);
    }
    const recipient = await call('recipientFor', r.id);
    if (offline.size) toast(`Load tape ${[...offline].join(', ')} first. When the drive light is steady, press Tape ready on Find Data, then Copy selected again.`, true);
    if (missing.length) toast(`Not on a connected drive: folder ${missing.join(', ')}. Plug in the drive (it is found automatically) or add the folder by hand.`, true);
    if (unsure.length) toast(`Folder ${unsure.join(', ')}: number found but the date on disk differs. Check before copying.`, true);
    newJob({ sources, requestId: r.id, notify: recipient ? [recipient] : [], name: rows[0] ? (rows[0].kind === 'episode' ? `${rows[0].series} ${rows[0].episodeNo}` : [rows[0].id, rows[0].title].filter(Boolean).join(' ')) : '' });
  };
}

// ---------------------------------------------------------------- checklist
// What the request asks for, item by item, with the drive each is on (electron/main.js draftChecklist).
// A draft until you approve it; then one copy per item, ticked off as each finishes.
const ISTATUS = { copying: ['⏳', 'Copying'], waiting: ['⚠', 'Waiting'], failed: ['✗', 'Failed'], todo: ['☐', 'To do'], done: ['✓', 'Done'], unavailable: ['—', 'Not available'] };
let clText = ''; // the "add your own" box, kept across redraws

function checklistHtml(r) {
  const c = r.checklist;
  const add = `<div class="row cl-add"><input id="cl-text" placeholder="Add your own: a to-do, or a name for folders you pick" style="flex:1" value="${esc(clText)}">
      <button class="btn sm" id="cl-todo">+ To-do</button><button class="btn sm" id="cl-folders">+ Folders</button><button class="btn sm" id="cl-files">+ Files</button><button class="btn sm" id="cl-rows" title="The rows ticked in the matches above">+ Ticked rows</button></div>`;
  if (!c) return `<div class="cl"><div class="cl-head"><b>Checklist</b><span class="muted small">none yet</span><button class="btn sm" id="cl-make">Make from the message</button></div>${add}</div>`;
  const draft = c.state === 'draft';
  const n = c.items.filter((i) => i.status === 'done').length;
  const where = (i) => i.kind === 'todo' ? '' : i.sources?.length ? `From <b>${esc(i.where || i.sources[0])}</b>` : ['draft', 'waiting'].includes(i.status) ? '<span class="cl-bad">Nothing to copy from yet</span>' : '';
  const acts = (i) => draft ? '<button class="btn sm ghost" data-a="remove" title="Take off the list">✕</button>'
    : i.status === 'copying' ? '<span class="small muted">in the queue</span>'
    : ['done', 'unavailable'].includes(i.status) ? '<button class="btn sm ghost" data-a="reopen">Undo</button>'
    : `${i.kind === 'todo' ? '<button class="btn sm" data-a="done">Done</button>' : '<button class="btn sm" data-a="copy">Copy again</button>'}<button class="btn sm ghost" data-a="unavailable">Can’t do…</button>`;
  const rows = c.items.map((i) => `<div class="cl-item ${draft ? '' : i.status}" data-item="${esc(i.id)}">
      <span class="cl-ic" title="${esc(ISTATUS[i.status]?.[1] || '')}">${draft ? (i.kind === 'todo' ? '☐' : '⧉') : ISTATUS[i.status]?.[0] || ''}</span>
      <div class="cl-main">
        <div>${esc(i.title)}${i.kind === 'todo' ? ' <span class="badge">to-do</span>' : ''}</div>
        ${i.ask && i.ask !== i.title ? `<div class="small muted">Asked: ${esc(i.ask)}</div>` : ''}
        ${draft && i.candidates?.length > 1 ? `<select class="cl-pick" title="Other catalogue rows for this item">${i.candidates.map((m, k) => `<option value="${k}" ${m.title === i.title ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select>` : ''}
        <div class="small">${where(i)}${i.backups ? ` <span class="muted">· ${esc(i.backups)}</span>` : ''}${i.note ? ` · ${esc(i.note)}` : ''}</div>
      </div>
      <div class="cl-act">${acts(i)}</div>
    </div>`).join('') || '<div class="small muted">Empty: add items below.</div>';
  const who = c.notify?.length ? c.notify.map((x) => `${esc(x.name)} (${x.channel === 'email' ? 'email' : 'WhatsApp'})`).join(', ') : 'no one (added by hand)';
  const foot = draft
    ? `<label>Copy everything to<div class="row"><input id="cl-dest" list="cl-recent" style="flex:1" value="${esc(c.dest)}"><button class="btn sm" id="cl-browse">Browse</button></div>
        <datalist id="cl-recent">${S.settings.recentDest.map((d) => `<option value="${esc(d)}">`).join('')}</datalist></label>
       <label class="switch"><input type="checkbox" id="cl-auto" ${c.autoSend ? 'checked' : ''}> When every item is done, tell ${who} automatically</label>
       <div class="row"><button class="btn primary" id="cl-approve">Approve · start ${c.items.filter((i) => i.kind === 'copy').length} cop${c.items.filter((i) => i.kind === 'copy').length === 1 ? 'y' : 'ies'}</button><button class="btn ghost" id="cl-make">Make again from the message</button></div>`
    : `<div class="row"><b>${n} of ${c.items.length} done</b><span class="small muted">→ ${esc(c.dest || '')}</span><span style="flex:1"></span>
       ${c.sentAt ? `<span class="small muted">Told ${ago(c.sentAt)} ago</span>` : c.autoSend ? '<span class="small muted">Message goes when all are done</span>' : ''}
       <button class="btn ${n === c.items.length && !c.sentAt ? 'primary' : ''}" id="cl-complete">${n === c.items.length ? 'Send the message…' : 'Complete and send…'}</button></div>`;
  return `<div class="cl"><div class="cl-head"><b>Checklist</b><span class="badge ${draft ? 'warn' : n === c.items.length ? 'ok' : 'info'}">${draft ? 'Draft: check, then approve' : 'Approved'}</span></div>
    ${rows}${add}${foot}</div>`;
}

function wireChecklist(r, selected) {
  const c = r.checklist;
  const save = (cl) => run(() => call('saveChecklist', r.id, cl));
  const each = (sel, fn) => $$(sel).forEach(fn);
  if ($('#cl-text')) $('#cl-text').oninput = (e) => { clText = e.target.value; };
  if ($('#cl-make')) $('#cl-make').onclick = () => (!c || c.state !== 'draft' || !c.edited || confirm('Make the list again from the message? Your changes to it are lost.')) && run(() => call('draftChecklist', r.id));
  const addItem = async (o) => { if (await run(() => call('addChecklistItem', r.id, o))) clText = ''; };
  $('#cl-todo').onclick = () => clText.trim() ? addItem({ title: clText }) : toast('Write the to-do first', true);
  $('#cl-folders').onclick = async () => { const p = await call('pick', 'folder'); if (p.length) addItem({ title: clText, sources: p }); };
  $('#cl-files').onclick = async () => { const p = await call('pick', 'files'); if (p.length) addItem({ title: clText, sources: p }); };
  $('#cl-rows').onclick = async () => {
    const rows = selected();
    if (!rows.length) return toast('Tick rows in the matches above first', true);
    for (const row of rows) await addItem({ row });
  };
  if (!c) return;
  each('#r-detail .cl-item', (el) => {
    const item = c.items.find((i) => i.id === el.dataset.item);
    const pick = el.querySelector('.cl-pick');
    if (pick) pick.onchange = async () => {
      const next = await run(() => call('itemFromRow', item.candidates[+pick.value], item.ask));
      if (next) save({ ...c, items: c.items.map((i) => (i === item ? { ...next, id: item.id, candidates: item.candidates } : i)) });
    };
    el.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.a;
      let note = '';
      if (a === 'unavailable') { note = await askText(`Why can’t “${item.title}” be done?`, 'This goes in the message, e.g. “drive 112 is damaged”, “not recorded that day”'); if (note == null) return; }
      run(() => call('checklistItem', r.id, item.id, a, note));
    });
  });
  if (c.state === 'draft') {
    $('#cl-dest').onchange = (e) => save({ ...c, dest: e.target.value.trim() });
    $('#cl-browse').onclick = async () => { const [d] = await call('pick', 'dest'); if (d) save({ ...c, dest: d }); };
    $('#cl-auto').onchange = (e) => save({ ...c, autoSend: e.target.checked });
    $('#cl-approve').onclick = () => run(() => call('approveChecklist', r.id, { ...c, dest: $('#cl-dest').value.trim() }), 'Approved: copies are in the queue');
  } else {
    $('#cl-complete').onclick = async () => {
      const text = await askText(`Message to ${r.from.name}`, '', await call('checklistMessage', r.id), 'Send');
      if (text != null) run(() => call('completeRequest', r.id, text), 'Sent');
    };
  }
}

// A small dialog with one text box. Resolves with the text, or null when cancelled.
function askText(title, hint, value = '', ok = 'OK') {
  return new Promise((res) => {
    $('#dlg-body').innerHTML = `<h2>${esc(title)}</h2>${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}<textarea id="ask-text" rows="${value ? 9 : 3}">${esc(value)}</textarea>
      <div class="dlg-actions"><button class="btn ghost" value="">Cancel</button><button type="button" class="btn primary" id="ask-ok">${esc(ok)}</button></div>`;
    let done = false;
    dlg.onclose = () => { if (!done) res(null); };
    $('#ask-ok').onclick = () => { done = true; const v = $('#ask-text').value; dlg.close(); res(v); };
    dlg.showModal();
    $('#ask-text').focus();
  });
}

async function replyDialog(r, text) {
  const recipient = await call('recipientFor', r.id);
  $('#dlg-body').innerHTML = `
    <h2>Reply to ${esc(r.from.name)}</h2>
    ${recipient ? `<p class="muted">Sends on ${recipient.channel === 'whatsapp' ? `WhatsApp to “${esc(recipient.chat)}”` : `email to ${esc(recipient.address)}, in the same thread`}.</p>`
      : `<div class="row" style="margin-bottom:10px"><select id="rp-ch"><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select><input id="rp-to" placeholder="Chat name or email address" style="flex:1"></div>`}
    <textarea id="rp-text" rows="8">${esc(text)}</textarea>
    <div class="dlg-actions"><button class="btn ghost" value="">Cancel</button><button type="button" class="btn primary" id="rp-send">Send</button></div>`;
  dlg.onclose = null;
  dlg.showModal();
  $('#rp-send').onclick = async () => {
    let to = null;
    if (!recipient) {
      const v = $('#rp-to').value.trim(); const ch = $('#rp-ch').value;
      if (!v) return toast('Who should get it?', true);
      to = ch === 'email' ? { channel: 'email', name: v, address: v } : { channel: 'whatsapp', name: v, chat: v };
    }
    $('#rp-send').disabled = true; $('#rp-send').textContent = 'Sending…';
    const ok = await run(() => call('replyToRequest', r.id, $('#rp-text').value, to), 'Sent');
    if (ok) dlg.close(); else { $('#rp-send').disabled = false; $('#rp-send').textContent = 'Send'; }
  };
}

function newRequest({ text = '', images = [], files = [] } = {}) {
  const st = { images, files };
  const draw = () => {
    $('#dlg-body').innerHTML = `
      <h2>Add a request</h2>
      <p class="muted">Paste the message or a screenshot (Ctrl+V), or drop pictures or a spreadsheet here.</p>
      <div class="grid2"><label>From<input id="nr-name" placeholder="Name"></label>
        <label>Reply on<div class="row"><select id="nr-ch"><option value="manual">Nowhere (I will answer)</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select><input id="nr-addr" placeholder="chat name / email" style="flex:1"></div></label></div>
      <textarea id="nr-text" rows="6" placeholder="e.g. Need the Guru Purnima satsang from Vadodara, July">${esc(text)}</textarea>
      <div class="thumbs" style="margin-top:8px">${st.images.map((s) => `<img src="${s}">`).join('')}</div>
      <div class="chips" style="margin-top:8px">${st.files.map((f, i) => `<span class="chip">📊 ${esc(baseName(f))}<button type="button" data-rmfile="${i}">✕</button></span>`).join('')}<button type="button" class="btn sm" id="nr-sheet">+ Spreadsheet</button></div>
      <div class="dlg-actions"><button class="btn ghost" value="">Cancel</button><button type="button" class="btn primary" id="nr-go">Add and search</button></div>`;
    const keep = () => { text = $('#nr-text').value; };
    $('#nr-sheet').onclick = async () => { keep(); st.files.push(...await call('pick', 'sheet')); draw(); };
    $$('[data-rmfile]').forEach((b) => b.onclick = () => { keep(); st.files.splice(+b.dataset.rmfile, 1); draw(); });
    $('#nr-text').onpaste = async (e) => {
      const img = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
      if (img) { e.preventDefault(); text = $('#nr-text').value; st.images.push(await readImage(img.getAsFile())); draw(); }
    };
    $('#nr-go').onclick = async () => {
      const ch = $('#nr-ch').value, addr = $('#nr-addr').value.trim(), name = $('#nr-name').value.trim() || addr || 'Manual';
      const from = { channel: ch, name, chat: ch === 'whatsapp' ? addr || name : undefined, address: ch === 'email' ? addr : undefined };
      $('#nr-go').disabled = true; $('#nr-go').textContent = 'Reading…';
      const req = await run(() => call('addManualRequest', { text: $('#nr-text').value, images: st.images, files: st.files, from }));
      if (req) { dlg.close(); selReq = req.id; reqFilter = 'all'; go('requests'); }
      else { $('#nr-go').disabled = false; $('#nr-go').textContent = 'Add and search'; }
    };
  };
  draw();
  dlg.onclose = null;
  if (!dlg.open) dlg.showModal();
}
$('#r-new').onclick = () => newRequest();
$('#r-import-wa').onclick = async () => {
  const req = await run(() => call('importWhatsAppChat'));
  if (req) { selReq = req.id; reqFilter = 'all'; renderRequests(); toast('Imported from WhatsApp'); }
  else if (req === undefined) toast('Nothing new in that chat');
};
document.addEventListener('paste', async (e) => {
  if (page !== 'requests' || dlg.open) return;
  const img = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  const text = e.clipboardData.getData('text');
  if (img) newRequest({ images: [await readImage(img.getAsFile())] });
  else if (text && document.activeElement.tagName !== 'INPUT') newRequest({ text });
});

// ---------------------------------------------------------------- find
function renderFind() {
  const c = S.catalog;
  const age = c.importedAt ? Math.floor((Date.now() - c.importedAt) / 86400000) : null;
  $('#f-stats').innerHTML = c.importedAt
    ? `<div class="row" style="justify-content:space-between"><div><b>${c.rows.toLocaleString()}</b> rows from ${c.files.map(esc).join(', ')} · imported ${new Date(c.importedAt).toLocaleDateString()}
      ${age > 120 ? ` <span class="badge warn">${age} days old — time for a fresh export</span>` : ''}</div>
      <div class="small">${c.sheets.map((s) => `${esc(s.sheet)}: ${Object.entries(s.roles).filter(([k, v]) => k !== 'meta' && v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k} = ${(Array.isArray(v) ? v : [v]).map((i) => `“${esc(s.headers[i])}”`).join(', ')}`).join(' · ') || 'no named columns, all searched'}`).join('<br>')}</div></div>`
    : '<div class="muted">No catalogue yet. Export the archive database to Excel and import it here (refresh it every few months).</div>';
  const dr = S.status.drives || {};
  const drv = (dr.drives || []).map((d) => {
    const name = `${esc(d.root.replace(/[\\/]+$/, ''))}${d.label ? ' ' + esc(d.label) : ''}`;
    if (d.tape && d.status !== 'tape-scanned') return `<span class="chip" title="Tapes are never read on their own. Wait until the drive light is steady.">⏸ ${name} · LTO tape, waiting<button class="btn sm primary" data-tape="${esc(d.root)}">Tape ready — scan</button></span>`;
    if (d.status === 'not-ready') return `<span class="chip" title="Windows got no answer from this drive (a tape may still be loading).">⏳ ${name} · not answering<button class="btn sm" data-tape="${esc(d.root)}">Ready — scan</button></span>`;
    return `<span class="chip">${d.tape ? '📼' : '💽'} ${name} · ${d.recordings} recordings${d.episodes ? `, ${d.episodes} episodes` : ''}</span>`;
  }).join(' ');
  const loaded = new Set((dr.drives || []).filter((d) => d.tape).map((d) => d.label));
  const away = (dr.tapes || []).filter((t) => !loaded.has(t.label));
  $('#f-stats').innerHTML += `<div style="margin-top:12px"><div class="row" style="justify-content:space-between"><div class="small"><b>${dr.recordings || 0}</b> recordings and <b>${dr.episodes || 0}</b> episodes known on drives and tapes. Disks are scanned when plugged in; <b>LTO tapes only when you press Tape ready</b> (drive light steady).</div>
    <div class="row">${(S.settings.locate.extraRoots || []).map((p) => `<span class="chip">${esc(p)}<button data-rmroot="${esc(p)}">✕</button></span>`).join('')}<button class="btn sm" id="f-addroot">+ Folder</button><button class="btn sm" id="f-rescan" title="Rescans disks; tapes are left alone">Rescan disks</button></div></div>
    <div class="chips" style="margin-top:8px">${drv || '<span class="muted small">No drives connected</span>'}</div>
    ${away.length ? `<div class="small" style="margin-top:8px">Remembered tapes (not in the drive): ${away.map((t) => `<span class="chip">📼 ${esc(t.label)} · ${t.recordings + t.episodes} items · ${new Date(t.scannedAt).toLocaleDateString()}<button data-forget="${esc(t.label)}" title="Forget this tape">✕</button></span>`).join(' ')}</div>` : ''}</div>`;
  $('#f-rescan').onclick = () => run(async () => { const n = await call('rescanDrives'); await refresh(); toast(`${n} recordings known`); doFind(); });
  $('#f-addroot').onclick = () => run(async () => { await call('addDriveRoot'); await refresh(); doFind(); });
  $$('[data-rmroot]').forEach((b) => b.onclick = () => run(async () => { await call('removeDriveRoot', b.dataset.rmroot); await refresh(); }));
  $$('[data-tape]').forEach((b) => b.onclick = () => {
    if (!confirm(`Scan ${b.dataset.tape} now?\n\nOnly if the tape is fully loaded and the drive light is steady (not blinking).`)) return;
    b.disabled = true; b.textContent = 'Scanning…';
    run(async () => { const n = await call('scanTape', b.dataset.tape); await refresh(); toast(`Tape scanned: ${n} recordings`); doFind(); }).finally(() => refresh());
  });
  $$('[data-forget]').forEach((b) => b.onclick = () => confirm(`Forget what tape ${b.dataset.forget} holds?`) && run(async () => { await call('forgetTape', b.dataset.forget); await refresh(); }));
}
let findTimer;
$('#f-q').oninput = () => { clearTimeout(findTimer); findTimer = setTimeout(doFind, 180); };
async function doFind() {
  const q = $('#f-q').value.trim();
  if (!q) { $('#f-results').innerHTML = ''; return; }
  const rows = await call('search', q);
  $('#f-results').innerHTML = `<div class="small">${rows.length} result${rows.length === 1 ? '' : 's'}</div>` + matchTable(rows, false).replace('max-height: 360px', '');
}
$('#f-import').onclick = async () => {
  const files = await call('pick', 'excel');
  if (!files.length) return;
  const s = await run(() => call('importCatalog', files));
  if (s) { toast(`Imported ${s.rows} rows`); await refresh(); }
};

// ---------------------------------------------------------------- channels
function renderChannels() {
  const st = S.status, se = S.settings;
  const wa = { off: ['Off', ''], loading: ['Loading…', 'warn'], qr: ['Scan the QR code', 'bad'], ready: ['Connected', 'ok'] }[st.whatsapp] || [st.whatsapp, ''];
  $('#wa-status').textContent = wa[0]; $('#wa-status').className = `badge ${wa[1]}`;
  $('#wa-enabled').checked = se.whatsapp.enabled;
  const g = st.gmail;
  $('#gm-status').textContent = g.status === 'watching' ? `Watching${g.lastCheck ? ' · checked ' + ago(g.lastCheck) : ''}` : g.status === 'error' ? g.error : g.hasPassword || g.google?.signedIn ? 'Not watching' : 'Not set up';
  $('#gm-status').className = `badge ${g.status === 'watching' ? 'ok' : g.status === 'error' ? 'bad' : ''}`;
  if (document.activeElement.closest?.('#page-channels') == null) {
    $('#gm-user').value = se.email.user; $('#gm-folder').value = se.email.folder; $('#gm-interval').value = se.email.intervalMin; $('#gm-domains').value = se.email.domains;
  }
  $('#gm-watch').checked = se.email.watch;
  $('#gm-pass').placeholder = g.hasPassword ? 'saved — type to replace' : 'xxxx xxxx xxxx xxxx';
  // App Password, or Sign in with Google.
  const google = (se.email.login || 'password') === 'google';
  if (document.activeElement !== $('#gm-login')) $('#gm-login').value = google ? 'google' : 'password';
  $('#gm-google').style.display = $('#gm-login').value === 'google' ? '' : 'none';
  $('#gm-pass-wrap').style.display = $('#gm-login').value === 'google' ? 'none' : '';
  // Signed in with Google, the address is the account's own: nothing to type.
  $('#gm-user-wrap').style.display = $('#gm-login').value === 'google' && g.google?.signedIn ? 'none' : '';
  if (document.activeElement !== $('#gm-cid')) $('#gm-cid').value = se.email.googleClientId || '';
  $('#gm-csecret').placeholder = g.google?.hasClient ? 'saved — type to replace' : 'GOCSPX-…';
  $('#gm-who').textContent = g.google?.signedIn ? `Signed in as ${g.google.email || 'your Google account'} ✓` : 'Not signed in';
  $('#gm-signout').style.display = g.google?.signedIn ? '' : 'none';
  $('#ai-key').placeholder = st.ai.hasKey ? 'key saved — type to replace' : 'Anthropic API key — saved encrypted';
  $('#ai-status').textContent = st.ai.hasKey ? (se.ai.enabled ? 'On' : 'Key saved, off') : 'No key';
  $('#ai-status').className = `badge ${st.ai.hasKey && se.ai.enabled ? 'ok' : ''}`;
  $('#ai-enabled').checked = se.ai.enabled;
}
$('#wa-enabled').onchange = (e) => call('setSettings', { whatsapp: { enabled: e.target.checked } }).then(refresh);
$('#wa-show').onclick = () => call('showWhatsApp');
$('#wa-test').onclick = () => run(() => call('testWhatsApp', $('#wa-test-chat').value.trim()), 'Test sent on WhatsApp');
const saveGmail = async () => {
  if ($('#gm-pass').value) { await call('setSecret', 'gmail', $('#gm-pass').value); $('#gm-pass').value = ''; }
  await call('setSettings', { email: { user: $('#gm-user').value.trim(), folder: $('#gm-folder').value.trim() || 'INBOX', intervalMin: +$('#gm-interval').value || 3, domains: $('#gm-domains').value.trim(), watch: $('#gm-watch').checked } });
  await refresh();
};
$('#gm-save').onclick = () => run(saveGmail, 'Saved');
$('#gm-login').onchange = () => run(async () => {
  // Switching back to the App Password keeps the Google sign-in for later.
  await call('setSettings', { email: { login: $('#gm-login').value } });
  await refresh();
});
$('#gm-signin').onclick = () => run(async () => {
  const id = $('#gm-cid').value.trim();
  if (!id) throw new Error('Load the client JSON file (or paste the client ID) first');
  await call('setSettings', { email: { googleClientId: id, folder: $('#gm-folder').value.trim() || 'INBOX', watch: $('#gm-watch').checked } });
  if ($('#gm-csecret').value) { await call('setSecret', 'googleClient', $('#gm-csecret').value.trim()); $('#gm-csecret').value = ''; }
  toast('Finish signing in on Google’s page in your browser…');
  const email = await call('googleSignIn');
  await refresh();
  toast(`Signed in as ${email} ✓`);
});
$('#gm-json').onclick = () => run(async () => {
  const id = await call('googleLoadClient');
  if (!id) return;
  await refresh();
  toast('Client loaded ✓ Now press Sign in with Google');
});
$('#gm-signout').onclick = () => run(async () => { await call('googleSignOut'); await refresh(); }, 'Signed out of Google');
$('#gm-watch').onchange = () => run(saveGmail);
$('#gm-check').onclick = () => run(async () => { await saveGmail(); const n = await call('checkGmail'); toast(`${n} new email${n === 1 ? '' : 's'} looked at`); });
$('#gm-test').onclick = () => run(async () => { await saveGmail(); await call('testEmail'); }, 'Test email sent');
$('#ai-save').onclick = () => run(async () => { if ($('#ai-key').value) await call('setSecret', 'anthropic', $('#ai-key').value.trim()); $('#ai-key').value = ''; await call('setSettings', { ai: { enabled: $('#ai-enabled').checked } }); await refresh(); }, 'Saved');
$('#ai-enabled').onchange = () => $('#ai-save').click();
$('#ai-test').onclick = () => run(async () => { const r = await call('testClaude'); toast(r.aiError ? `Claude: ${r.aiError}` : `Claude read it: ${r.summary}`, !!r.aiError); });

// ---------------------------------------------------------------- settings
function renderSettings() {
  if (document.activeElement.closest?.('#page-settings')) return;
  const s = S.settings;
  $('#s-conflict').value = s.copy.conflict; $('#s-buffer').value = s.copy.bufferMB; $('#s-verify').checked = s.copy.verify;
  $('#s-autosend').checked = s.notify.autoSend; $('#s-remind').value = s.reminders.afterMin;
  for (const k of ['copyDone', 'copyFailed', 'located', 'notFound', 'requestDone', 'requestPartial']) $(`#t-${k}`).value = S.templates[k];
  renderPhone();
  renderSync();
  renderIgnored();
}

// Verified businesses and ignored senders: never requests.
function renderIgnored() {
  const v = S.settings.whatsapp.verifiedChats || [];
  const ig = S.settings.ignoredSenders || [];
  $('#ig-list').innerHTML = (v.length || ig.length)
    ? [...v.map((c) => `<span class="chip" title="Verified business on WhatsApp">✔ ${esc(c)}<button data-unverify="${esc(c)}" title="Not a business: treat its messages normally">✕</button></span>`),
      ...ig.map((i) => `<span class="chip" title="Ignored ${esc(i.channel)} sender">${i.channel === 'email' ? '✉' : '💬'} ${esc(i.name)}<button data-unignore="${esc(i.key)}" title="Stop ignoring">✕</button></span>`)].join(' ')
    : '<span class="muted small">None yet. Verified businesses are added when WhatsApp shows their badge; tick requests and press “Not a request · ignore sender” to add others.</span>';
  $$('[data-unverify]').forEach((b) => { b.onclick = () => run(async () => { await call('forgetVerified', b.dataset.unverify); await refresh(); }); });
  $$('[data-unignore]').forEach((b) => { b.onclick = () => run(async () => { await call('unignoreSender', b.dataset.unignore); await refresh(); }); });
}

// Other computers (shared Google Drive folder)
async function renderSync() {
  const s = S.settings.sync || {};
  const i = await call('syncInfo');
  const mode = s.mode || 'gmail';
  const typing = ['sy-folder', 'sy-machine'].includes(document.activeElement?.id);
  $('#sy-enabled').checked = !!s.enabled;
  $('#sy-mode').value = mode;
  for (const id of ['#sy-folder', '#sy-browse']) $(id).style.display = mode === 'folder' ? '' : 'none';
  $('#sy-gmail-note').style.display = mode === 'gmail' ? '' : 'none';
  if (!typing) {
    $('#sy-folder').value = s.folder || i.suggested || '';
    $('#sy-machine').value = s.machine || '';
    $('#sy-machine').placeholder = i.hostname;
  }
  $('#sy-status').textContent = !s.enabled ? 'Off' : i.error || !i.ready ? 'Problem' : i.others.length ? `With ${i.others.join(', ')}` : 'On, no other computer yet';
  $('#sy-status').className = `badge ${s.enabled && i.ready && !i.error && i.others.length ? 'ok' : s.enabled && (i.error || !i.ready) ? 'warn' : ''}`;
  const checked = !i.lastPoll ? 'not yet' : ago(i.lastPoll) === 'now' ? 'just now' : `${ago(i.lastPoll)} ago`;
  $('#sy-info').textContent = !s.enabled
    ? (mode === 'folder' ? (i.suggested ? `Google Drive found: ${i.suggested}` : 'Choose a folder that every computer syncs (Google Drive for desktop, OneDrive, a network share).') : '')
    : !i.ready ? (mode === 'gmail' ? 'Save the Gmail address and App Password on the Channels page first.' : 'Choose the shared folder.')
    : i.error ? `Problem: ${i.error}`
    : `Through ${i.where} · last checked ${checked}${i.waiting ? ` · ${i.waiting} update(s) waiting for requests not caught here yet` : ''}${i.unsent ? ` · ${i.unsent} not written yet` : ''}`;
}
const saveSync = () => run(async () => {
  const mode = $('#sy-mode').value;
  const folder = $('#sy-folder').value.trim();
  if ($('#sy-enabled').checked && mode === 'folder' && !folder) { $('#sy-enabled').checked = false; throw new Error('Choose the shared folder first'); }
  await call('setSettings', { sync: { enabled: $('#sy-enabled').checked, mode, folder, machine: $('#sy-machine').value.trim() } });
  await refresh();
});
$('#sy-mode').onchange = saveSync;
$('#sy-enabled').onchange = saveSync;
$('#sy-machine').onchange = saveSync;
$('#sy-folder').onchange = saveSync;
$('#sy-browse').onclick = () => run(async () => { const [d] = await call('pick', 'dest'); if (d) { $('#sy-folder').value = d; await saveSync(); } });
$('#sy-now').onclick = () => run(async () => { const n = await call('syncNow'); toast(n ? `${n} update(s) from other computers` : 'Up to date'); await refresh(); });
$('#s-save').onclick = () => run(async () => {
  const templates = {};
  for (const k of ['copyDone', 'copyFailed', 'located', 'notFound', 'requestDone', 'requestPartial']) templates[k] = $(`#t-${k}`).value;
  await call('setSettings', {
    copy: { conflict: $('#s-conflict').value, bufferMB: +$('#s-buffer').value || 4, verify: $('#s-verify').checked },
    notify: { autoSend: $('#s-autosend').checked, templates },
    reminders: { afterMin: +$('#s-remind').value || 60 },
  });
  await refresh();
}, 'Saved');
// Phone remote
async function renderPhone() {
  const s = S.settings.remote || {};
  const p = S.status.phone || {};
  $('#ph-enabled').checked = !!s.enabled;
  if (document.activeElement !== $('#ph-port')) $('#ph-port').value = s.port || 8765;
  $('#ph-status').textContent = !p.on ? 'Off' : p.online ? `${p.online} phone${p.online > 1 ? 's' : ''} connected` : p.paired ? 'On, phone not connected' : 'On, no phone paired';
  $('#ph-status').className = `badge ${p.on && p.online ? 'ok' : ''}`;
  const info = await call('remoteInfo');
  $('#ph-devices').innerHTML = info.devices.map((d) => `<div class="row small"><span>${d.online ? '🟢' : '⚪'} <b>${esc(d.name)}</b> · paired ${new Date(d.pairedAt).toLocaleDateString()} · last seen ${ago(d.lastSeen)}</span><button class="btn sm ghost" data-unpair="${esc(d.id)}">Unpair</button></div>`).join('') || '<div class="small muted">No phone paired yet.</div>';
  $$('[data-unpair]').forEach((b) => { b.onclick = () => confirm('Unpair this phone? It will need a new code to connect again.') && run(() => call('revokePhone', b.dataset.unpair)).then(renderPhone); });
  if (!info.pairing) $('#ph-pairing').innerHTML = '';
}
const savePhone = () => run(async () => { await call('setSettings', { remote: { enabled: $('#ph-enabled').checked, port: +$('#ph-port').value || 8765 } }); await refresh(); });
$('#ph-enabled').onchange = savePhone;
$('#ph-port').onchange = savePhone;
$('#ph-pair').onclick = () => run(async () => {
  if (!S.settings.remote?.enabled) { $('#ph-enabled').checked = true; await savePhone(); await new Promise((r) => setTimeout(r, 300)); }
  const p = await call('startPairing');
  $('#ph-pairing').innerHTML = `<img src="${p.qr}" width="160" height="160" alt="Pairing QR code" style="background:#fff;border-radius:6px">
    <div><div class="small muted">In the phone app: <b>Pair with PC</b> → scan this, or type</div>
    <div style="font-size:30px;letter-spacing:6px;font-weight:600">${esc(p.code)}</div>
    <div class="small muted">PC address: ${esc(p.addresses.join(' or ') || 'no Wi-Fi/LAN address found')} · port ${p.port}<br>The code works once and expires at ${new Date(p.expiresAt).toLocaleTimeString()}.</div></div>`;
});

$('#s-sendto').onclick = () => run(() => call('installSendTo'), 'Added to Send to');
$('#s-data').onclick = () => call('openData');

// ---------------------------------------------------------------- activity
function renderActivity() {
  $('#act').innerHTML = S.activity.map((a) => `<div class="act"><span class="t">${new Date(a.at).toLocaleString()}</span><span>${esc(a.text)}</span></div>`).join('') || '<div class="empty">Nothing yet</div>';
}

// ---------------------------------------------------------------- wiring
function render() {
  if (!S) return;
  renderQueue();
  renderRequests();
  if (page === 'find') renderFind();
  if (page === 'channels') renderChannels();
  if (page === 'settings') renderSettings();
  if (page === 'activity') renderActivity();
  const wa = S.status.whatsapp === 'ready' ? 'WhatsApp ✓' : S.settings.whatsapp.enabled ? 'WhatsApp …' : '';
  const gm = S.status.gmail.status === 'watching' ? 'Gmail ✓' : '';
  const ph = S.status.phone?.online ? 'Phone ✓' : S.status.phone?.on && S.status.phone?.paired ? 'Phone …' : '';
  $('#foot').innerHTML = `${[wa, gm, ph].filter(Boolean).join(' · ') || 'No channels on'}<br>v${S.version}`;
}
async function refresh() { S = await call('state'); render(); }

window.api.on('queue', (q) => { if (!S) return; S.queue = q; renderQueue(); });
window.api.on('requests', (r) => { if (!S) return; S.requests = r; renderRequests(); });
window.api.on('activity', (a) => { if (!S) return; S.activity = a; if (page === 'activity') renderActivity(); });
window.api.on('status', (st) => { if (!S) return; S.status = st; if (page === 'channels') renderChannels(); render(); });

refresh().then(() => go(page));
setInterval(() => page === 'requests' && renderRequests(), 60000);
