/**
 * Host-side visual capture of the real editor assets in headless Chrome,
 * driven over CDP so we can seed content, scroll the ribbon, and screenshot
 * several states. Complements device_probe.js (which validates behaviour).
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const OUTDIR = path.join(__dirname, '..', 'build-test');
const EDITOR = 'file:///C:/devdocs/app/src/main/assets/editor/index.html';

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--window-size=412,915',
    '--force-device-scale-factor=2',
    '--user-data-dir=' + path.join(OUTDIR, 'chrome-profile'),
    EDITOR
  ], { stdio: 'ignore' });

  // wait for the debugger endpoint
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJSON('/json');
      target = list.find(t => t.type === 'page' && t.url.indexOf('editor') !== -1);
      if (target) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!target) { console.log('no target'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + m)); } }, 20000);
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  await send('Page.enable');
  await send('Runtime.enable');

  // wait for the engine to boot
  for (let i = 0; i < 40; i++) {
    try {
      const r = await send('Runtime.evaluate', { expression: '!!window.__editor', returnByValue: true });
      if (r.result.value) break;
    } catch (e) {}
    await sleep(300);
  }

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }

  async function shot(name) {
    const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const p = path.join(OUTDIR, name);
    fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log('  wrote ' + name + ' (' + Buffer.from(s.data, 'base64').length + ' bytes)');
  }

  console.log('=== host visual capture ===');

  // ---- State 1: seeded document, default fit-to-width ----
  await evalJs(`(function(){
    var c = document.getElementById('content');
    c.innerHTML =
      '<h1>Quarterly Report</h1>' +
      '<p>This page uses <b>real desktop page layout</b>: a US Letter sheet at ' +
      '816&times;1056 CSS px with 96px margins &mdash; the same geometry the web editor uses.</p>' +
      '<h2>Highlights</h2>' +
      '<ul><li>Revenue up <b>18%</b> quarter over quarter</li>' +
      '<li><i>Margins</i> held steady at <u>42%</u></li>' +
      '<li>Three new regions onboarded</li></ul>' +
      '<blockquote>Print layout is the default here &mdash; no menu hunting.</blockquote>' +
      '<p>Word count, page number and zoom update live in the status bar below.</p>';
    document.getElementById('docTitle').value = 'Quarterly Report';
    window.__editor.paginate();
    window.__editor.saveNow();
    return window.__editor.pageMetrics();
  })()`);
  await sleep(700);
  await shot('01_document_fit.png');

  // ---- State 2: toolbar scrolled to show inline formatting ----
  await evalJs(`(function(){
    var r = document.getElementById('ribbonScroll');
    r.scrollLeft = 430;
    return r.scrollLeft;
  })()`);
  await sleep(500);
  await shot('02_toolbar_formatting.png');

  // ---- State 3: multi-page document ----
  await evalJs(`(function(){
    var c = document.getElementById('content');
    var html = '<h1>Long Document</h1>';
    for (var i = 1; i <= 40; i++) {
      html += '<h3>Section ' + i + '</h3><p>' + ('Body text for section ' + i + '. ').repeat(6) + '</p>';
    }
    c.innerHTML = html;
    document.getElementById('ribbonScroll').scrollLeft = 0;
    window.__editor.paginate();
    return window.__editor.pageCount();
  })()`);
  await sleep(900);
  const pages = await evalJs('window.__editor.pageCount()');
  console.log('  long document pages = ' + pages);
  await shot('03_multipage.png');

  // scroll down to show a second page boundary
  await evalJs(`(function(){
    var cv = document.getElementById('canvas');
    cv.scrollTop = window.__editor.pageMetrics().pageH + 40;
    return cv.scrollTop;
  })()`);
  await sleep(600);
  await shot('04_page_two.png');

  // ---- State 4: zoomed to 100% ----
  await evalJs(`window.__editor.setZoom(1); 'ok'`);
  await sleep(600);
  await shot('05_zoom_100.png');

  // ---- State 5: dark theme ----
  await evalJs(`(function(){
    document.getElementById('btnTheme').click();
    return document.body.className;
  })()`);
  await sleep(600);
  await shot('06_dark_theme.png');

  // ---- State 6: View menu open (shows print layout toggle) ----
  await evalJs(`(function(){
    document.getElementById('btnTheme').click();
    var items = document.querySelectorAll('.menu-item');
    items[2].click();
    return 'menu';
  })()`);
  await sleep(500);
  await shot('07_view_menu.png');

  // ---- State 7: export menu ----
  await evalJs(`(function(){
    document.body.click();
    document.getElementById('btnShare').click();
    return 'export';
  })()`);
  await sleep(500);
  await shot('08_export_menu.png');

  // report final metrics
  const metrics = await evalJs('JSON.stringify(window.__editor.pageMetrics())');
  console.log('  final metrics: ' + metrics);

  ws.close();
  proc.kill();
  await sleep(400);
  console.log('=== capture complete ===');
  process.exit(0);
})().catch(e => { console.log('CAPTURE ERROR: ' + e.message); process.exit(2); });
