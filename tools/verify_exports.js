/**
 * Verifies the export pipeline produces genuinely valid files.
 * The DOCX path is the risky one: we hand-roll an OOXML zip, so we
 * (a) parse the zip back with Python's zipfile and (b) unzip it with the
 * real `unzip`-equivalent to prove central-directory offsets are correct.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ASSETS = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'editor');
const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="editor.css">', '')
  .replace('<script src="editor.js"></script>', '');
const js = fs.readFileSync(path.join(ASSETS, 'editor.js'), 'utf8');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
function check(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL  ' + n + (x ? ' :: ' + x : '')); } }

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///a/i.html' });
const { window } = dom, { document } = window;
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return this.id === 'canvas' ? 400 : 0; }, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return this.id === 'canvas' ? 700 : 0; }, configurable: true });
window.Element.prototype.getBoundingClientRect = function () {
  const z = (window.__editor && window.__editor.state) ? window.__editor.state.zoom : 1;
  if (this.id === 'canvas') return { top: 0, left: 0, right: 400, bottom: 700, width: 400, height: 700 };
  if (this.classList && this.classList.contains('page')) return { top: 0, left: 0, right: 816 * z, bottom: 1056 * z, width: 816 * z, height: 1056 * z };
  const h = this.hasAttribute('data-h') ? parseFloat(this.getAttribute('data-h')) : 20;
  return { top: 0, left: 0, right: 816, bottom: h * z, width: 816, height: h * z };
};
Object.defineProperty(window.Element.prototype, 'scrollHeight', { get() { return 1200; }, configurable: true });
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  fillText() {}, measureText: () => ({ width: 8 })
});
window.innerWidth = 400; window.innerHeight = 800; window.devicePixelRatio = 2;
document.execCommand = () => true;
document.queryCommandState = () => false;

window.eval(js);
if (!window.__editor) window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
const ed = window.__editor;
const content = document.getElementById('content');

console.log('\n=== Export format verification ===\n');

const DOC = '<h1>Quarterly Report</h1>' +
  '<p>Revenue grew <b>18%</b> and <i>margins</i> held steady.</p>' +
  '<ul><li>North: 42k</li><li>South: 31k</li></ul>' +
  '<blockquote>Strong quarter.</blockquote>' +
  '<p>Ampersand &amp; angle &lt;tag&gt; test</p>';

content.innerHTML = DOC;
ed.paginate();

/* ---------------------------- TXT ---------------------------------------- */
console.log('[1] Plain text');
const txt = ed.buildExport('txt');
check('txt name has extension', /\.txt$/.test(txt.name), txt.name);
check('txt mime correct', txt.mime === 'text/plain');
check('txt contains heading text', txt.data.indexOf('Quarterly Report') !== -1);
check('txt strips HTML tags', txt.data.indexOf('<h1>') === -1 && txt.data.indexOf('<b>') === -1);
check('txt decodes entities', txt.data.indexOf('Ampersand & angle <tag> test') !== -1, JSON.stringify(txt.data.slice(-60)));
check('txt keeps list items', txt.data.indexOf('North: 42k') !== -1);

/* ---------------------------- HTML --------------------------------------- */
console.log('\n[2] HTML');
const h = ed.buildExport('html');
check('html name', /\.html$/.test(h.name));
check('html is a full document', /^<!DOCTYPE html>/.test(h.data) && h.data.indexOf('</html>') !== -1);
check('html preserves bold markup', /<b>18%<\/b>/.test(h.data));
check('html preserves list', /<ul>/.test(h.data) && /<li>/.test(h.data));
check('html has embedded styles', h.data.indexOf('<style>') !== -1);
check('html has no page-break spacers', h.data.indexOf('pgbreak') === -1);

/* ---------------------------- Markdown ----------------------------------- */
console.log('\n[3] Markdown');
const md = ed.buildExport('md');
check('md name', /\.md$/.test(md.name));
check('md heading as #', md.data.indexOf('# Quarterly Report') !== -1, md.data.slice(0, 60));
check('md bold as **', md.data.indexOf('**18%**') !== -1);
check('md italic as *', md.data.indexOf('*margins*') !== -1);
check('md list as -', /- North: 42k/.test(md.data));
check('md quote as >', /^> /m.test(md.data));

