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
  await shot('newjob', `newJob({ sources: ['C:/Footage/Event A'] })`);

  const final = queue.snapshot().jobs.map((j) => `${j.name}: ${j.status} ${j.done}/${j.count}`);
  fs.writeFileSync(path.join(out, 'result.txt'), [`errors: ${errors.length}`, ...errors, ...final, `request status: ${api.state().requests.find((r) => r.id === req.id).status}`].join('\n'));
  app.isQuitting = true;
  app.exit(0);
}
