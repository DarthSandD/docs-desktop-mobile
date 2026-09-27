/* ============================================================================
   Docs Clone — desktop-class paged editor engine for mobile
   ----------------------------------------------------------------------------
   Architecture
     • One continuous contenteditable region for text (native caret/IME/selection)
     • Real page sheets drawn behind it at Letter size (816x1056 @96dpi)
     • True pagination: blocks that would straddle a page boundary get pushed to
       the next page via non-editable spacer elements (stripped on save)
     • Pinch-zoom + fit-to-width over a transform-scaled canvas
     • Desktop keyboard shortcuts, ruler, status bar, find, multi-doc storage
   ========================================================================== */
(function () {
'use strict';

/* ----------------------------- constants -------------------------------- */
var PAGE_W = 816, PAGE_H = 1056, GAP = 26;
var MARGIN_X = 96, MARGIN_Y = 96;
var FLOW = PAGE_H + GAP;            // vertical period between page tops
var USABLE = PAGE_H - MARGIN_Y * 2; // content height inside one page
var MIN_ZOOM = 0.25, MAX_ZOOM = 3;
var LS_DOCS = 'dc.docs', LS_CUR = 'dc.current';

/* ----------------------------- element refs ----------------------------- */
var $ = function (id) { return document.getElementById(id); };
var content, pagesEl, stack, scaler, canvas, rulerCanvas, zoomSpacer;
var docTitle, saveState, snackEl;

var state = {
  zoom: 1,
  offsetX: 0,
  docId: null,
  docs: [],
  pageless: false,
  textColor: '#000000',
  hlColor: '#ffff00',
  savedRange: null,
  lastSize: 11,
  history: [],
  hIndex: -1,
  hLock: false,
  findHits: [],
  findIdx: -1,
  findQuery: ''
};

/* ============================================================================
   Native bridge / storage
   ========================================================================== */
var HOST = window.AndroidHost || null;

var store = {
  get: function (k) {
    try { if (HOST) return HOST.getStore(k); } catch (e) {}
    try { return localStorage.getItem(k); } catch (e) { return null; }
  },
  set: function (k, v) {
    try { if (HOST) { HOST.setStore(k, v); return; } } catch (e) {}
    try { localStorage.setItem(k, v); } catch (e) {}
  },
  del: function (k) {
    try { if (HOST) { HOST.removeStore(k); return; } } catch (e) {}
    try { localStorage.removeItem(k); } catch (e) {}
  }
};

function haptic(ms) { try { if (HOST) HOST.haptic(ms || 8); } catch (e) {} }
function toast(msg) {
  if (!snackEl) return;
  snackEl.textContent = msg;
  snackEl.classList.remove('hidden');
  requestAnimationFrame(function () { snackEl.classList.add('show'); });
  clearTimeout(toast._t);
  toast._t = setTimeout(function () {
    snackEl.classList.remove('show');
    setTimeout(function () { snackEl.classList.add('hidden'); }, 220);
  }, 1900);
}

/* ============================================================================
   Modal prompt (window.prompt is unreliable inside WebView)
   ========================================================================== */
function modalPrompt(title, value, cb) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(32,33,36,.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:22px;animation:popIn .15s ease';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--page);color:var(--ink);border-radius:12px;padding:18px;width:100%;max-width:380px;box-shadow:0 10px 40px rgba(0,0,0,.4)';
  box.innerHTML = '<div style="font-size:16px;font-weight:500;margin-bottom:12px">' + title + '</div>';
  var inp = document.createElement('input');
  inp.value = value || '';
  inp.style.cssText = 'width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--grey-line);border-radius:8px;background:transparent;color:var(--ink);outline:none;font-family:inherit';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
  var cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'border:none;background:none;color:var(--blue);font-size:14px;font-weight:500;padding:8px 14px;border-radius:6px;font-family:inherit';
  var ok = document.createElement('button');
  ok.textContent = 'OK';
  ok.style.cssText = 'border:none;background:var(--blue);color:#fff;font-size:14px;font-weight:500;padding:8px 18px;border-radius:6px;font-family:inherit';
  row.appendChild(cancel); row.appendChild(ok);
  box.appendChild(inp); box.appendChild(row); wrap.appendChild(box);
  document.body.appendChild(wrap);
  setTimeout(function () { inp.focus(); inp.select(); }, 60);
  function close() { wrap.remove(); }
  cancel.onclick = close;
  ok.onclick = function () { var v = inp.value; close(); cb(v); };
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var v = inp.value; close(); cb(v); }
    if (e.key === 'Escape') close();
  });
}

function modalConfirm(title, cb) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(32,33,36,.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:22px;animation:popIn .15s ease';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--page);color:var(--ink);border-radius:12px;padding:18px;width:100%;max-width:340px;box-shadow:0 10px 40px rgba(0,0,0,.4)';
  box.innerHTML = '<div style="font-size:15.5px;line-height:1.4">' + title + '</div>';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px';
  var cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'border:none;background:none;color:var(--blue);font-size:14px;font-weight:500;padding:8px 14px;border-radius:6px;font-family:inherit';
  var ok = document.createElement('button');
  ok.textContent = 'OK';
  ok.style.cssText = 'border:none;background:var(--blue);color:#fff;font-size:14px;font-weight:500;padding:8px 18px;border-radius:6px;font-family:inherit';
  row.appendChild(cancel); row.appendChild(ok);
  box.appendChild(row); wrap.appendChild(box);
  document.body.appendChild(wrap);
  cancel.onclick = function () { wrap.remove(); };
  ok.onclick = function () { wrap.remove(); cb(true); };
}

/* ============================================================================
   Selection bookkeeping — toolbar taps must not lose the caret
   ========================================================================== */
function saveSelection() {
  var sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  var r = sel.getRangeAt(0);
  if (content.contains(r.commonAncestorContainer)) state.savedRange = r.cloneRange();
}
function restoreSelection() {
  if (!state.savedRange) return false;
  var sel = window.getSelection();
  sel.removeAllRanges();
  try { sel.addRange(state.savedRange); } catch (e) { return false; }
  return true;
}
function focusContent() {
  if (document.activeElement !== content) content.focus({ preventScroll: true });
}

/* ============================================================================
   Command execution (execCommand + custom spans)
   ========================================================================== */
function exec(cmd, val) {
  focusContent();
  restoreSelection();
  try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
  try { document.execCommand(cmd, false, val === undefined ? null : val); } catch (e) {}
  syncToolbar();
  schedulePaginate();
  scheduleSave();
  pushHistory();
}

