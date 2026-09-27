/**
 * Captures a zoomed-out view of the document so the inter-page gutter
 * (the gray gap between white sheets) is unambiguously visible, plus a
 * crop tightly around one gutter.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const PORT = 9355;
const OUT = path.join(__dirname, '..', 'build-test');
const EDITOR = 'file:///C:/devdocs/app/src/main/assets/editor/index.html';

const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--window-size=412,915',
    '--user-data-dir=' + path.join(OUT, 'chrome-prof3'), EDITOR
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try { target = (await getJSON('/json')).find(t => t.type === 'page' && t.url.indexOf('editor') !== -1); if (target) break; } catch (e) {}
    await sleep(400);
  }
  if (!target) { proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + m)); } }, 20000);
  });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  await send('Page.enable'); await send('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    try { const r = await send('Runtime.evaluate', { expression: '!!window.__editor', returnByValue: true }); if (r.result.value) break; } catch (e) {}
    await sleep(300);
  }
  const evalJs = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;

  // seed a multi-page doc with visible content on each page
  await evalJs(`(function(){
    var c = document.getElementById('content');
    var h = '<h1>Multi-page Layout</h1>';
    for (var i = 1; i <= 26; i++) {
      h += '<h3>Section ' + i + '</h3><p>Paragraph body for section ' + i +
           '. Demonstrating real page sheets with margins and gutters.</p>';
    }
    c.innerHTML = h;
    document.getElementById('docTitle').value = 'Multi-page Layout';
    window.__editor.paginate();
    return window.__editor.pageCount();
  })()`);
  await sleep(700);

  const n = await evalJs('window.__editor.pageCount()');
  console.log('pages = ' + n);

  // Zoom out so two full pages + gutter fit on screen
  await evalJs(`(function(){
    var cv = document.getElementById('canvas');
    // fit ~2.1 pages vertically
    var z = (cv.clientHeight - 40) / ((1056*2 + 26) * 1.05);
    window.__editor.setZoom(z);
    cv.scrollTop = 0;
    return z;
  })()`);
  await sleep(700);

  const s1 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(OUT, '09_two_pages_gutter.png'), Buffer.from(s1.data, 'base64'));
  console.log('wrote 09_two_pages_gutter.png (' + Buffer.from(s1.data, 'base64').length + ' bytes)');

  // Now capture a tight crop centred on the first gutter
  const clip = JSON.parse(await evalJs(`(function(){
    var pages = document.querySelectorAll('.page');
    var a = pages[0].getBoundingClientRect();
    var b = pages[1].getBoundingClientRect();
    var cv = document.getElementById('canvas').getBoundingClientRect();
    return JSON.stringify({
      x: Math.max(0, a.left - 10),
      y: a.bottom - 60 - cv.top,
      width: Math.min(a.width + 20, cv.width),
      height: (b.top - a.bottom) + 120
    });
  })()`));
  console.log('gutter clip = ' + JSON.stringify(clip));
  const s2 = await send('Page.captureScreenshot', {
    format: 'png', fromSurface: true,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 }
  });
  fs.writeFileSync(path.join(OUT, '10_gutter_closeup.png'), Buffer.from(s2.data, 'base64'));
  console.log('wrote 10_gutter_closeup.png (' + Buffer.from(s2.data, 'base64').length + ' bytes)');

  ws.close(); proc.kill(); await sleep(300);
  process.exit(0);
})().catch(e => { console.log('ERR: ' + e.message); process.exit(2); });
