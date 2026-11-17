// 받은 글 보관소. Vercel 에서는 Blob 저장소, 로컬에서는 .data/ 폴더를 쓴다.
// 항목 이름: inbox/<수신함 해시>/<시각>-<난수>-<제목>.json
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
export const configured = useBlob || !process.env.VERCEL;
const local = join(process.cwd(), '.data');
const dirOf = (id) => 'inbox/' + createHash('sha256').update(id).digest('hex').slice(0, 32) + '/';

function parseName(name) {
  const m = /^(\d+)-[0-9a-f]+-([^/\\]*)\.json$/.exec(name);
  if (!m) return null;
  let title = m[2];
  try { title = decodeURIComponent(m[2]); } catch { /* 그대로 사용 */ }
  return { item: name, at: +m[1], title };
}

// Blob 경로는 저장할 때 %가 %25로 바뀌므로, list()가 돌려준 이름으로 찾을 때는 같은 규칙으로 되돌린다.
// (한글 제목처럼 encodeURIComponent 결과에 %가 들어가는 이름이 여기에 해당)
const blobName = (item) => item.replace(/%/g, '%25');

// Blob 저장소는 만들 때 공개/비공개가 정해지므로, 비공개로 먼저 시도하고 안 되면 공개로 쓴다.
let access = 'private';
async function withAccess(fn) {
  try { return await fn(access); } catch (e) {
    if (!/access/i.test(e?.message || '') && e?.name !== 'BlobAccessError') throw e;
    access = access === 'private' ? 'public' : 'private';
    return fn(access);
  }
}

export async function listItems(id) {
  const dir = dirOf(id);
  let names;
  if (useBlob) {
    const { list } = await import('@vercel/blob');
    names = (await list({ prefix: dir, limit: 1000 })).blobs.map((b) => b.pathname.slice(dir.length));
  } else names = await readdir(join(local, dir)).catch(() => []);
  return names.map(parseName).filter(Boolean).sort((a, b) => b.at - a.at);
}

export async function addItem(id, title, text, keep = 30) {
  const dir = dirOf(id);
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}-${encodeURIComponent(title.slice(0, 60))}.json`;
  const body = JSON.stringify({ title, text });
  if (useBlob) {
    const { put } = await import('@vercel/blob');
    await withAccess((a) => put(dir + name, body, { access: a, addRandomSuffix: false, contentType: 'application/json' }));
  } else {
    await mkdir(join(local, dir), { recursive: true });
    await writeFile(join(local, dir, name), body);
  }
  const old = (await listItems(id)).slice(keep); // 오래된 것은 정리
  await Promise.all(old.map((o) => removeItem(id, o.item).catch(() => {})));
  return parseName(name);
}

export async function getItem(id, item) {
  if (!parseName(item)) return null;
  const dir = dirOf(id);
  if (useBlob) {
    const { get } = await import('@vercel/blob');
    const r = await withAccess((a) => get(dir + blobName(item), { access: a, useCache: false }));
    return r?.stream ? JSON.parse(await new Response(r.stream).text()) : null;
  }
  return readFile(join(local, dir, item), 'utf8').then(JSON.parse).catch(() => null);
}

export async function removeItem(id, item) {
  if (!parseName(item)) return;
  const dir = dirOf(id);
  if (useBlob) {
    const { del } = await import('@vercel/blob');
    await del(dir + blobName(item));
  } else await rm(join(local, dir, item), { force: true });
}