function wrapSelectionWithStyle(styles) {
  focusContent();
  if (!restoreSelection()) return;
  var sel = window.getSelection();
  if (!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  var span = document.createElement('span');
  Object.keys(styles).forEach(function (k) { span.style[k] = styles[k]; });

  if (range.collapsed) {
    // no selection: remember and apply on next typed chars
    pendingSpan = span;
    return;
  }
  try {
    range.surroundContents(span);
  } catch (e) {
    try {
      var frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    } catch (e2) { return; }
  }
  sel.removeAllRanges();
  var r2 = document.createRange();
  r2.selectNodeContents(span);
  sel.addRange(r2);
  state.savedRange = r2.cloneRange();
  schedulePaginate();
  scheduleSave();
  pushHistory();
}
var pendingSpan = null;

/* ============================================================================
   Pagination — the heart of the "desktop page" illusion
   ========================================================================== */
var paginateTimer = null;
function schedulePaginate() {
  clearTimeout(paginateTimer);
  paginateTimer = setTimeout(paginate, 180);
}

function makeMarker() {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  var r = sel.getRangeAt(0);
  if (!content.contains(r.commonAncestorContainer)) return null;
  var m = document.createElement('span');
  m.setAttribute('data-caret-marker', '1');
  m.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
  try {
    var rc = r.cloneRange();
    rc.collapse(true);
    rc.insertNode(m);
    return m;
  } catch (e) { return null; }
}

function restoreMarker(m) {
  if (!m || !m.parentNode) return;
  try {
    var sel = window.getSelection();
    var r = document.createRange();
    r.setStartAfter(m);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    state.savedRange = r.cloneRange();
  } catch (e) {}
  m.remove();
}

function clearSpacers() {
  var old = content.querySelectorAll('.pgbreak');
  for (var i = 0; i < old.length; i++) old[i].remove();
}

function paginate() {
  if (state.pageless) { paginateFlat(); return; }
  var marker = makeMarker();
  clearSpacers();

  var contentRect = content.getBoundingClientRect();
  var z = state.zoom || 1;

  // ---- Measure natural geometry FIRST (no spacers present yet) -----------
  // getBoundingClientRect().height EXCLUDES margins, so a block's true flow
  // extent runs to the next block's top. Using the raw height would let
  // margin-sized overflow accumulate and straddle page boundaries.
  var blocks = [];
  var kids = Array.prototype.slice.call(content.children);
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    if (el.classList && el.classList.contains('pgbreak')) continue;
    var r = el.getBoundingClientRect();
    blocks.push({
      el: el,
      top: (r.top - contentRect.top) / z,
      bottom: (r.bottom - contentRect.top) / z
    });
  }
  for (var i2 = 0; i2 < blocks.length; i2++) {
    var effBottom = blocks[i2].bottom;
    if (i2 + 1 < blocks.length) effBottom = Math.max(effBottom, blocks[i2 + 1].top);
    blocks[i2].effH = Math.max(0, effBottom - blocks[i2].top);
  }

  // ---- Place blocks, inserting spacers to push overflow to the next page --
  var shift = 0;
  var maxPage = 0;
  for (var b = 0; b < blocks.length; b++) {
    var blk = blocks[b];
    var top = blk.top + shift;
    var h = blk.effH;
    var page = Math.floor(top / FLOW);
    var cTop = page * FLOW + MARGIN_Y;
    var cBot = cTop + USABLE;

    // Only push blocks that can fit on a page, and that are not already
    // sitting at the top of one (otherwise a tall block would push forever).
    if (h <= USABLE && (top + h) > cBot + 0.5 && top > cTop + 0.5) {
      var nextCTop = (page + 1) * FLOW + MARGIN_Y;
      var spacerH = nextCTop - top;
      if (spacerH > 0.5) {
        var sp = document.createElement('div');
        sp.className = 'pgbreak';
        sp.setAttribute('contenteditable', 'false');
        sp.style.height = spacerH + 'px';
        content.insertBefore(sp, blk.el);
        shift += spacerH;
        top += spacerH;
        page = Math.floor(top / FLOW);
      }
    }

    // Track how far the document actually reaches (handles oversized blocks
    // that legitimately span more than one page).
    var endPage = Math.floor((top + Math.max(h, 1) - 0.5) / FLOW);
    if (endPage > maxPage) maxPage = endPage;
    if (page > maxPage) maxPage = page;
  }

  var totalPages = Math.max(1, maxPage + 1);
  var stackH = totalPages * PAGE_H + (totalPages - 1) * GAP;

  // Rebuild page sheets
  var need = totalPages;
  var have = pagesEl.children.length;
  if (have !== need) {
    pagesEl.innerHTML = '';
    for (var p = 0; p < need; p++) {
      var d = document.createElement('div');
      d.className = 'page';
      d.style.top = (p * FLOW) + 'px';
      pagesEl.appendChild(d);
    }
  }

  stack.style.height = stackH + 'px';
  content.style.minHeight = stackH + 'px';

  restoreMarker(marker);
  updateStatus(totalPages);
  applyZoomLayout();
  drawRuler();
}

function paginateFlat() {
  clearSpacers();
  var h = Math.max(content.scrollHeight, PAGE_H);
  stack.style.height = h + 'px';
  content.style.minHeight = h + 'px';
  pagesEl.innerHTML = '<div class="page" style="top:0;height:' + h + 'px"></div>';
  updateStatus(1);
  applyZoomLayout();
  drawRuler();
}

function updateStatus(totalPages) {
  var txt = content.innerText || '';
  var words = txt.trim() ? txt.trim().split(/\s+/).length : 0;
  $('wordInfo').textContent = words + (words === 1 ? ' word' : ' words');
  $('charInfo').textContent = txt.replace(/\n/g, '').length + ' characters';
  if (!state.pageless) {
    var caretPage = 1;
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0);
      var probe = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
      if (content.contains(probe)) {
        var y = probe.getBoundingClientRect().top - content.getBoundingClientRect().top;
        y /= state.zoom;
        caretPage = Math.min(totalPages, Math.max(1, Math.floor(y / FLOW) + 1));
      }
    }
    $('pageInfo').textContent = 'Page ' + caretPage + ' of ' + totalPages;
  } else {
    $('pageInfo').textContent = 'Pageless';
  }
}

/* ============================================================================
   Zoom & layout
   ========================================================================== */
function applyZoomLayout() {
  var z = state.zoom;
  var stackH = parseFloat(stack.style.height) || PAGE_H;
  var scaledW = PAGE_W * z, scaledH = stackH * z;

  scaler.style.transform = 'scale(' + z + ')';

  // Guarantee correct scroll extents regardless of transform-overflow behaviour
  if (!zoomSpacer) {
    zoomSpacer = document.createElement('div');
    zoomSpacer.id = 'zoomSpacer';
    zoomSpacer.style.cssText = 'position:relative;pointer-events:none';
    canvas.appendChild(zoomSpacer);
  }
  zoomSpacer.style.width = scaledW + 'px';
  zoomSpacer.style.height = scaledH + 'px';

  var avail = canvas.clientWidth;
  state.offsetX = scaledW < avail ? Math.round((avail - scaledW) / 2) : 0;
  scaler.style.left = state.offsetX + 'px';

  $('zoomInfo').textContent = Math.round(z * 100) + '%';
  $('zoomLabel').textContent = Math.round(z * 100) + '%';
}

function setZoom(z, opts) {
  opts = opts || {};
  z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  var prev = state.zoom;
  var prevOffset = state.offsetX;

  // focal point in unscaled content coordinates
  var focal = opts.focal || { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
  var sx = opts.startScroll ? opts.startScroll.x : canvas.scrollLeft;
  var sy = opts.startScroll ? opts.startScroll.y : canvas.scrollTop;
  var sz = opts.startZoom || prev;
  var so = opts.startOffset !== undefined ? opts.startOffset : prevOffset;

  state.zoom = z;
  applyZoomLayout();

  if (opts.focal || opts.startScroll) {
    var ux = (sx + focal.x - so) / sz;
    var uy = (sy + focal.y) / sz;
    canvas.scrollLeft = ux * z + state.offsetX - focal.x;
    canvas.scrollTop = uy * z - focal.y;
  } else if (opts.center) {
    canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) / 2;
  }
  drawRuler();
}

function fitWidth() {
  var avail = canvas.clientWidth - 20;
  setZoom(avail / PAGE_W);
}