/* ---------------------------- DOCX --------------------------------------- */
console.log('\n[4] DOCX');
const dx = ed.buildExport('docx');
check('docx name', /\.docx$/.test(dx.name));
check('docx mime', dx.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
check('docx is a byte buffer', dx.data && typeof dx.data.length === 'number' &&
  typeof dx.data.subarray === 'function', Object.prototype.toString.call(dx.data));
check('docx starts with PK zip signature', dx.data[0] === 0x50 && dx.data[1] === 0x4b, dx.data[0] + ',' + dx.data[1]);
check('docx ends with EOCD signature', dx.data[dx.data.length - 22] === 0x50 && dx.data[dx.data.length - 21] === 0x4b);

const outPath = path.join(__dirname, '..', 'build-test', dx.name);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(dx.data));
console.log('  wrote ' + outPath + ' (' + dx.data.length + ' bytes)');

/* validate with python zipfile (independent implementation) */
const py = `
import zipfile, sys, re
p = r"${outPath.replace(/\\/g, '\\\\')}"
try:
    z = zipfile.ZipFile(p)
except Exception as e:
    print("BADZIP:" + str(e)); sys.exit(0)
bad = z.testzip()
print("BADCRC:" + str(bad) if bad else "CRC_OK")
names = z.namelist()
print("NAMES:" + ",".join(sorted(names)))
doc = z.read('word/document.xml').decode('utf-8')
print("HAS_W:document:" + str(doc.startswith('<?xml')))
print("HAS_BODY:" + str('<w:body>' in doc and '</w:body>' in doc))
print("HAS_BOLD:" + str('<w:b/>' in doc))
print("HAS_ITALIC:" + str('<w:i/>' in doc))
print("HAS_HEADING:" + str('Heading1' in doc))
print("HAS_LIST:" + str('numPr' in doc))
print("HAS_TEXT:" + str('Quarterly Report' in doc))
print("ESCAPED_AMP:" + str('&amp;' in doc))
print("NO_RAW_AMP:" + str(re.search(r'&(?!(amp|lt|gt|quot|apos|#);)', doc) is None))
`;
let pyOut = '';
try {
  pyOut = execFileSync('python', ['-c', py], { encoding: 'utf8' });
} catch (e) { pyOut = 'PYERR:' + e.message; }
console.log(pyOut.trim().split('\n').map(l => '    ' + l).join('\n'));

check('python can open the zip', pyOut.indexOf('CRC_OK') !== -1, pyOut);
check('zip has all required OOXML parts', pyOut.indexOf('word/document.xml') !== -1 &&
  pyOut.indexOf('[Content_Types].xml') !== -1 && pyOut.indexOf('_rels/.rels') !== -1, pyOut);
check('document.xml is valid XML-ish with w:body', pyOut.indexOf('HAS_BODY:True') !== -1, pyOut);
check('bold formatting written', pyOut.indexOf('HAS_BOLD:True') !== -1);
check('italic formatting written', pyOut.indexOf('HAS_ITALIC:True') !== -1);
check('heading style written', pyOut.indexOf('HAS_HEADING:True') !== -1);
check('list numbering written', pyOut.indexOf('HAS_LIST:True') !== -1);
check('document text present', pyOut.indexOf('HAS_TEXT:True') !== -1);
check('XML entities escaped', pyOut.indexOf('ESCAPED_AMP:True') !== -1 && pyOut.indexOf('NO_RAW_AMP:True') !== -1, pyOut);

/* ------------------------ sanitizer (paste/XSS) -------------------------- */
console.log('\n[5] HTML sanitizer');
const dirty = '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>' +
  '<a href="https://ok.com" onclick="evil()">link</a>' +
  '<iframe src="//evil"></iframe><style>body{}</style><b onmouseover="x()">bold</b>';
const clean = ed.sanitizeHtml(dirty);
check('removes <script>', clean.toLowerCase().indexOf('<script') === -1);
check('removes <iframe>', clean.toLowerCase().indexOf('<iframe') === -1);
check('removes <style>', clean.toLowerCase().indexOf('<style') === -1);
check('removes onerror attribute', clean.indexOf('onerror') === -1, clean);
check('removes onclick attribute', clean.indexOf('onclick') === -1, clean);
check('removes onmouseover attribute', clean.indexOf('onmouseover') === -1, clean);
check('keeps safe <b>', clean.indexOf('<b>bold</b>') !== -1, clean);
check('keeps https href', clean.indexOf('href="https://ok.com"') !== -1, clean);
check('keeps paragraph text', clean.indexOf('ok') !== -1);

/* ------------------------ text -> html import ---------------------------- */
console.log('\n[6] Plain-text import');
const imported = ed.textToHtml('line one\nline two\n\nline four');
check('import wraps lines in <p>', (imported.match(/<p>/g) || []).length === 4, imported);
check('import escapes HTML', ed.textToHtml('<b>not bold</b>').indexOf('&lt;b&gt;') !== -1);
check('import handles blank lines', imported.indexOf('<p><br></p>') !== -1);

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
