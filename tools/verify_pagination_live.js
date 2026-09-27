/**
 * Measures REAL pagination geometry in a real browser (headless Chrome).
 * Vision can be fooled by a scroll position; these assertions cannot:
 *  - page sheets are spaced exactly PAGE_H + GAP apart
 *  - a visible gray gap exists between consecutive sheets
 *  - NO content block straddles a page's content boundary
 *  - every block sits inside its own page's printable area
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const PORT = 9344;
const EDITOR = 'file:///C:/devdocs/app/src/main/assets/editor/index.html';

const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
const check = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL  ' + n + (x ? ' :: ' + x : '')); } };

(async () => {
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--window-size=412,915',
    '--user-data-dir=' + path.join(__dirname, '..', 'build-test', 'chrome-prof2'),
    EDITOR
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try { target = (await getJSON('/json')).find(t => t.type === 'page' && t.url.indexOf('editor') !== -1); if (target) break; } catch (e) {}
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
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  await send('Runtime.enable');

  for (let i = 0; i < 40; i++) {
    try { const r = await send('Runtime.evaluate', { expression: '!!window.__editor', returnByValue: true }); if (r.result.value) break; } catch (e) {}
    await sleep(300);
  }
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  console.log('\n=== Live pagination geometry (headless Chrome) ===\n');

  // Use 100% zoom so geometry is unscaled and directly comparable to the page model
  await evalJs(`window.__editor.setZoom(1); 'ok'`);

  // Build a document guaranteed to span several pages: 30 blocks x 120px
  await evalJs(`(function(){
    var c = document.getElementById('content');
    var h = '';
    for (var i = 0; i < 30; i++) {
      h += '<p style="height:120px;margin:0 0 10px">block ' + i + '</p>';
    }
    c.innerHTML = h;
    window.__editor.paginate();
    return 'ok';
  })()`);
  await sleep(600);

  const geo = await evalJs(`(function(){
    var content = document.getElementById('content');
    var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
    var P = 816, H = 1056, GAP = 26, FLOW = H + GAP, MY = 96;
    var pageRects = pages.map(function(p){
      var r = p.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, width: r.width };
    });
    // blocks = direct children that are not spacers
    var blocks = Array.prototype.slice.call(content.children).filter(function(el){
      return !el.classList.contains('pgbreak');
    });
    var spacers = Array.prototype.slice.call(content.querySelectorAll('.pgbreak'));
    var cRect = content.getBoundingClientRect();
    // content boundary of each page in viewport coords
    var boundaries = pages.map(function(_, i){
      return { pageTop: cRect.top + i*FLOW, contentTop: cRect.top + i*FLOW + MY, contentBottom: cRect.top + i*FLOW + MY + (H - 2*MY) };
    });
    var straddles = [];
    blocks.forEach(function(b){
      var r = b.getBoundingClientRect();
      boundaries.forEach(function(bd, i){
        // a block straddles if it starts on page i and ends past that page's content bottom
        if (r.top >= bd.contentTop - 1 && r.top < bd.contentBottom - 1 && r.bottom > bd.contentBottom + 1) {
          straddles.push({ text: (b.textContent||'').slice(0,20), top: Math.round(r.top), bottom: Math.round(r.bottom), page: i });
        }
      });
    });
    return JSON.stringify({
      pageCount: pages.length,
      pageRects: pageRects.map(function(r){ return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }; }),
      spacerCount: spacers.length,
      spacerHeights: spacers.map(function(s){ return Math.round(parseFloat(s.style.height)); }),
      straddleCount: straddles.length,
      straddles: straddles.slice(0, 5),
      zoom: window.__editor.state.zoom
    });
  })()`);

  const g = JSON.parse(geo);
  console.log('  pages=' + g.pageCount + ' spacers=' + g.spacerCount + ' straddles=' + g.straddleCount + ' zoom=' + g.zoom);
  console.log('  page rects: ' + JSON.stringify(g.pageRects.slice(0, 4)));
  console.log('  spacer heights: ' + JSON.stringify(g.spacerHeights.slice(0, 6)));

  const FLOW = 1056 + 26;
  check('document spans multiple pages', g.pageCount >= 3, 'pages=' + g.pageCount);
  check('page height is exactly 1056px at 100% zoom', g.pageRects.every(r => Math.abs(r.height - 1056) <= 1), JSON.stringify(g.pageRects.map(r => r.height)));
  check('page width is exactly 816px at 100% zoom', g.pageRects.every(r => Math.abs(r.width - 816) <= 1), JSON.stringify(g.pageRects.map(r => r.width)));

  // consecutive page spacing must equal PAGE_H + GAP (i.e. a 26px visible gutter)
  let spacingOk = true, spacings = [];
  for (let i = 1; i < g.pageRects.length; i++) {
    const d = g.pageRects[i].top - g.pageRects[i - 1].top;
    spacings.push(d);
    if (Math.abs(d - FLOW) > 1.5) spacingOk = false;
  }
  check('pages spaced PAGE_H+GAP apart (visible gutter)', spacingOk, 'spacings=' + JSON.stringify(spacings));
  check('gutter is a real 26px gap between sheets',
    g.pageRects.length < 2 || Math.abs((g.pageRects[1].top - g.pageRects[0].bottom) - 26) <= 1.5,
    g.pageRects.length > 1 ? 'gap=' + (g.pageRects[1].top - g.pageRects[0].bottom) : 'n/a');

  check('page-break spacers created', g.spacerCount >= 2, 'spacers=' + g.spacerCount);
  check('no content block straddles a page boundary', g.straddleCount === 0, JSON.stringify(g.straddles));
  check('spacer heights are positive', g.spacerHeights.every(h => h > 0), JSON.stringify(g.spacerHeights));

  // Verify each block lies fully within SOME page's printable area
  const containment = await evalJs(`(function(){
    var content = document.getElementById('content');
    var H=1056, GAP=26, FLOW=H+GAP, MY=96, USABLE=H-2*MY;
    var cRect = content.getBoundingClientRect();
    var blocks = Array.prototype.slice.call(content.children).filter(function(el){return !el.classList.contains('pgbreak');});
    var bad = [];
    blocks.forEach(function(b){
      var r = b.getBoundingClientRect();
      var relTop = r.top - cRect.top;
      var relBottom = r.bottom - cRect.top;
      // find which page it should belong to
      var page = Math.floor(relTop / FLOW);
      var cTop = page*FLOW + MY;
      var cBot = cTop + USABLE;
      // allow block to start at/after content top and end at/before content bottom
      if (relTop < cTop - 1.5 || relBottom > cBot + 1.5) {
        bad.push({ t:(b.textContent||'').slice(0,14), relTop:Math.round(relTop), relBottom:Math.round(relBottom), cTop:Math.round(cTop), cBot:Math.round(cBot) });
      }
    });
    return JSON.stringify(bad.slice(0,6));
  })()`);
  const bad = JSON.parse(containment);
  check('every block fits inside its page printable area', bad.length === 0, JSON.stringify(bad));

  // Content must not overflow the last page sheet
  const overflow = await evalJs(`(function(){
    var content = document.getElementById('content');
    var pages = document.querySelectorAll('.page');
    var last = pages[pages.length-1].getBoundingClientRect();
    var cRect = content.getBoundingClientRect();
    var lastChild = null;
    for (var i = content.children.length-1; i>=0; i--) { if(!content.children[i].classList.contains('pgbreak')) { lastChild = content.children[i]; break; } }
    var lr = lastChild.getBoundingClientRect();
    return JSON.stringify({ lastPageBottom: Math.round(last.bottom), contentBottom: Math.round(lr.bottom), overflow: Math.round(lr.bottom - last.bottom) });
  })()`);
  const ov = JSON.parse(overflow);
  console.log('  overflow check: ' + overflow);
  check('content does not spill past the last page sheet', ov.overflow <= 2, 'overflow=' + ov.overflow + 'px');

  // Now verify the same at fit-to-width zoom (the phone default)
  await evalJs(`window.__editor.fitWidth(); 'ok'`);
  await sleep(500);
  const gzRaw = await evalJs(`(function(){
    var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
    var FLOW = (1056+26) * window.__editor.state.zoom;
    var d = [];
    for (var i=1;i<pages.length;i++){
      d.push(Math.round((pages[i].getBoundingClientRect().top - pages[i-1].getBoundingClientRect().top) - FLOW));
    }
    return JSON.stringify({ zoom: window.__editor.state.zoom, deltas: d, pages: pages.length });
  })()`);
  const gz = JSON.parse(gzRaw);
  console.log('  at fit zoom: ' + JSON.stringify(gz));
  check('gutter scales correctly with zoom', gz.deltas.every(d => Math.abs(d) <= 2), JSON.stringify(gz.deltas));

  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail) { console.log('Failures:'); failures.forEach(f => console.log('  - ' + f)); }
  ws.close(); proc.kill();
  await sleep(300);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR: ' + e.message); process.exit(2); });