/* ------------------------------ pinch zoom ------------------------------- */
function touchDist(t) {
  var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
var pinch = null, lastTap = 0;

function initGestures() {
  canvas.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      var r = canvas.getBoundingClientRect();
      pinch = {
        d: touchDist(e.touches),
        z: state.zoom,
        o: state.offsetX,
        sx: canvas.scrollLeft,
        sy: canvas.scrollTop,
        focal: {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top
        }
      };
    } else if (e.touches.length === 1) {
      var now = Date.now();
      if (now - lastTap < 300) {
        // double tap toggles fit <-> 100%
        if (Math.abs(state.zoom - 1) < 0.02) fitWidth(); else setZoom(1, { center: true });
        haptic(10);
        lastTap = 0;
        pinch = null;
      } else lastTap = now;
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', function (e) {
    if (pinch && e.touches.length === 2) {
      if (e.cancelable) e.preventDefault();
      var d = touchDist(e.touches);
      var z = pinch.z * (d / pinch.d);
      setZoom(z, {
        focal: pinch.focal, startScroll: { x: pinch.sx, y: pinch.sy },
        startZoom: pinch.z, startOffset: pinch.o
      });
    }
  }, { passive: false });

  canvas.addEventListener('touchend', function (e) {
    if (e.touches.length < 2) pinch = null;
  }, { passive: true });
}

/* ============================================================================
   Ruler
   ========================================================================== */
function drawRuler() {
  if (!rulerCanvas) return;
  var ctx;
  try { ctx = rulerCanvas.getContext('2d'); } catch (e) { return; }
  if (!ctx) return;
  var dpr = window.devicePixelRatio || 1;
  var w = window.innerWidth, h = 26;
  rulerCanvas.width = w * dpr;
  rulerCanvas.height = h * dpr;
  rulerCanvas.style.width = w + 'px';
  rulerCanvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  var dark = document.body.classList.contains('dark');
  ctx.strokeStyle = dark ? '#5f6368' : '#9aa0a6';
  ctx.fillStyle = dark ? '#9aa0a6' : '#5f6368';
  ctx.font = '9px Roboto, Arial, sans-serif';
  ctx.textBaseline = 'top';

  var z = state.zoom;
  var pageLeft = state.offsetX - canvas.scrollLeft;
  var pxPerInch = 96 * z;
  var pxPerEighth = pxPerInch / 8;

  // baseline
  ctx.beginPath();
  ctx.moveTo(0, h - 1);
  ctx.lineTo(w, h - 1);
  ctx.stroke();

  if (pxPerEighth < 2) return;
  var startX = pageLeft;
  var i = 0;
  var limit = w + pxPerInch;
  while (true) {
    var x = startX + i * pxPerEighth;
    if (x > limit) break;
    if (x >= -4) {
      var inch = i / 8;
      var isInch = (i % 8 === 0);
      var isHalf = (i % 4 === 0);
      var tickH = isInch ? 9 : (isHalf ? 6 : 4);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, h - 1);
      ctx.lineTo(Math.round(x) + 0.5, h - 1 - tickH);
      ctx.stroke();
      if (isInch && inch > 0) {
        ctx.fillText(String(Math.round(inch)), Math.round(x) + 2, 2);
      }
    }
    i++;
    if (i > 4000) break;
  }

  // margin shading aligned to the page
  var lm = document.querySelector('.ruler-margin.left');
  var rm = document.querySelector('.ruler-margin.right');
  if (lm && rm) {
    var mw = MARGIN_X * z;
    lm.style.left = Math.max(0, pageLeft) + 'px';
    lm.style.width = mw + 'px';
    var rightEdge = pageLeft + PAGE_W * z;
    rm.style.left = (rightEdge - mw) + 'px';
    rm.style.width = mw + 'px';
    rm.style.right = 'auto';
  }
}

/* ============================================================================
   Formatting state reflection (active button highlights)
   ========================================================================== */
function q(cmd) { try { return document.queryCommandState(cmd); } catch (e) { return false; } }

function syncToolbar() {
  $('tbBold').classList.toggle('active', q('bold'));
  $('tbItalic').classList.toggle('active', q('italic'));
  $('tbUnderline').classList.toggle('active', q('underline'));
  $('tbStrike').classList.toggle('active', q('strikeThrough'));
  $('tbBullets').classList.toggle('active', q('insertUnorderedList'));
  $('tbNumbers').classList.toggle('active', q('insertOrderedList'));
  $('tbAlignLeft').classList.toggle('active', q('justifyLeft'));
  $('tbAlignCenter').classList.toggle('active', q('justifyCenter'));
  $('tbAlignRight').classList.toggle('active', q('justifyRight'));
  $('tbAlignJustify').classList.toggle('active', q('justifyFull'));

  var block = currentBlock();
  if (block) {
    var tag = block.tagName.toLowerCase();
    var ss = $('styleSelect');
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'blockquote' || tag === 'pre') ss.value = tag;
    else ss.value = 'p';
    var ff = getComputedStyle(block).fontFamily;
    if (ff) {
      var fs = $('fontSelect');
      for (var i = 0; i < fs.options.length; i++) {
        var v = fs.options[i].value.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
        if (ff.toLowerCase().indexOf(v) !== -1) { fs.value = fs.options[i].value; break; }
      }
    }
  }
}

function currentBlock() {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  var n = sel.getRangeAt(0).startContainer;
  if (n.nodeType === 3) n = n.parentNode;
  while (n && n !== content) {
    if (/^(P|H1|H2|H3|BLOCKQUOTE|PRE|LI|DIV|TD|TH)$/.test(n.tagName)) return n;
    n = n.parentNode;
  }
  return null;
}

/* ============================================================================
   History (snapshot based — our DOM surgery would pollute execCommand undo)
   ========================================================================== */
function snapshot() {
  return serialize(true);
}
function pushHistory() {
  if (state.hLock) return;
  var snap = snapshot();
  if (state.history[state.hIndex] === snap) return;
  state.history = state.history.slice(0, state.hIndex + 1);
  state.history.push(snap);
  if (state.history.length > 60) state.history.shift();
  state.hIndex = state.history.length - 1;
}
function undo() {
  if (state.hIndex <= 0) { toast('Nothing to undo'); return; }
  state.hIndex--;
  applySnapshot(state.history[state.hIndex]);
  haptic(8);
}
function redo() {
  if (state.hIndex >= state.history.length - 1) { toast('Nothing to redo'); return; }
  state.hIndex++;
  applySnapshot(state.history[state.hIndex]);
  haptic(8);
}
function applySnapshot(html) {
  state.hLock = true;
  content.innerHTML = html;
  paginate();
  scheduleSave();
  state.hLock = false;
}

/* ============================================================================
   Serialize / load
   ========================================================================== */
function unwrapMarks(root) {
  var marks = root.querySelectorAll('mark.find-hit');
  for (var i = 0; i < marks.length; i++) {
    var m = marks[i];
    while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
    m.remove();
  }
}
function serialize(keepMarkers) {
  var clone = content.cloneNode(true);
  var sp = clone.querySelectorAll('.pgbreak');
  for (var i = 0; i < sp.length; i++) sp[i].remove();
  if (!keepMarkers) unwrapMarks(clone);
  else unwrapMarks(clone);
  var mm = clone.querySelectorAll('[data-caret-marker]');
  for (var j = 0; j < mm.length; j++) mm[j].remove();
  return clone.innerHTML;
}

function docRecord() {
  return { id: state.docId, title: docTitle.value || 'Untitled document', html: serialize(false), updated: Date.now() };
}
function scheduleSave() {
  saveState.textContent = 'Saving…';
  clearTimeout(scheduleSave._t);
  scheduleSave._t = setTimeout(saveNow, 550);
}
function saveNow() {
  var rec = docRecord();
  var idx = -1;
  for (var i = 0; i < state.docs.length; i++) if (state.docs[i].id === rec.id) idx = i;
  if (idx >= 0) state.docs[idx] = rec; else state.docs.unshift(rec);
  state.docs.sort(function (a, b) { return b.updated - a.updated; });
  if (state.docs.length > 30) state.docs.length = 30;
  store.set(LS_DOCS, JSON.stringify(state.docs));
  store.set(LS_CUR, rec.id);
  saveState.textContent = 'Saved';
}

