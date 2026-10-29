// Dev only (AVC_SMOKE=<folder>): sample data, every page screenshotted, renderer errors logged.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const XLSX = require('xlsx');

const errors = [];
module.exports = function (o) { smoke(o).catch((e) => { fs.writeFileSync(path.join(o.out, 'result.txt'), ['FAILED ' + e.stack, ...errors].join('\n')); app.exit(1); }); };
async function smoke({ win, api, queue, out }) {
  win.webContents.on('console-message', (_e, level, msg, line, src) => { errors.push(`${msg} (${path.basename(src)}:${line})`); });
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));

  const src = path.join(out, 'src', 'Janmashtami Sabha 16-Aug-26');
  fs.mkdirSync(path.join(src, 'Cam-01'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Program.mov'), Buffer.alloc(40 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(src, 'Cam-01', 'Cam A.mov'), Buffer.alloc(8 * 1024 * 1024, 2));
  const xlsx = path.join(out, 'archive.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Sr', 'Drive No', 'Tape No', 'Event', 'Place', 'Date', 'Folder Path'],
    [1, 'HDD-0123', 'LTO-45', 'Janmashtami Sabha', 'Ahmedabad', '16-08-2026', src],
    [2, 'HDD-0124', 'LTO-46', 'Guru Purnima Satsang', 'Vadodara', '10-07-2026', 'E:/2026/GuruPurnima'],
    [3, 'HDD-0124', 'LTO-47', 'Youth Shibir', 'Coppell', '02-08-2026', 'E:/2026/Shibir'],
  ]), 'Archive');
  XLSX.writeFile(wb, xlsx);

  const real = process.env.AVC_SMOKE_CATALOG;
  let t0 = Date.now();
  await api.importCatalog(real ? real.split(';') : [xlsx]);
  errors.push(`import ms ${Date.now() - t0}`);
  const req = await api.addManualRequest({ text: 'Bhai please send janmashtami sabha footage, Ahmedabad 16 Aug. Drive 123 I think', from: { channel: 'whatsapp', name: 'Ravi Patel', chat: 'Ravi Patel' } });
  await api.addManualRequest({ text: 'Need guru purnima vadodra satsang raw files please', from: { channel: 'email', name: 'Meera', address: 'meera@example.com' } });
  queue.pause();
  await api.addJob({ sources: [src], dest: path.join(out, 'dest'), requestId: req.id, notify: [{ channel: 'whatsapp', name: 'Ravi Patel', chat: 'Ravi Patel' }], autoSend: false });
  await api.addJob({ sources: [path.join(src, 'Program.mov')], dest: path.join(out, 'dest2'), name: 'Second job' });

  const shot = async (name, js) => {
    if (js) await win.webContents.executeJavaScript(js);
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await win.webContents.executeJavaScript('refresh()');
  await shot('requests', `selReq=${JSON.stringify(req.id)}; reqFilter='all'; go('requests')`);
  await shot('find', `go('find'); document.querySelector('#f-q').value=${JSON.stringify(real ? 'nm folder 418' : 'HDD 124')}; doFind()`);
  if (real) {
    const drive = path.join(out, 'mockdrive');
    for (const sub of ['Adalaj Aptavani-14 Part-05 Parayan M. Dt-15-Sep-26 Dur-1h2m', 'Adalaj Aptavani-14 Part-05 Parayan E. Dt-15-Sep-26 Dur-58m']) fs.mkdirSync(path.join(drive, '3017 to 3050', '3034 Dt-15 Sep 2026', sub), { recursive: true });
    fs.writeFileSync(path.join(drive, '3017 to 3050', '3034 Dt-15 Sep 2026', 'Adalaj Aptavani-14 Part-05 Parayan E. Dt-15-Sep-26 Dur-58m', 'Program.mov'), 'x');
    const tapeDir = path.join(out, 'mocktape');
    fs.mkdirSync(path.join(tapeDir, 'Niruma', 'Formal', 'DVCAM', 'NM MASTER - 0418 to 0438', 'NM-0418'), { recursive: true });
    fs.writeFileSync(path.join(tapeDir, 'Niruma', 'Formal', 'DVCAM', 'NM MASTER - 0418 to 0438', 'NM-0418', 'NM-0418.avi'), 'x');
    fs.mkdirSync(path.join(drive, 'Pujyashree Deepakbhai', 'Episode', 'DVCAM', 'Gujarati', 'DD Vitraag-2301-2400'), { recursive: true });
    fs.writeFileSync(path.join(drive, 'Pujyashree Deepakbhai', 'Episode', 'DVCAM', 'Gujarati', 'DD Vitraag-2301-2400', 'DD Vitraag-2350.mp4'), 'x');
    api.setSettings({ locate: { scanDrives: false, extraRoots: [drive, tapeDir], tapeRoots: [tapeDir], tapeLabels: { [tapeDir]: 'NM-NA-VAT-MD1-LTO-002' } } });
    errors.push('day folders: ' + await api.rescanDrives());
    errors.push('drives: ' + JSON.stringify(api.state().status.drives));
    const r2 = await api.addManualRequest({ text: 'Niruma ni master 418 vali video joie che, ane Vitraag episode 2350 pan', from: { channel: 'whatsapp', name: 'Ravi Patel', chat: 'Ravi Patel' } });
    await shot('real-request', `selReq=${JSON.stringify(r2.id)}; reqFilter='all'; go('requests')`);
    await shot('find-tape-waiting', `go('find'); document.querySelector('#f-q').value='nm folder 418'; doFind()`);
    errors.push('after tape scan: ' + await api.scanTape(tapeDir));
    await win.webContents.executeJavaScript('refresh()');
    await shot('find-tape-scanned', `go('find'); doFind()`);
    const nmRow = api.search('nm folder 418')[0];
    errors.push('found: ' + JSON.stringify(nmRow.found));
    await api.addJob({ sources: [nmRow.found[0].path], dest: path.join(out, 'dest3'), name: 'NM-F-DV-0418' });
    await shot('queue-held', `go('queue')`);
    await shot('real-request', `selReq=${JSON.stringify(r2.id)}; reqFilter='all'; go('requests')`);
    await shot('copy-dialog', "document.querySelector('#rd-copy').click()");
    await win.webContents.executeJavaScript("document.querySelector('#dlg').close()");
    errors.push('LOCATED MESSAGE: ' + api.locatedMessage(r2.id, r2.matches.slice(0, 1)));
  }
  await shot('channels', `go('channels')`);
  await shot('settings', `go('settings')`);
  queue.resume();
  await new Promise((r) => setTimeout(r, 150));
  await shot('queue', `go('queue')`);
  while (queue.running) await new Promise((r) => setTimeout(r, 200));
  await shot('queue-done', `openJobs.add(S.queue.jobs[0].id); renderQueue()`);
  await shot('newjob', `newJob({ sources: ['C:/Footage/Event A'], notify: [{ channel: 'whatsapp', name: 'Ravi Patel', chat: 'Ravi Patel' }] }); document.querySelector('#j-to').value = 'DV'; document.querySelector('#j-addwho').click()`);
  await win.webContents.executeJavaScript("document.querySelector('#dlg').close()");

  // A request listing two recordings: a checklist drafted from it, one item of yours added,
  // approved, copied item by item; one cannot be done, and the message says so.
  const list = await api.addManualRequest({ text: 'Please send these:\n1) Janmashtami sabha Ahmedabad 16 Aug 2026\n2) Guru Purnima satsang Vadodara 10 Jul 2026', from: { channel: 'whatsapp', name: 'Asha Shah', chat: 'Asha Shah' } });
  errors.push('DRAFT: ' + JSON.stringify(list.checklist.items.map((i) => [i.ask, i.title, i.sources, i.note])));
  await api.addChecklistItem(list.id, { title: 'Ask Asha which timecode she needs' });
  await shot('checklist-draft', `selReq=${JSON.stringify(list.id)}; reqFilter='all'; go('requests'); document.querySelector('.cl').scrollIntoView()`);
  const c = api.state().requests.find((r) => r.id === list.id).checklist;
  await api.approveChecklist(list.id, { ...c, dest: path.join(out, 'dest-list'), autoSend: false });
  while (queue.running || queue.jobs.some((j) => j.status === 'queued')) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 300));
  const after = api.state().requests.find((r) => r.id === list.id);
  const todo = after.checklist.items.find((i) => i.kind === 'todo');
  await api.checklistItem(list.id, todo.id, 'done');
  const waiting = after.checklist.items.find((i) => i.status === 'waiting');
  // The drive search found it in two places (drawn here only), and a file is linked by hand.
  if (waiting) {
    while (api.state().requests.find((r) => r.id === list.id).checklist.searching) await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript('refresh()');
    await shot('checklist-found', `selReq=${JSON.stringify(list.id)}; S.status.drives.drives.push({ root: '/Volumes/Share01', label: 'Share01', network: true, status: 'disk' }); Object.assign(S.requests.find((r) => r.id === ${JSON.stringify(list.id)}).checklist.items.find((i) => i.id === ${JSON.stringify(waiting.id)}), { searchedAt: Date.now(), note: 'Found by name in 2 places: pick one', hits: [{ path: '/Volumes/Nasshare02/Editing/Utkarsh/3018 Adalaj Soneri Satsang E. Dt-20-Aug-26.mp4', where: 'Nasshare02', isFile: true, size: 828375040, exact: true }, { path: 'F:/HD 2026/3001 to 3020/3018 Dt-20-Aug-26', where: 'F:\\\\', isFile: false, size: 0, exact: true }] }); renderRequests(); document.querySelector('.cl').scrollIntoView()`);
    const linked = path.join(out, 'linked.mp4'); fs.writeFileSync(linked, 'linked by hand');
    await api.checklistItem(list.id, waiting.id, 'link', [linked]);
    errors.push('LINKED: ' + JSON.stringify(api.state().requests.find((r) => r.id === list.id).checklist.items.find((i) => i.id === waiting.id)));
    while (queue.running || queue.jobs.some((j) => j.status === 'queued')) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 300));
  }
  if (waiting) await api.checklistItem(list.id, waiting.id, 'reopen').then(() => api.checklistItem(list.id, waiting.id, 'unavailable', 'the drive is at the Vadodara centre'));
  await win.webContents.executeJavaScript('refresh()');
  await shot('checklist-approved', `selReq=${JSON.stringify(list.id)}; renderRequests(); document.querySelector('.cl').scrollIntoView()`);
  errors.push('ITEMS: ' + JSON.stringify(api.state().requests.find((r) => r.id === list.id).checklist.items.map((i) => [i.title, i.status, i.note])));
  errors.push('CHECKLIST MESSAGE: ' + api.checklistMessage(list.id));
  errors.push('LIST REQUEST STATUS: ' + api.state().requests.find((r) => r.id === list.id).status);

  // The same two recordings asked for in a spreadsheet, with a one-line mail.
  const sheet = path.join(out, 'Needed footage.xlsx');
  const swb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(swb, XLSX.utils.aoa_to_sheet([['Event', 'Place', 'Date'], ['Janmashtami Sabha', 'Ahmedabad', new Date(2026, 7, 16)], ['Guru Purnima Satsang', 'Vadodara', new Date(2026, 6, 10)]], { cellDates: true }), 'Sheet1');
  XLSX.writeFile(swb, sheet);
  const sr = await api.addManualRequest({ text: 'Please send the list attached', files: [sheet], from: { channel: 'email', name: 'Kiran Desai', address: 'kiran@example.com' } });
  errors.push('SHEET REQUEST: ' + JSON.stringify({ status: sr.status, files: sr.files.length, rows: Object.values(sr.sheets).map((s) => s.rows), items: sr.checklist.items.map((i) => [i.ask, i.title, i.sources.length ? 'has source' : i.note]) }));
  // An old .xls the phone could not read: sent by the phone as it is, read here.
  const xls = XLSX.write(swb, { bookType: 'xls', type: 'base64' });
  const pr = await api.phoneRequest({ channel: 'whatsapp', externalId: 'scan:1', from: { name: 'Asha Shah', chat: 'Asha Shah' }, text: '', receivedAt: Date.now(), scanned: true, files: [{ name: 'Needed footage.xls', data: xls }] });
  const preq = api.state().requests.find((r) => r.id === pr.id);
  errors.push('PHONE XLS: ' + JSON.stringify({ pr, rows: preq && Object.values(preq.sheets).map((s) => s.rows), items: preq?.checklist.items.length }));

  // The phone's way through a checklist: only the calls it may make, on the list it is sent.
  const { Remote, PHONE_CALLS } = require('./remote');
  const phone = (m, ...a) => { if (!PHONE_CALLS.has(m)) throw new Error(`phone may not call ${m}`); return api[m](...a); };
  const seen = () => new Remote({ api }).state().requests.find((r) => r.id === pr.id).checklist;
  let pc = seen();
  errors.push('PHONE SEES: ' + JSON.stringify({ state: pc.state, items: pc.items.map((i) => [i.title, i.candidates, 'row' in i]) }));
  await phone('setChecklist', pr.id, { dest: path.join(out, 'dest-phone'), autoSend: false });
  await phone('addChecklistItem', pr.id, { title: 'Check the audio on item 2' });
  await phone('checklistItem', pr.id, seen().items[1].id, 'remove');
  await phone('approveChecklist', pr.id);
  while (queue.running || queue.jobs.some((j) => j.status === 'queued')) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 300));
  await phone('checklistItem', pr.id, seen().items.find((i) => i.kind === 'todo').id, 'done');
  pc = seen();
  errors.push('PHONE AFTER: ' + JSON.stringify({ state: pc.state, dest: path.basename(pc.dest), items: pc.items.map((i) => [i.title, i.status]), status: api.state().requests.find((r) => r.id === pr.id).status }));
  errors.push('PHONE MESSAGE: ' + await phone('checklistMessage', pr.id));
  await win.webContents.executeJavaScript('refresh()');
  await shot('sheet-request', `selReq=${JSON.stringify(sr.id)}; reqFilter='all'; go('requests'); document.querySelector('main').scrollTop = 0`);
  await shot('foot', `S.status.whatsapp = 'ready'; S.settings.whatsapp.enabled = true; S.status.phone = { on: true, online: 1, paired: 1 }; S.status.gmail.status = 'error'; S.status.gmail.error = 'Login failed'; render()`);

  const final = queue.snapshot().jobs.map((j) => `${j.name}: ${j.status} ${j.done}/${j.count}`);
  fs.writeFileSync(path.join(out, 'result.txt'), [`errors: ${errors.length}`, ...errors, ...final, `request status: ${api.state().requests.find((r) => r.id === req.id).status}`].join('\n'));
  app.isQuitting = true;
  app.exit(0);
}
