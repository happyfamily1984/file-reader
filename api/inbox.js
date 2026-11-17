// 받은 글 수신함. 주소에 들어 있는 id 가 곧 열쇠다 (아는 사람만 보내고 읽을 수 있음).
//   POST   /api/inbox?id=ID[&title=제목]   본문: 글(text/plain, text/markdown, text/html) 또는 JSON {title, text}
//   GET    /api/inbox?id=ID                받은 글 목록
//   GET    /api/inbox?id=ID&item=이름      글 한 편
//   DELETE /api/inbox?id=ID&item=이름      삭제
import { addItem, configured, getItem, listItems, removeItem } from '../lib/store.js';
import { htmlToArticle } from './extract.js';

const MAX = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{16,64}$/;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX) throw Object.assign(new Error('글이 너무 깁니다 (최대 1MB).'), { status: 413 });
    chunks.push(c);
  }
  if (size) return Buffer.concat(chunks).toString('utf8');
  // 실행 환경이 본문을 미리 읽어 둔 경우
  let pre;
  try { pre = req.body; } catch { pre = undefined; }
  if (Buffer.isBuffer(pre)) return pre.toString('utf8');
  if (pre && typeof pre === 'object' && !('text' in pre || 'content' in pre || 'body' in pre)) return Object.keys(pre).join('&');
  return pre ?? '';
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('id') || '', item = q.get('item');
    if (!ID.test(id)) return send(400, { error: '수신 주소(id)가 올바르지 않습니다.' });
    if (!configured) return send(501, { error: '저장소가 연결되지 않았습니다. Vercel 프로젝트의 Storage 에서 Blob 저장소를 만들어 연결해 주세요.' });

    if (req.method === 'GET') {
      if (!item) return send(200, { items: await listItems(id) });
      const doc = await getItem(id, item);
      return doc ? send(200, doc) : send(404, { error: '글을 찾지 못했습니다.' });
    }
    if (req.method === 'DELETE') {
      if (item) await removeItem(id, item);
      return send(200, { ok: true });
    }
    if (req.method !== 'POST') return send(405, { error: '지원하지 않는 요청입니다.' });

    const type = (req.headers['content-type'] || '').toLowerCase();
    let body = await readBody(req), title = q.get('title') || '', text;
    if (typeof body === 'string' && type.includes('json')) {
      try { body = JSON.parse(body); } catch { return send(400, { error: 'JSON 형식이 올바르지 않습니다.' }); }
    } else if (typeof body === 'string' && type.includes('urlencoded')) {
      const form = new URLSearchParams(body); // curl -d 기본값: text=… 형식이면 그 값을, 아니면 본문 전체를 글로 본다
      if (form.has('text')) { title ||= form.get('title') || ''; body = form.get('text'); }
    }
    if (body && typeof body === 'object') {
      title ||= String(body.title || '');
      text = String(body.text ?? body.content ?? body.body ?? '');
    } else text = String(body || '');
    if (type.includes('html') || /^\s*(<!doctype html|<html)/i.test(text)) {
      const art = htmlToArticle(text);
      title ||= art.title;
      text = art.text;
    }
    text = text.trim();
    if (!text) return send(400, { error: '보낸 글이 비어 있습니다.' });
    if (text.length > MAX) return send(413, { error: '글이 너무 깁니다 (최대 1MB).' });
    title = (title || text.split('\n')[0].replace(/^[#\s>*-]+/, '')).trim().slice(0, 80) || '제목 없음';
    const saved = await addItem(id, title, text);
    send(200, { ok: true, title: saved.title, message: '받았습니다. 앱의 "받은 글"에서 들을 수 있습니다.' });
  } catch (e) {
    console.error(e);
    send(e.status || 500, { error: e.status ? e.message : '처리 중 문제가 생겼습니다.' });
  }
}