function loadDocs() {
  try { state.docs = JSON.parse(store.get(LS_DOCS) || '[]') || []; } catch (e) { state.docs = []; }
  var cur = store.get(LS_CUR);
  var rec = null;
  for (var i = 0; i < state.docs.length; i++) if (state.docs[i].id === cur) rec = state.docs[i];
  if (!rec && state.docs.length) rec = state.docs[0];
  if (!rec) {
    rec = { id: 'd' + Date.now(), title: 'Untitled document', html: '', updated: Date.now() };
    state.docs.unshift(rec);
  }
  openDoc(rec);
}

function openDoc(rec) {
  state.docId = rec.id;
  docTitle.value = rec.title;
  content.innerHTML = rec.html || '';
  state.history = [serialize(true)];
  state.hIndex = 0;
  paginate();
  updateStatus(1);
}

function newDoc() {
  saveNow();
  var rec = { id: 'd' + Date.now(), title: 'Untitled document', html: '', updated: Date.now() };
  state.docs.unshift(rec);
  openDoc(rec);
  saveNow();
  focusContent();
  toast('New document created');
}

/* ============================================================================
   Find & replace
   ========================================================================== */
function clearFind() {
  var marks = content.querySelectorAll('mark.find-hit');
  for (var i = 0; i < marks.length; i++) {
    var m = marks[i];
    while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
    m.remove();
  }
  content.normalize();
  state.findHits = [];
  state.findIdx = -1;
}
function doFind(query) {
  clearFind();
  state.findQuery = query;
  if (!query) { $('findCount').textContent = '0/0'; return; }
  var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
  var nodes = [], n;
  while ((n = walker.nextNode())) nodes.push(n);
  var lq = query.toLowerCase();
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var text = node.nodeValue;
    var lt = text.toLowerCase();
    var pos = lt.indexOf(lq);
    while (pos !== -1) {
      var range = document.createRange();
      range.setStart(node, pos);
      range.setEnd(node, pos + query.length);
      var mark = document.createElement('mark');
      mark.className = 'find-hit';
      try { range.surroundContents(mark); } catch (e) { pos = -1; break; }
      state.findHits.push(mark);
      node = mark.nextSibling;
      if (!node || node.nodeType !== 3) break;
      text = node.nodeValue; lt = text.toLowerCase();
      pos = lt.indexOf(lq);
    }
  }
  if (state.findHits.length) { state.findIdx = 0; focusHit(0); }
  $('findCount').textContent = state.findHits.length ? '1/' + state.findHits.length : '0/0';
}
function focusHit(i) {
  if (!state.findHits.length) return;
  for (var k = 0; k < state.findHits.length; k++) state.findHits[k].classList.remove('current');
  var el = state.findHits[i];
  el.classList.add('current');
  var r = document.createRange();
  r.selectNodeContents(el);
  var sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  var y = el.getBoundingClientRect().top + canvas.scrollTop - canvas.getBoundingClientRect().top;
  canvas.scrollTo({ top: y - canvas.clientHeight / 2, behavior: 'smooth' });
  $('findCount').textContent = (i + 1) + '/' + state.findHits.length;
}
function findNext(dir) {
  if (!state.findHits.length) return;
  state.findIdx = (state.findIdx + dir + state.findHits.length) % state.findHits.length;
  focusHit(state.findIdx);
}

/* ============================================================================
   Import / export
   ========================================================================== */
function pickFile() {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.txt,.html,.htm,.md,text/*';
  inp.onchange = function () {
    var f = inp.files && inp.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var text = String(fr.result || '');
      var html;
      if (/\.html?$/i.test(f.name)) html = sanitizeHtml(text);
      else html = textToHtml(text);
      var rec = {
        id: 'd' + Date.now(),
        title: f.name.replace(/\.[^.]+$/, ''),
        html: html, updated: Date.now()
      };
      state.docs.unshift(rec);
      openDoc(rec);
      saveNow();
      toast('Imported ' + f.name);
    };
    fr.readAsText(f);
  };
  inp.click();
}

function textToHtml(text) {
  return text.split(/\r?\n/).map(function (line) {
    var esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + (esc || '<br>') + '</p>';
  }).join('');
}

var ALLOWED = { P:1, BR:1, B:1, I:1, U:1, S:1, STRONG:1, EM:1, SPAN:1, DIV:1,
  H1:1, H2:1, H3:1, UL:1, OL:1, LI:1, BLOCKQUOTE:1, PRE:1, CODE:1, HR:1,
  A:1, TABLE:1, TBODY:1, TR:1, TD:1, TH:1, THEAD:1, MARK:1, SUB:1, SUP:1 };

function sanitizeHtml(html) {
  var doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return textToHtml(html); }
  var body = doc.body;
  // drop scripts/styles
  body.querySelectorAll('script,style,link,meta,iframe,object,embed').forEach(function (n) { n.remove(); });
  (function clean(node) {
    var kids = Array.prototype.slice.call(node.children);
    kids.forEach(function (el) {
      if (!ALLOWED[el.tagName]) {
        // unwrap unknown tags but keep their text
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
        return;
      }
      var attrs = Array.prototype.slice.call(el.attributes);
      attrs.forEach(function (a) {
        var name = a.name.toLowerCase();
        if (name === 'style') return;
        if (el.tagName === 'A' && name === 'href') return;
        el.removeAttribute(a.name);
      });
      if (el.tagName === 'A') { el.setAttribute('rel', 'noopener'); el.setAttribute('target', '_blank'); }
      clean(el);
    });
  })(body);
  return body.innerHTML;
}

function buildExport(format) {
  var title = docTitle.value || 'document';
  var inner = serialize(false);
  if (format === 'txt') {
    return { name: title + '.txt', mime: 'text/plain', data: htmlToText(inner) };
  }
  if (format === 'html') {
    var doc = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + escapeHtml(title) +
      '</title><style>body{font-family:Arial,sans-serif;max-width:816px;margin:40px auto;padding:0 96px;line-height:1.5;color:#202124}' +
      'table{border-collapse:collapse}td,th{border:1px solid #dadce0;padding:6px 8px}</style></head><body>' + inner + '</body></html>';
    return { name: title + '.html', mime: 'text/html', data: doc };
  }
  if (format === 'md') {
    return { name: title + '.md', mime: 'text/markdown', data: htmlToMarkdown(inner) };
  }
  if (format === 'docx') {
    var docx = buildDocx(title, inner);
    return { name: title + '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx };
  }
  return null;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function htmlToText(html) {
  var d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('p,h1,h2,h3,li,blockquote,pre,tr').forEach(function (el) {
    el.appendChild(document.createTextNode('\n'));
  });
  return (d.innerText || d.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
function htmlToMarkdown(html) {
  var d = document.createElement('div');
  d.innerHTML = html;
  function conv(node) {
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      var t = c.tagName;
      var inner = conv(c);
      if (t === 'B' || t === 'STRONG') out += '**' + inner + '**';
      else if (t === 'I' || t === 'EM') out += '*' + inner + '*';
      else if (t === 'U') out += '<u>' + inner + '</u>';
      else if (t === 'S') out += '~~' + inner + '~~';
      else if (t === 'CODE') out += '`' + inner + '`';
      else if (t === 'H1') out += '# ' + inner + '\n\n';
      else if (t === 'H2') out += '## ' + inner + '\n\n';
      else if (t === 'H3') out += '### ' + inner + '\n\n';
      else if (t === 'BLOCKQUOTE') out += '> ' + inner + '\n\n';
      else if (t === 'PRE') out += '```\n' + inner + '\n```\n\n';
      else if (t === 'HR') out += '---\n\n';
      else if (t === 'BR') out += '\n';
      else if (t === 'LI') out += '- ' + inner + '\n';
      else if (t === 'A') out += '[' + inner + '](' + (c.getAttribute('href') || '') + ')';
      else if (t === 'P' || t === 'DIV') out += inner + '\n\n';
      else if (t === 'UL' || t === 'OL' || t === 'TABLE' || t === 'TBODY' || t === 'TR' || t === 'THEAD') out += inner;
      else if (t === 'TD' || t === 'TH') out += inner + ' | ';
      else out += inner;
    }
    return out;
  }
  return conv(d).replace(/\n{3,}/g, '\n\n').trim();
}

/* --- minimal DOCX writer (OOXML zip, no dependencies) --------------------- */
function buildDocx(title, innerHtml) {
  var body = docxBody(innerHtml);
  var files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body + '</w:body></w:document>'
  };
  return zipStore(files);
}

