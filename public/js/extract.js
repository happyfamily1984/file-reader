// 파일·링크에서 글을 뽑아낸다. 무거운 라이브러리는 필요할 때만 불러온다.
import { hwpText, docText, pptText, xlsText, rtfText } from './office.js';

const V = 'vendor/';
const scripts = {};
function loadScript(src) {
  return (scripts[src] ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error('필요한 구성 요소를 불러오지 못했습니다: ' + src));
    document.head.append(s);
  }));
}

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE', 'DT', 'DD', 'FIGCAPTION', 'UL', 'OL', 'TABLE']);
function blockText(root) {
  let out = '';
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.nodeType === 1) {
        const tag = c.tagName.toUpperCase();
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'IFRAME'].includes(tag)) continue;
        if (tag === 'BR') { out += '\n'; continue; }
        const b = BLOCK.has(tag);
        if (b) out += '\n';
        walk(c);
        if (b) out += '\n';
      }
    }
  })(root);
  return tidy(out);
}
const tidy = (s) => s.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();

function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}

// ── PDF ─────────────────────────────────────────────
async function fromPdf(buf, progress) {
  const pdfjs = await import(new URL(V + 'pdfjs/pdf.min.mjs', document.baseURI).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(V + 'pdfjs/pdf.worker.min.mjs', document.baseURI).href;
  const base = new URL(V + 'pdfjs/', document.baseURI).href;
  const pdf = await pdfjs.getDocument({ data: buf, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/' }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    progress(`PDF 읽는 중… ${n}/${pdf.numPages}쪽`);
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    const lines = [];
    let line = '';
    for (const it of items) {
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
    }
    lines.push(line);
    pages.push(joinLines(lines));
  }
  let text = pages.filter(Boolean).join('\n');
  if (text.replace(/\s/g, '').length < pdf.numPages * 15) {
    // 글자가 거의 없으면 스캔본으로 보고 글자 인식(OCR)
    const out = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 2 });
      const canvas = Object.assign(document.createElement('canvas'), { width: vp.width, height: vp.height });
      await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: vp }).promise;
      out.push(await ocr(canvas, (m) => progress(`스캔 문서 글자 인식 중… ${n}/${pdf.numPages}쪽 ${m}`)));
    }
    text = out.join('\n');
  }
  return text;
}

// 줄바꿈으로 끊긴 문장을 다시 이어 붙인다.
function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (!l) { if (out && !out.endsWith('\n')) out += '\n'; continue; }
    if (!out || out.endsWith('\n')) out += l;
    else if (/[.!?。”"'’)\]:]$/.test(out)) out += '\n' + l;
    else if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + l;
    else out += ' ' + l;
  }
  return out.trim();
}

// ── 이미지 글자 인식 ────────────────────────────────
let ocrWorker, ocrLog = () => {};
async function ocr(image, progress) {
  await loadScript(V + 'tesseract/tesseract.min.js');
  ocrLog = progress;
  const abs = (p) => new URL(V + p, document.baseURI).href;
  ocrWorker ??= window.Tesseract.createWorker(['kor', 'eng'], 1, {
    workerPath: abs('tesseract/worker.min.js'),
    corePath: abs('tesseract/'),
    langPath: abs('tessdata/'),
    logger: (m) => ocrLog(m.status === 'recognizing text' ? Math.round(m.progress * 100) + '%' : ''),
  });
  progress('');
  const { data } = await (await ocrWorker).recognize(image);
  // 한글 글자 사이에 끼는 불필요한 공백 줄바꿈 정리
  return joinLines(data.text.split('\n'));
}

// ── ZIP 기반 문서 (HWPX, EPUB, PPTX) ────────────────
async function openZip(buf) {
  await loadScript(V + 'jszip.min.js');
  return window.JSZip.loadAsync(buf);
}
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const numOf = (name) => +(/(\d+)\.\w+$/.exec(name)?.[1] ?? 0);

async function paragraphsFromXml(zip, pattern, paraTag) {
  const names = Object.keys(zip.files).filter((n) => pattern.test(n)).sort((a, b) => numOf(a) - numOf(b));
  const out = [];
  for (const name of names) {
    const doc = xml(await zip.file(name).async('string'));
    const paras = new Map();
    for (const t of doc.getElementsByTagNameNS('*', 't')) {
      let p = t.parentNode;
      while (p && p.localName !== paraTag) p = p.parentNode;
      paras.set(p, (paras.get(p) || '') + t.textContent);
    }
    out.push(...paras.values());
  }
  return tidy(out.join('\n'));
}

