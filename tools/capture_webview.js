/**
 * Captures the editor's actual rendered pixels straight from the WebView
 * via CDP Page.captureScreenshot — independent of the emulator's compositor
 * (which ANRs under memory pressure and shows system dialogs instead).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '9222', 10);
const OUT = process.argv[3] || path.join(__dirname, '..', 'build-test', 'webview.png');

function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const targets = await getJSON('/json');
  const page = targets.find(t => t.type === 'page' && t.url.indexOf('editor') !== -1);
  if (!page) { console.log('NO_EDITOR_PAGE'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 20000);
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });

  await send('Page.enable');

  // Make sure the app is foregrounded and the editor has content to show
  await send('Runtime.evaluate', {
    expression: `(function(){
      var c = document.getElementById('content');
      if (!c || !c.innerText.trim()) {
        c.innerHTML = '<h1>Project Notes</h1>' +
          '<p>This document is rendered with <b>real page layout</b> — a US Letter sheet ' +
          'at 816x1056 CSS px with 96px margins, exactly like the desktop web editor.</p>' +
          '<h2>Formatting</h2>' +
          '<ul><li><b>Bold</b>, <i>italic</i>, <u>underline</u></li>' +
          '<li>Headings, lists, quotes</li></ul>' +
          '<blockquote>Print layout is the default here, so there is no menu to hunt through.</blockquote>' +
          '<p>Word count, page number and zoom all update live in the status bar.</p>';
        if (window.__editor) window.__editor.paginate();
      }
      return 'ok';
    })()`, returnByValue: true
  });
  await new Promise(r => setTimeout(r, 900));

  // Capture only the visible viewport at 2x for legibility
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('wrote ' + OUT + ' (' + Buffer.from(shot.data, 'base64').length + ' bytes)');

  // Also capture the full page (entire scrollable document)
  try {
    const metrics = await send('Page.getLayoutMetrics');
    const cs = metrics.cssContentSize || metrics.contentSize;
    const full = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.round(cs.width), height: Math.min(3000, Math.round(cs.height)), scale: 1 }
    });
    const OUT2 = OUT.replace(/\.png$/, '_full.png');
    fs.writeFileSync(OUT2, Buffer.from(full.data, 'base64'));
    console.log('wrote ' + OUT2 + ' (' + Buffer.from(full.data, 'base64').length + ' bytes) contentSize=' + cs.width + 'x' + cs.height);
  } catch (e) { console.log('full capture skipped: ' + e.message); }

  ws.close();
  process.exit(0);
})().catch(e => { console.log('CAPTURE ERROR: ' + e.message); process.exit(2); });