function docxRun(text, fmt) {
  if (text === '') return '';
  var rpr = '';
  if (fmt.b || fmt.i || fmt.u || fmt.strike || fmt.color || fmt.hl) {
    rpr += '<w:rPr>';
    if (fmt.b) rpr += '<w:b/>';
    if (fmt.i) rpr += '<w:i/>';
    if (fmt.u) rpr += '<w:u w:val="single"/>';
    if (fmt.strike) rpr += '<w:strike/>';
    if (fmt.color) rpr += '<w:color w:val="' + fmt.color.replace('#', '').toUpperCase() + '"/>';
    if (fmt.hl) rpr += '<w:highlight w:val="yellow"/>';
    rpr += '</w:rPr>';
  }
  return '<w:r>' + rpr + '<w:t xml:space="preserve">' + escapeHtml(text) + '</w:t></w:r>';
}

function docxInline(node, fmt) {
  var out = '';
  for (var i = 0; i < node.childNodes.length; i++) {
    var c = node.childNodes[i];
    if (c.nodeType === 3) { out += docxRun(c.nodeValue, fmt); continue; }
    if (c.nodeType !== 1) continue;
    var f = Object.assign({}, fmt);
    var t = c.tagName;
    if (t === 'B' || t === 'STRONG') f.b = 1;
    else if (t === 'I' || t === 'EM') f.i = 1;
    else if (t === 'U') f.u = 1;
    else if (t === 'S' || t === 'STRIKE') f.strike = 1;
    else if (t === 'BR') { out += '<w:r><w:br/></w:r>'; continue; }
    if (c.style && c.style.color) {
      var m = c.style.color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (m) f.color = '#' + [m[1], m[2], m[3]].map(function (x) { return (+x).toString(16).padStart(2, '0'); }).join('');
    }
    if (c.style && c.style.backgroundColor && c.style.backgroundColor !== 'transparent') f.hl = 1;
    out += docxInline(c, f);
  }
  return out;
}

function docxBody(html) {
  var d = document.createElement('div');
  d.innerHTML = html;
  var out = '';
  var kids = d.children.length ? Array.prototype.slice.call(d.children) : [d];
  kids.forEach(function (el) {
    var tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') {
      var ordered = tag === 'OL';
      Array.prototype.slice.call(el.children).forEach(function (li, idx) {
        out += '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="' +
          (ordered ? '2' : '1') + '"/></w:numPr></w:pPr>' + docxInline(li, {}) + '</w:p>';
      });
      return;
    }
    if (tag === 'HR') { out += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="DADCE0"/></w:pBdr></w:pPr></w:p>'; return; }
    var style = '';
    if (tag === 'H1') style = '<w:pStyle w:val="Heading1"/>';
    else if (tag === 'H2') style = '<w:pStyle w:val="Heading2"/>';
    else if (tag === 'H3') style = '<w:pStyle w:val="Heading3"/>';
    else if (tag === 'BLOCKQUOTE') style = '<w:ind w:left="720"/>';
    var runFmt = {};
    if (tag === 'PRE') runFmt = {};
    out += '<w:p>' + (style ? '<w:pPr>' + style + '</w:pPr>' : '') + docxInline(el, runFmt) + '</w:p>';
  });
  return out || '<w:p/>';
}

/* --- tiny STORE-method zip (no compression, no deps) ---------------------- */
function zipStore(files) {
  var enc = new TextEncoder();
  var chunks = [], central = [], offset = 0;
  var crcTable = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function u16(v) { return [v & 255, (v >>> 8) & 255]; }
  function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }

  Object.keys(files).forEach(function (name) {
    var data = enc.encode(files[name]);
    var nameB = enc.encode(name);
    var crc = crc32(data);
    var local = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0));
    chunks.push(new Uint8Array(local), nameB, data);
    central.push({ name: nameB, crc: crc, size: data.length, offset: offset });
    offset += local.length + nameB.length + data.length;
  });

  var cdStart = offset, cdChunks = [];
  central.forEach(function (e) {
    var hdr = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(e.offset));
    cdChunks.push(new Uint8Array(hdr), e.name);
    offset += hdr.length + e.name.length;
  });
  var cdSize = offset - cdStart;
  var eocd = new Uint8Array([].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0),
    u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)));

  var all = chunks.concat(cdChunks, [eocd]);
  var total = all.reduce(function (a, b) { return a + b.length; }, 0);
  var outBuf = new Uint8Array(total), p = 0;
  all.forEach(function (a) { outBuf.set(a, p); p += a.length; });
  return outBuf;
}