async function fromEpub(buf) {
  const zip = await openZip(buf);
  const container = xml(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0].getAttribute('full-path');
  const opf = xml(await zip.file(opfPath).async('string'));
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const hrefs = {};
  for (const it of opf.getElementsByTagNameNS('*', 'item')) hrefs[it.getAttribute('id')] = it.getAttribute('href');
  const out = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const href = hrefs[ref.getAttribute('idref')];
    const f = href && zip.file(decodeURIComponent(dir + href.split('#')[0]));
    if (!f) continue;
    const doc = new DOMParser().parseFromString(await f.async('string'), 'text/html');
    out.push(blockText(doc.body));
  }
  return out.filter(Boolean).join('\n');
}

// 옛 MS 오피스·한글 문서는 모두 같은 그릇(CFB)에 담겨 있다. 확장자가 틀려도 내용으로 구분한다.
async function fromCfb(buf) {
  await loadScript(V + 'cfb.min.js');
  let cfb;
  try { cfb = window.CFB.read(new Uint8Array(buf), { type: 'array' }); } catch { throw new Error('문서 파일이 손상되었거나 지원하지 않는 형식입니다.'); }
  const names = cfb.FullPaths.map((p) => p.replace(/^[^/]*\//, ''));
  const find = (name) => { const i = names.indexOf(name); return i < 0 ? null : new Uint8Array(cfb.FileIndex[i].content); };
  if (find('FileHeader')) return hwpText(find, names);
  if (find('WordDocument')) return docText(find);
  if (find('PowerPoint Document')) return pptText(find);
  if (find('Workbook') || find('Book')) return xlsText(find);
  throw new Error('지원하지 않는 문서 형식입니다.');
}

async function fromXlsx(buf) {
  const zip = await openZip(buf);
  const shared = [];
  const sst = zip.file('xl/sharedStrings.xml');
  if (sst) for (const si of xml(await sst.async('string')).getElementsByTagNameNS('*', 'si')) {
    shared.push([...si.getElementsByTagNameNS('*', 't')].filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
  }
  const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => numOf(a) - numOf(b));
  const rows = [];
  for (const name of names) {
    for (const row of xml(await zip.file(name).async('string')).getElementsByTagNameNS('*', 'row')) {
      const cells = [];
      for (const c of row.getElementsByTagNameNS('*', 'c')) {
        const type = c.getAttribute('t');
        const v = c.getElementsByTagNameNS('*', type === 'inlineStr' ? 't' : 'v')[0]?.textContent ?? '';
        const val = type === 's' ? shared[+v] : v;
        if (val) cells.push(val);
      }
      if (cells.length) rows.push(cells.join(', '));
    }
  }
  return rows.join('\n');
}

async function fromOdf(buf) {
  const doc = xml(await (await openZip(buf)).file('content.xml').async('string'));
  const out = [];
  for (const el of doc.getElementsByTagNameNS('*', '*')) {
    if ((el.localName === 'p' || el.localName === 'h') && el.prefix === 'text') {
      let nested = false;
      for (let a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (a.prefix === 'text' && (a.localName === 'p' || a.localName === 'h')) nested = true;
      if (!nested) out.push(el.textContent);
    }
  }
  return out.join('\n');
}

// 확장자를 믿을 수 없을 때 파일 앞부분으로 형식을 알아낸다.
async function sniff(buf, zipOpen) {
  const b = new Uint8Array(buf.slice(0, 16));
  const head = String.fromCharCode(...b);
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (head.startsWith('\xd0\xcf\x11\xe0')) return 'cfb';
  if (head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('GIF8') || head.startsWith('BM') || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')) return 'image';
  if (head.startsWith('PK\x03\x04')) {
    const zip = await zipOpen(buf);
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('ppt/presentation.xml')) return 'pptx';
    if (zip.file('xl/workbook.xml')) return 'xlsx';
    if (zip.file('Contents/section0.xml')) return 'hwpx';
    if (zip.file('META-INF/container.xml')) return 'epub';
    if (zip.file('content.xml')) return 'odf';
    throw new Error('압축 파일(zip)은 읽을 수 없습니다. 압축을 풀어 문서를 열어 주세요.');
  }
  return null;
}

function fromSubtitle(text) {
  return text.split('\n').filter((l) => !/^\s*\d+\s*$/.test(l) && !/-->/.test(l) && !/^WEBVTT/.test(l)).join('\n').replace(/<[^>]+>/g, '');
}

// ── 진입점 ──────────────────────────────────────────
export async function fileToDoc(file, progress = () => {}) {
  const name = file.name || '파일';
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
  const type = file.type || '';
  const title = name.replace(/\.[a-z0-9]+$/i, '');
  progress('파일 여는 중…');
  const buf = await file.arrayBuffer();
  const byExt = { pdf: 'pdf', docx: 'docx', hwpx: 'hwpx', pptx: 'pptx', xlsx: 'xlsx', epub: 'epub', rtf: 'rtf', odt: 'odf', odp: 'odf', ods: 'odf',
    hwp: 'cfb', doc: 'cfb', ppt: 'cfb', xls: 'cfb', htm: 'html', html: 'html', xhtml: 'html',
    png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image' };
  // 내용으로 먼저 판별하고(확장자가 틀린 파일 대비), 안 되면 확장자·MIME 으로 판단한다.
  let kind = await sniff(buf, openZip) || byExt[ext]
    || (type.startsWith('image/') ? 'image' : type.includes('html') ? 'html' : 'text');
  if (kind === 'cfb' && new Uint8Array(buf)[0] !== 0xd0) kind = 'text';
  let text;
  if (kind === 'pdf') text = await fromPdf(buf, progress);
  else if (kind === 'docx') {
    await loadScript(V + 'mammoth.min.js');
    text = (await window.mammoth.extractRawText({ arrayBuffer: buf })).value;
  } else if (kind === 'hwpx') text = await paragraphsFromXml(await openZip(buf), /^Contents\/section\d+\.xml$/i, 'p');
  else if (kind === 'pptx') text = await paragraphsFromXml(await openZip(buf), /^ppt\/slides\/slide\d+\.xml$/i, 'p');
  else if (kind === 'xlsx') text = await fromXlsx(buf);
  else if (kind === 'epub') text = await fromEpub(buf);
  else if (kind === 'odf') text = await fromOdf(buf);
  else if (kind === 'cfb') text = await fromCfb(buf);
  else if (kind === 'rtf') text = rtfText(new Uint8Array(buf));
  else if (kind === 'image') {
    text = await ocr(new Blob([buf], { type: type.startsWith('image/') ? type : 'image/' + (ext || 'png') }), (m) => progress('사진에서 글자 인식 중… ' + m));
  } else if (kind === 'html') {
    text = blockText(new DOMParser().parseFromString(decodeText(buf), 'text/html').body);
  } else {
    const head = new Uint8Array(buf.slice(0, 4000));
    const utf16bom = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
    if (!utf16bom && head.includes(0)) throw new Error(`이 파일 형식${ext ? '(.' + ext + ')' : ''}은 지원하지 않습니다. PDF로 저장한 뒤 열어 주세요.`);
    text = decodeText(buf);
    if (/^(srt|vtt)$/.test(ext)) text = fromSubtitle(text);
    else if (/^\s*(<!doctype html|<html)/i.test(text.slice(0, 200))) text = blockText(new DOMParser().parseFromString(text, 'text/html').body);
  }
  text = (text || '').trim();
  if (!text) throw new Error('이 파일에서 읽을 글을 찾지 못했습니다.');
  return { title, text };
}

export async function linkToDoc(url, progress = () => {}) {
  progress('링크에서 글 가져오는 중…');
  let res;
  try { res = await fetch('api/extract?url=' + encodeURIComponent(url)); } catch { throw new Error('서버에 연결하지 못했습니다.'); }
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || '링크를 가져오지 못했습니다.');
    return { title: data.title, text: data.text };
  }
  if (!res.ok) throw new Error('링크를 가져오지 못했습니다. (링크 읽기는 서버와 함께 배포해야 동작합니다)');
  const name = decodeURIComponent(res.headers.get('x-file-name') || 'file');
  return fileToDoc(new File([await res.blob()], name, { type: type.split(';')[0] }), progress);
}
