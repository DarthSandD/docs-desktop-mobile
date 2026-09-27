/**
 * Connects to the live Android WebView via Chrome DevTools Protocol and
 * inspects the running editor: proves the engine booted on-device, measures
 * real page geometry, and exercises formatting inside the device WebView.
 *
 * Usage: node tools/device_probe.js [port]
 */
const http = require('http');

const PORT = parseInt(process.argv[2] || '9222', 10);

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJSON('/json');
  const page = targets.find(t => t.type === 'page' && t.url.indexOf('editor') !== -1);
  if (!page) { console.log('NO_EDITOR_PAGE'); process.exit(1); }
  console.log('target url   : ' + page.url);
  console.log('ws endpoint  : ' + page.webSocketDebuggerUrl);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = e => rej(new Error('ws error'));
  });
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  };

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('JS exception: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  await send('Runtime.enable');
  await send('Page.enable');

  let pass = 0, fail = 0;
  const failures = [];
  function check(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
  }

  console.log('\n=== On-device editor verification ===\n');

  console.log('[1] Engine boot');
  // the WebView may still be loading when we attach; poll until the engine is up
  let hasEd = false;
  for (let i = 0; i < 40; i++) {
    try {
      const v = await evaluate('!!window.__editor');
      if (v === true) { hasEd = true; break; }
    } catch (e) { /* page mid-navigation */ }
    await new Promise(r => setTimeout(r, 500));
  }
  check('window.__editor exposed on device', hasEd === true);
  const title = await evaluate('document.title');
  console.log('  (page title: "' + title + '")');
  const hostBridge = await evaluate('typeof window.AndroidHost');
  check('native JS bridge present', hostBridge === 'object', 'typeof=' + hostBridge);

  console.log('\n[2] Page geometry (real device WebView)');
  // start from a clean document so the geometry assertions are deterministic
  await evaluate(`(function(){
    var c = document.getElementById('content');
    c.innerHTML = '<p>geometry probe</p>';
    window.__editor.paginate();
    return 'ok';
  })()`);
  const m = await evaluate('JSON.stringify(window.__editor.pageMetrics())');
  console.log('  metrics: ' + m);
  const mm = JSON.parse(m);
  check('single-page doc renders exactly one page sheet', mm.pages === 1, 'pages=' + mm.pages);
  check('page is letter ratio (816x1056)',
    Math.abs((mm.pageW / mm.pageH) - (816 / 1056)) < 0.01,
    mm.pageW + 'x' + mm.pageH);
  check('page scaled to fit phone width', mm.pageW <= mm.viewW + 1,
    'pageW=' + Math.round(mm.pageW) + ' viewW=' + mm.viewW);
  check('zoom is a sane fit value', mm.zoom > 0.1 && mm.zoom <= 1, 'zoom=' + mm.zoom);
  check('canvas scroll height >= page height', mm.scrollH >= mm.pageH - 2,
    'scrollH=' + mm.scrollH + ' pageH=' + Math.round(mm.pageH));

  console.log('\n[3] Desktop chrome present');
  const ribbon = await evaluate('document.querySelectorAll("#ribbon .tb").length');
  check('ribbon toolbar has many controls', ribbon >= 20, 'buttons=' + ribbon);
  const menus = await evaluate('Array.from(document.querySelectorAll(".menu-item")).map(e=>e.textContent).join(",")');
  check('desktop menu bar (File/Edit/View/Insert/Format)', menus === 'File,Edit,View,Insert,Format', menus);
  const rulerVisible = await evaluate('getComputedStyle(document.getElementById("rulerWrap")).display !== "none"');
  check('ruler visible by default', rulerVisible === true);
  const statusVisible = await evaluate('!!document.getElementById("statusbar").offsetHeight || getComputedStyle(document.getElementById("statusbar")).display!=="none"');
  check('status bar present', statusVisible === true);

  console.log('\n[4] Editing inside device WebView');
  const typed = await evaluate(`(function(){
    var c = document.getElementById('content');
    c.innerHTML = '<p>Device test paragraph</p>';
    window.__editor.paginate();
    var p = c.querySelector('p');
    var r = document.createRange();
    r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 6);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    window.__editor.state.savedRange = r.cloneRange();
    window.__editor.exec('bold');
    return c.innerHTML;
  })()`);
  check('bold command works on device', /<b>|<strong>|font-weight/i.test(typed), typed);

  const paged = await evaluate(`(function(){
    var c = document.getElementById('content');
    var h = '';
    for (var i=0;i<9;i++) h += '<p data-h="200" style="height:200px">block '+i+'</p>';
    c.innerHTML = h;
    window.__editor.paginate();
    return window.__editor.pageCount();
  })()`);
  check('pagination produces multiple real pages on device', paged >= 2, 'pages=' + paged);

  console.log('\n[5] Storage round-trip on device');
  const stored = await evaluate(`(function(){
    window.__editor.saveNow();
    return window.AndroidHost.getStore('dc.docs') ? 'ok' : 'null';
  })()`);
  check('document persisted through native bridge', stored === 'ok', stored);

  console.log('\n[6] DOCX export on device');
  const docx = await evaluate(`(function(){
    var c = document.getElementById('content');
    c.innerHTML = '<h1>Device Export</h1><p>Hello <b>bold</b></p>';
    window.__editor.paginate();
    var ex = window.__editor.buildExport('docx');
    var b = ex.data;
    return JSON.stringify({name: ex.name, len: b.length, sig: [b[0],b[1],b[b.length-22],b[b.length-21]]});
  })()`);
  console.log('  docx: ' + docx);
  const dj = JSON.parse(docx);
  check('docx built on device', dj.len > 500, 'len=' + dj.len);
  check('docx has PK signature on device', dj.sig[0] === 80 && dj.sig[1] === 75, JSON.stringify(dj.sig));
  check('docx has EOCD on device', dj.sig[2] === 80 && dj.sig[3] === 75, JSON.stringify(dj.sig));

  console.log('\n[7] No runtime errors');
  const errs = await evaluate(`(function(){
    return (window.__errs||[]).length;
  })()`);
  check('no captured engine errors', errs === 0, 'errs=' + errs);

  console.log('\n=== device: ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('PROBE ERROR: ' + e.message); process.exit(2); });