function bytesToBase64(bytes) {
  var bin = '';
  var CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function doExport(format) {
  var ex = buildExport(format);
  if (!ex) return;
  if (format === 'docx') {
    var b64 = bytesToBase64(ex.data);
    if (HOST && HOST.exportFileBinary) {
      HOST.exportFileBinary(ex.name, ex.mime, b64);
      toast('Exporting ' + ex.name);
      return;
    }
    // fallback: base64 data URL download
    var a = document.createElement('a');
    a.href = 'data:' + ex.mime + ';base64,' + b64;
    a.download = ex.name;
    a.click();
    toast('Exported ' + ex.name);
    return;
  }
  if (HOST && HOST.exportFile) {
    HOST.exportFile(ex.name, ex.mime, ex.data);
    toast('Exporting ' + ex.name);
  } else {
    var blob = new Blob([ex.data], { type: ex.mime });
    var url = URL.createObjectURL(blob);
    var a2 = document.createElement('a');
    a2.href = url; a2.download = ex.name; a2.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Exported ' + ex.name);
  }
}

/* ============================================================================
   Popovers / menus
   ========================================================================== */
function closePops() {
  ['menuPop', 'colorPop', 'exportPop'].forEach(function (id) { $(id).classList.add('hidden'); });
}
function positionPop(pop, anchor) {
  var r = anchor.getBoundingClientRect();
  pop.classList.remove('hidden');
  var pw = pop.offsetWidth, ph = pop.offsetHeight;
  var left = Math.min(r.left, window.innerWidth - pw - 8);
  var top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
}

function menuItems(which) {
  var mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  if (which === 'file') {
    return [
      { label: 'New document', sc: '', act: newDoc },
      { label: 'Import…', sc: '', act: pickFile },
      { sep: 1 },
      { label: 'Export as .docx', sc: '', act: function () { doExport('docx'); } },
      { label: 'Export as .html', sc: '', act: function () { doExport('html'); } },
      { label: 'Export as .md', sc: '', act: function () { doExport('md'); } },
      { label: 'Export as .txt', sc: '', act: function () { doExport('txt'); } },
      { sep: 1 },
      { label: 'Recent documents', sc: state.docs.length, act: openRecent }
    ];
  }
  if (which === 'edit') {
    return [
      { label: 'Undo', sc: mod + '+Z', act: undo },
      { label: 'Redo', sc: mod + '+Y', act: redo },
      { sep: 1 },
      { label: 'Find', sc: mod + '+F', act: function () { showFind(); } },
      { label: 'Select all', sc: mod + '+A', act: function () { exec('selectAll'); } },
      { sep: 1 },
      { label: 'Clear formatting', sc: mod + '+\u005C', act: function () { exec('removeFormat'); } }
    ];
  }
  if (which === 'view') {
    return [
      { label: (state.pageless ? '' : '✓ ') + 'Print layout (pages)', sc: '', act: function () { if (state.pageless) togglePageless(); } },
      { label: (state.pageless ? '✓ ' : '') + 'Pageless mode', sc: '', act: function () { if (!state.pageless) togglePageless(); } },
      { sep: 1 },
      { label: 'Fit to width', sc: '', act: fitWidth },
      { label: 'Zoom 100%', sc: '', act: function () { setZoom(1, { center: true }); } },
      { label: 'Zoom in', sc: mod + ' +', act: function () { setZoom(state.zoom + 0.1); } },
      { label: 'Zoom out', sc: mod + ' −', act: function () { setZoom(state.zoom - 0.1); } },
      { sep: 1 },
      { label: 'Toggle dark theme', sc: '', act: toggleTheme },
      { label: 'Show/hide ruler', sc: '', act: toggleRuler }
    ];
  }
  if (which === 'insert') {
    return [
      { label: 'Horizontal line', sc: '', act: function () { exec('insertHorizontalRule'); } },
      { label: 'Link…', sc: mod + '+K', act: insertLink },
      { label: 'Table 3×3', sc: '', act: function () { insertTable(3, 3); } },
      { label: 'Table 4×5', sc: '', act: function () { insertTable(4, 5); } },
      { sep: 1 },
      { label: 'Page break (visual)', sc: '', act: insertPageBreak },
      { label: 'Date', sc: '', act: function () {
        exec('insertText', new Date().toLocaleDateString());
      } }
    ];
  }
  if (which === 'format') {
    return [
      { label: 'Bold', sc: mod + '+B', act: function () { exec('bold'); } },
      { label: 'Italic', sc: mod + '+I', act: function () { exec('italic'); } },
      { label: 'Underline', sc: mod + '+U', act: function () { exec('underline'); } },
      { label: 'Strikethrough', sc: mod + '+Shift+X', act: function () { exec('strikeThrough'); } },
      { sep: 1 },
      { label: 'Superscript', sc: mod + '+.', act: function () { exec('superscript'); } },
      { label: 'Subscript', sc: mod + '+,', act: function () { exec('subscript'); } },
      { sep: 1 },
      { label: 'Line spacing 1.0', sc: '', act: function () { setLineSpacing('1'); } },
      { label: 'Line spacing 1.5', sc: '', act: function () { setLineSpacing('1.5'); } },
      { label: 'Line spacing 2.0', sc: '', act: function () { setLineSpacing('2'); } }
    ];
  }
  return [];
}

function showMenu(which, anchor) {
  var pop = $('menuPop');
  var items = menuItems(which);
  pop.innerHTML = '';
  items.forEach(function (it) {
    if (it.sep) { var s = document.createElement('div'); s.className = 'pop-sep'; pop.appendChild(s); return; }
    var d = document.createElement('div');
    d.className = 'pop-item';
    d.innerHTML = '<span>' + it.label + '</span><span class="sc">' + (it.sc || '') + '</span>';
    d.onclick = function () { closePops(); haptic(6); it.act(); };
    pop.appendChild(d);
  });
  closePops();
  positionPop(pop, anchor);
}

function openRecent() {
  var pop = $('menuPop');
  pop.innerHTML = '<div class="pop-label">Recent</div>';
  state.docs.slice(0, 12).forEach(function (rec) {
    var d = document.createElement('div');
    d.className = 'pop-item';
    var when = new Date(rec.updated);
    d.innerHTML = '<span>' + escapeHtml(rec.title || 'Untitled') + '</span><span class="sc">' +
      when.toLocaleDateString() + '</span>';
    d.onclick = function () {
      closePops();
      saveNow();
      openDoc(rec);
      toast('Opened ' + (rec.title || 'Untitled'));
    };
    pop.appendChild(d);
  });
  var del = document.createElement('div');
  del.className = 'pop-item';
  del.innerHTML = '<span style="color:#d93025">Delete this document</span>';
  del.onclick = function () {
    closePops();
    modalConfirm('Delete this document? This cannot be undone.', function () {
      state.docs = state.docs.filter(function (r) { return r.id !== state.docId; });
      store.set(LS_DOCS, JSON.stringify(state.docs));
      if (state.docs.length) openDoc(state.docs[0]); else newDoc();
      toast('Document deleted');
    });
  };
  pop.appendChild(del);
  positionPop(pop, $('btnMenu'));
}

var COLORS = ['#000000','#434343','#666666','#999999','#b7b7b7','#cccccc','#efefef','#ffffff',
  '#980000','#ff0000','#ff9900','#ffff00','#00ff00','#00ffff','#4a86e8','#0000ff',
  '#9900ff','#ff00ff','#e6b8af','#f4cccc','#fce5cd','#fff2cc','#d9ead3','#d0e0e3',
  '#c9daf8','#cfe2f3','#d9d2e9','#ead1dc','#e06666','#f6b26b','#ffd966','#93c47d',
  '#76a5af','#6fa8dc','#8e7cc3','#c27ba0','#cc0000','#e69138','#f1c232','#6aa84f',
  '#45818e','#3d85c6','#674ea7','#a64d79','#674ea7','#a64d79','#444444','#f3f3f3'];

function showColorPop(kind, anchor) {
  var pop = $('colorPop');
  pop.innerHTML = '<div class="pop-label">' + (kind === 'text' ? 'Text color' : 'Highlight') + '</div>';
  var grid = document.createElement('div');
  grid.className = 'color-grid';
  COLORS.forEach(function (c) {
    var sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = c;
    sw.onclick = function () {
      closePops();
      if (kind === 'text') {
        state.textColor = c;
        $('textColorBar').style.background = c;
        exec('foreColor', c);
      } else {
        state.hlColor = c;
        $('hlColorBar').style.background = c;
        focusContent(); restoreSelection();
        try { document.execCommand('hiliteColor', false, c); } catch (e) {}
        schedulePaginate(); scheduleSave(); pushHistory();
      }
      haptic(6);
    };
    grid.appendChild(sw);
  });
  pop.appendChild(grid);
  var none = document.createElement('div');
  none.className = 'pop-item';
  none.innerHTML = '<span>None</span>';
  none.onclick = function () {
    closePops();
    if (kind === 'text') exec('foreColor', 'inherit');
    else { focusContent(); restoreSelection(); try { document.execCommand('hiliteColor', false, 'transparent'); } catch (e) {} }
    scheduleSave();
  };
  pop.appendChild(none);
  closePops();
  positionPop(pop, anchor);
}

function insertLink() {
  var sel = window.getSelection();
  var existing = '';
  var node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (node && node.nodeType === 3) node = node.parentNode;
  while (node && node !== content) { if (node.tagName === 'A') { existing = node.getAttribute('href') || ''; break; } node = node.parentNode; }
  modalPrompt('Link URL', existing || 'https://', function (url) {
    if (!url) return;
    focusContent(); restoreSelection();
    try { document.execCommand('createLink', false, url); } catch (e) {}
    schedulePaginate(); scheduleSave(); pushHistory();
    toast('Link added');
  });
}

function insertTable(rows, cols) {
  var html = '<table>';
  for (var r = 0; r < rows; r++) {
    html += '<tr>';
    for (var c = 0; c < cols; c++) {
      html += r === 0 ? '<th><br></th>' : '<td><br></td>';
    }
    html += '</tr>';
  }
  html += '</table><p><br></p>';
  focusContent(); restoreSelection();
  try { document.execCommand('insertHTML', false, html); } catch (e) {}
  schedulePaginate(); scheduleSave(); pushHistory();
  toast(rows + '×' + cols + ' table inserted');
}

function insertPageBreak() {
  focusContent(); restoreSelection();
  try { document.execCommand('insertHTML', false, '<div class="pgbreak" contenteditable="false" style="height:' + (PAGE_H) + 'px"></div><p><br></p>'); } catch (e) {}
  schedulePaginate(); scheduleSave();
  toast('Page break inserted');
}

function setLineSpacing(v) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var blocks = [];
  var r = sel.getRangeAt(0);
  var walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT, null);
  var n;
  while ((n = walker.nextNode())) {
    if (/^(P|H1|H2|H3|LI|BLOCKQUOTE|PRE)$/.test(n.tagName) && sel.containsNode(n, true)) blocks.push(n);
  }
  if (!blocks.length) { var b = currentBlock(); if (b) blocks = [b]; }
  blocks.forEach(function (el) { el.style.lineHeight = v; });
  schedulePaginate(); scheduleSave(); pushHistory();
}

