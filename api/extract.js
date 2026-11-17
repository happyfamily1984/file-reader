// GET /api/extract?url=...
//  - HTML 페이지: 본문만 추출해 { kind:'text', title, text } JSON 으로 응답
//  - 그 외(PDF, DOCX, TXT, 이미지 등): 원본 바이트를 그대로 전달 → 브라우저가 파일처럼 처리
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const MAX_HTML = 8 * 1024 * 1024;
const MAX_FILE = 4 * 1024 * 1024; // 서버리스 응답 한도 고려
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function isPrivate(ip) {
  if (ip.includes(':')) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) return isPrivate(s.slice(7));
    return s === '::1' || s === '::' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'http/https 주소만 지원합니다.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw httpError(400, '주소를 찾을 수 없습니다.');
  if (addrs.some((a) => isPrivate(a.address))) throw httpError(400, '접근할 수 없는 주소입니다.');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function fetchPublic(startUrl) {
  let url = new URL(startUrl);
  for (let i = 0; i < 6; i++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'ko,en;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    return { res, url };
  }
  throw httpError(502, '리다이렉트가 너무 많습니다.');
}

async function readLimited(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > limit) throw httpError(413, `파일이 너무 큽니다 (최대 ${Math.round(limit / 1048576)}MB). 파일을 내려받아 직접 열어주세요.`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function decodeHtml(buf, contentType) {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!cs) cs = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE', 'DT', 'DD', 'FIGCAPTION', 'UL', 'OL', 'TABLE']);
function blockText(node) {
  let out = '';
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.nodeType === 1) {
        const tag = c.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        if (tag === 'BR') { out += '\n'; continue; }
        const block = BLOCK.has(tag);
        if (block) out += '\n';
        walk(c);
        if (block) out += '\n';
      }
    }
  })(node);
  return out.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export function htmlToArticle(html) {
  const { document } = parseHTML(html);
  const pageTitle = document.querySelector('title')?.textContent?.trim() || '';
  let title = pageTitle, text = '';
  try {
    const art = new Readability(document.cloneNode(true)).parse();
    if (art?.content) {
      title = art.title || pageTitle;
      text = blockText(parseHTML(`<html><body>${art.content}</body></html>`).document.body);
    }
  } catch { /* 아래 대체 경로 사용 */ }
  if (text.length < 200 && document.body) {
    document.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,iframe').forEach((n) => n.remove());
    const all = blockText(document.body);
    if (all.length > text.length) text = all;
  }
  return { title, text };
}

export default async function handler(req, res) {
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  try {
    const raw = new URL(req.url, 'http://x').searchParams.get('url')?.trim();
    if (!raw) throw httpError(400, '주소(url)가 필요합니다.');
    let target;
    try { target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw httpError(400, '올바른 주소가 아닙니다.'); }

    const { res: up, url } = await fetchPublic(target);
    if (!up.ok) throw httpError(502, `페이지를 가져오지 못했습니다 (${up.status}).`);
    const type = (up.headers.get('content-type') || '').toLowerCase();

    if (!type || /html/.test(type)) {
      const { title, text } = htmlToArticle(decodeHtml(await readLimited(up, MAX_HTML), type));
      if (!text) throw httpError(422, '이 페이지에서 읽을 글을 찾지 못했습니다.');
      return send(200, { kind: 'text', title: title || url.hostname, text, url: url.href });
    }
    const buf = await readLimited(up, MAX_FILE);
    res.statusCode = 200;
    res.setHeader('content-type', type);
    res.setHeader('x-file-name', encodeURIComponent(decodeURIComponent(url.pathname.split('/').pop() || 'file')));
    res.end(buf);
  } catch (e) {
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    send(e.status || 502, { error: timeout ? '응답이 너무 오래 걸립니다.' : e.status ? e.message : '페이지를 가져오지 못했습니다.' });
  }
}