function togglePageless() {
  state.pageless = !state.pageless;
  document.getElementById('rulerWrap').style.display = state.pageless ? 'none' : '';
  paginate();
  toast(state.pageless ? 'Pageless mode' : 'Pages mode');
}

function toggleRuler() {
  var r = $('rulerWrap');
  r.style.display = (r.style.display === 'none') ? '' : 'none';
}

function toggleTheme() {
  document.body.classList.toggle('dark');
  document.body.classList.toggle('light');
  var dark = document.body.classList.contains('dark');
  store.set('dc.theme', dark ? 'dark' : 'light');
  drawRuler();
}

function showFind() {
  var fb = $('findBar');
  fb.classList.remove('hidden');
  $('findInput').value = state.findQuery || '';
  $('findInput').focus();
  $('findInput').select();
}
function hideFind() {
  $('findBar').classList.add('hidden');
  clearFind();
  focusContent();
}

/* ============================================================================
   Wiring
   ========================================================================== */
function initToolbar() {
  var map = [
    ['tbUndo', function () { undo(); }],
    ['tbRedo', function () { redo(); }],
    ['tbPrint', function () { window.print(); }],
    ['zoomOut', function () { setZoom(state.zoom - 0.1); }],
    ['zoomIn', function () { setZoom(state.zoom + 0.1); }],
    ['fitWidth', fitWidth],
    ['zoomLabel', function () { setZoom(1, { center: true }); }],
    ['tbBold', function () { exec('bold'); }],
    ['tbItalic', function () { exec('italic'); }],
    ['tbUnderline', function () { exec('underline'); }],
    ['tbStrike', function () { exec('strikeThrough'); }],
    ['tbClearFmt', function () { exec('removeFormat'); }],
    ['tbAlignLeft', function () { exec('justifyLeft'); }],
    ['tbAlignCenter', function () { exec('justifyCenter'); }],
    ['tbAlignRight', function () { exec('justifyRight'); }],
    ['tbAlignJustify', function () { exec('justifyFull'); }],
    ['tbBullets', function () { exec('insertUnorderedList'); }],
    ['tbNumbers', function () { exec('insertOrderedList'); }],
    ['tbOutdent', function () { exec('outdent'); }],
    ['tbIndent', function () { exec('indent'); }],
    ['tbHr', function () { exec('insertHorizontalRule'); }],
    ['tbLink', insertLink],
    ['tbTable', function () { insertTable(3, 3); }]
  ];
  map.forEach(function (pair) {
    var el = $(pair[0]);
    if (!el) return;
    // keep selection on touchstart
    el.addEventListener('touchstart', function (e) { e.preventDefault(); saveSelection(); }, { passive: false });
    el.addEventListener('mousedown', function (e) { e.preventDefault(); saveSelection(); });
    el.addEventListener('click', function (e) { e.preventDefault(); pair[1](); haptic(6); });
  });

  $('tbTextColor').addEventListener('touchstart', function (e) { e.preventDefault(); saveSelection(); }, { passive: false });
  $('tbTextColor').onclick = function (e) { e.preventDefault(); saveSelection(); showColorPop('text', $('tbTextColor')); };
  $('tbHighlight').addEventListener('touchstart', function (e) { e.preventDefault(); saveSelection(); }, { passive: false });
  $('tbHighlight').onclick = function (e) { e.preventDefault(); saveSelection(); showColorPop('hl', $('tbHighlight')); };

  $('styleSelect').addEventListener('touchstart', function () { saveSelection(); }, { passive: true });
  $('styleSelect').onchange = function () {
    var v = this.value;
    focusContent(); restoreSelection();
    try { document.execCommand('formatBlock', false, v === 'p' ? '<p>' : '<' + v + '>'); } catch (e) {}
    schedulePaginate(); scheduleSave(); pushHistory();
  };
  $('fontSelect').addEventListener('touchstart', function () { saveSelection(); }, { passive: true });
  $('fontSelect').onchange = function () { var f = this.value; exec('fontName', f); };
  $('sizeSelect').addEventListener('touchstart', function () { saveSelection(); }, { passive: true });
  $('sizeSelect').onchange = function () { applyFontSize(parseFloat(this.value)); };
  $('lineSpacing').addEventListener('touchstart', function () { saveSelection(); }, { passive: true });
  $('lineSpacing').onchange = function () { setLineSpacing(this.value); };

  $('sizeInc').onclick = function (e) { e.preventDefault(); stepSize(1); };
  $('sizeDec').onclick = function (e) { e.preventDefault(); stepSize(-1); };
  $('sizeInc').addEventListener('touchstart', function (e) { e.preventDefault(); saveSelection(); }, { passive: false });
  $('sizeDec').addEventListener('touchstart', function (e) { e.preventDefault(); saveSelection(); }, { passive: false });

  $('btnMenu').onclick = function () { showMenu('file', $('btnMenu')); };
  $('btnTheme').onclick = function () { toggleTheme(); haptic(6); };
  $('btnShare').onclick = function () {
    var pop = $('exportPop');
    pop.innerHTML = '<div class="pop-label">Export</div>';
    [['docx', 'Word (.docx)'], ['html', 'Web page (.html)'], ['md', 'Markdown (.md)'], ['txt', 'Plain text (.txt)']].forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'pop-item';
      d.innerHTML = '<span>' + p[1] + '</span>';
      d.onclick = function () { closePops(); doExport(p[0]); };
      pop.appendChild(d);
    });
    var pr = document.createElement('div');
    pr.className = 'pop-item';
    pr.innerHTML = '<span>Print / Save as PDF</span>';
    pr.onclick = function () { closePops(); window.print(); };
    pop.appendChild(pr);
    closePops();
    positionPop(pop, $('btnShare'));
  };
  $('fab').onclick = function () { newDoc(); haptic(12); };

  Array.prototype.forEach.call(document.querySelectorAll('.menu-item'), function (m) {
    m.onclick = function (e) { e.stopPropagation(); showMenu(m.dataset.menu, m); haptic(5); };
  });

  $('findClose').onclick = hideFind;
  $('findPrev').onclick = function () { findNext(-1); };
  $('findNext').onclick = function () { findNext(1); };
  var ft = null;
  $('findInput').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(ft);
    ft = setTimeout(function () { doFind(v); }, 180);
  });
  $('findInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') hideFind();
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.pop') && !e.target.closest('.menu-item') &&
        !e.target.closest('#btnShare') && !e.target.closest('#btnMenu') &&
        !e.target.closest('#tbTextColor') && !e.target.closest('#tbHighlight')) {
      closePops();
    }
  });
}

function stepSize(dir) {
  var sel = $('sizeSelect');
  var i = sel.selectedIndex + dir;
  i = Math.max(0, Math.min(sel.options.length - 1, i));
  sel.selectedIndex = i;
  applyFontSize(parseFloat(sel.value));
}

function applyFontSize(pt) {
  state.lastSize = pt;
  wrapSelectionWithStyle({ fontSize: pt + 'pt' });
}

function initContent() {
  content.addEventListener('input', function () {
    schedulePaginate();
    scheduleSave();
    clearTimeout(pushHistory._t);
    pushHistory._t = setTimeout(pushHistory, 700);
    updateStatus(pagesEl.children.length || 1);
  });
  content.addEventListener('keyup', function () { saveSelection(); syncToolbar(); updateStatus(pagesEl.children.length || 1); });
  content.addEventListener('mouseup', function () { saveSelection(); syncToolbar(); });
  content.addEventListener('blur', function () { saveSelection(); });
  content.addEventListener('focus', function () {
    if (!content.firstChild) {
      content.innerHTML = '<p><br></p>';
      var r = document.createRange();
      r.setStart(content.firstChild, 0); r.collapse(true);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  });

  // clean paste
  content.addEventListener('paste', function (e) {
    e.preventDefault();
    var cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    var html = cd.getData('text/html');
    var text = cd.getData('text/plain');
    var insert = html ? sanitizeHtml(html) : textToHtml(text);
    try { document.execCommand('insertHTML', false, insert); } catch (err) {
      try { document.execCommand('insertText', false, text); } catch (e2) {}
    }
    schedulePaginate(); scheduleSave(); pushHistory();
  });

  document.addEventListener('selectionchange', function () {
    if (document.activeElement === content) { saveSelection(); syncToolbar(); }
  });

  docTitle.addEventListener('input', function () { scheduleSave(); });
  docTitle.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); content.focus(); } });
}

/* ------------------------- keyboard shortcuts ---------------------------- */
function initShortcuts() {
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) {
      if (e.key === 'Escape') { closePops(); if (!$('findBar').classList.contains('hidden')) hideFind(); }
      if (e.key === 'Tab' && document.activeElement === content) {
        e.preventDefault();
        exec(e.shiftKey ? 'outdent' : 'indent');
      }
      return;
    }
    var k = e.key.toLowerCase();
    var handled = true;
    switch (k) {
      case 'b': exec('bold'); break;
      case 'i': exec('italic'); break;
      case 'u': exec('underline'); break;
      case 'z': e.shiftKey ? redo() : undo(); break;
      case 'y': redo(); break;
      case 'f': showFind(); break;
      case 'k': insertLink(); break;
      case 'a': exec('selectAll'); break;
      case 's': saveNow(); toast('Saved'); break;
      case 'p': window.print(); break;
      case '\\': exec('removeFormat'); break;
      case '=': case '+': setZoom(state.zoom + 0.1); break;
      case '-': setZoom(state.zoom - 0.1); break;
      case '0': setZoom(1, { center: true }); break;
      case '.': exec('superscript'); break;
      case ',': exec('subscript'); break;
      case 'x': if (e.shiftKey) exec('strikeThrough'); else handled = false; break;
      case '1': if (e.altKey) exec('formatBlock', '<h1>'); else handled = false; break;
      case '2': if (e.altKey) exec('formatBlock', '<h2>'); else handled = false; break;
      case '3': if (e.altKey) exec('formatBlock', '<h3>'); else handled = false; break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); haptic(5); }
  });
}

/* --------------------------- android back -------------------------------- */
window.__onAndroidBack = function () {
  if (!$('findBar').classList.contains('hidden')) { hideFind(); return true; }
  var popOpen = ['menuPop', 'colorPop', 'exportPop'].some(function (id) { return !$(id).classList.contains('hidden'); });
  if (popOpen) { closePops(); return true; }
  var modal = document.querySelector('div[style*="z-index:200"]');
  if (modal) { modal.remove(); return true; }
  saveNow();
  return false;
};

/* ============================================================================
   Boot
   ========================================================================== */
function boot() {
  try {
    _boot();
  } catch (e) {
    // Never let a boot error leave a blank screen
    document.body.innerHTML =
      '<div style="padding:24px;font-family:Arial">Editor failed to start.<br><small>' +
      (e && e.message ? e.message : e) + '</small></div>';
    if (window.console) console.error(e);
  }
}

function _boot() {
  content = $('content');
  pagesEl = $('pages');
  stack = $('stack');
  scaler = $('scaler');
  canvas = $('canvas');
  rulerCanvas = $('rulerCanvas');
  docTitle = $('docTitle');
  saveState = $('saveState');
  snackEl = $('snack');

  var theme = store.get('dc.theme');
  if (theme === 'dark') { document.body.classList.add('dark'); document.body.classList.remove('light'); }

  initToolbar();
  initContent();
  initShortcuts();
  initGestures();

  loadDocs();
  fitWidth();
  paginate();

  window.addEventListener('resize', function () {
    applyZoomLayout();
    drawRuler();
    paginate();
  });
  canvas.addEventListener('scroll', drawRuler, { passive: true });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { applyZoomLayout(); drawRuler(); paginate(); }, 250);
  });

  // keep page info live
  setInterval(function () { updateStatus(pagesEl.children.length || 1); }, 1200);

  // expose for automated verification
  window.__editor = {
    state: state,
    paginate: paginate,
    serialize: serialize,
    pageCount: function () { return pagesEl.children.length; },
    pageMetrics: function () {
      var s = stack.getBoundingClientRect();
      var pg = pagesEl.children[0];
      return {
        zoom: state.zoom,
        offsetX: state.offsetX,
        pageW: PAGE_W * state.zoom,
        pageH: PAGE_H * state.zoom,
        stackH: s.height,
        pages: pagesEl.children.length,
        scrollW: canvas.scrollWidth,
        scrollH: canvas.scrollHeight,
        viewW: canvas.clientWidth,
        viewH: canvas.clientHeight
      };
    },
    setZoom: setZoom,
    fitWidth: fitWidth,
    exec: exec,
    newDoc: newDoc,
    docsCount: function () { return state.docs.length; },
    /* internals exposed for automated testing */
    buildExport: buildExport,
    buildDocx: buildDocx,
    zipStore: zipStore,
    htmlToText: htmlToText,
    htmlToMarkdown: htmlToMarkdown,
    sanitizeHtml: sanitizeHtml,
    textToHtml: textToHtml,
    wrapSelectionWithStyle: wrapSelectionWithStyle,
    setLineSpacing: setLineSpacing,
    insertTable: insertTable,
    saveNow: saveNow,
    openDoc: openDoc,
    undo: undo,
    redo: redo,
    PAGE_W: PAGE_W, PAGE_H: PAGE_H, GAP: GAP, FLOW: FLOW, MARGIN_Y: MARGIN_Y
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
