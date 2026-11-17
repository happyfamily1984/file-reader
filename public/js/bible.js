// 성경전서 개역한글판: 책 목록, 구절 찾기, 검색
const B = `창세기 창|출애굽기 출|레위기 레|민수기 민|신명기 신|여호수아 수|사사기 삿|룻기 룻|사무엘상 삼상|사무엘하 삼하|열왕기상 왕상|열왕기하 왕하|역대상 대상|역대하 대하|에스라 스|느헤미야 느|에스더 에|욥기 욥|시편 시|잠언 잠|전도서 전|아가 아|이사야 사|예레미야 렘|예레미야애가 애|에스겔 겔|다니엘 단|호세아 호|요엘 욜|아모스 암|오바댜 옵|요나 욘|미가 미|나훔 나|하박국 합|스바냐 습|학개 학|스가랴 슥|말라기 말|마태복음 마|마가복음 막|누가복음 눅|요한복음 요|사도행전 행|로마서 롬|고린도전서 고전|고린도후서 고후|갈라디아서 갈|에베소서 엡|빌립보서 빌|골로새서 골|데살로니가전서 살전|데살로니가후서 살후|디모데전서 딤전|디모데후서 딤후|디도서 딛|빌레몬서 몬|히브리서 히|야고보서 약|베드로전서 벧전|베드로후서 벧후|요한일서 요일|요한이서 요이|요한삼서 요삼|유다서 유|요한계시록 계`;
export const BOOKS = B.split('|').map((s) => { const [name, abbr] = s.split(' '); return { name, abbr }; });
export const NT_START = 39;

const alias = new Map();
BOOKS.forEach((b, i) => {
  alias.set(b.name, i);
  alias.set(b.abbr, i);
  const short = b.name.replace(/(복음|기|서)$/, '');
  if (short.length > 1 && !alias.has(short)) alias.set(short, i);
});
const aliasRe = [...alias.keys()].sort((a, b) => b.length - a.length).join('|');
const REF = new RegExp(`^(${aliasRe})\\s*(\\d+)\\s*(?:[:장편]\\s*(?:(\\d+)\\s*절?\\s*(?:[-~–]\\s*(\\d+)\\s*절?)?)?)?$`);

let data;
export function loadBible() {
  return (data ??= fetch('bible/krv.json').then((r) => {
    if (!r.ok) throw new Error('성경 본문을 불러오지 못했습니다.');
    return r.json();
  }).catch((e) => { data = undefined; throw e; }));
}

export const chapterTitle = (b, c) => `${BOOKS[b].name} ${c + 1}${b === 18 ? '편' : '장'}`;
export const refLabel = (b, c, v) => `${BOOKS[b].abbr} ${c + 1}:${v + 1}`;

// "요 3:16", "창세기 1장 1-5절", "시 23편" 같은 표기를 해석한다. 아니면 null.
export function parseRef(q, bible) {
  const m = REF.exec(q.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const b = alias.get(m[1]);
  let c = +m[2] - 1, v1 = m[3] ? +m[3] - 1 : null, v2 = m[4] ? +m[4] - 1 : v1;
  if (bible[b].length === 1 && v1 === null && c > 0) { v1 = v2 = c; c = 0; } // 한 장짜리 책: "유 3" → 1장 3절
  const ch = bible[b][c];
  if (!ch) return null;
  if (v1 === null) { v1 = 0; v2 = ch.length - 1; }
  v2 = Math.min(Math.max(v2, v1), ch.length - 1);
  if (v1 >= ch.length) return null;
  return { b, from: [c, v1], to: [c, v2] };
}

// 범위(시작 장:절 ~ 끝 장:절) 안의 구절 목록
export function rangeVerses(bible, b, from, to) {
  const out = [];
  for (let c = from[0]; c <= to[0]; c++) {
    const ch = bible[b][c];
    const s = c === from[0] ? from[1] : 0, e = c === to[0] ? to[1] : ch.length - 1;
    for (let v = s; v <= e; v++) out.push([b, c, v]);
  }
  return out;
}

// 구절 목록 → 읽기 조각. 장이 바뀔 때마다 제목을 넣는다.
export function versesToChunks(bible, verses, sayNumbers) {
  const chunks = [];
  let last = '';
  for (const [b, c, v] of verses) {
    const text = bible[b][c][v];
    if (!text) continue;
    const key = b + ':' + c;
    if (key !== last) { chunks.push({ text: chapterTitle(b, c), head: true }); last = key; }
    const chunk = { text, np: true, label: String(v + 1) };
    if (sayNumbers) chunk.say = `${v + 1}절. ${text}`;
    chunks.push(chunk);
  }
  return chunks;
}

export function describe(verses) {
  if (!verses.length) return '성경';
  const [b, c, v] = verses[0], [b2, c2, v2] = verses[verses.length - 1];
  const contiguous = verses.every(([x], i) => x === b) ;
  if (!contiguous) return `성경 ${verses.length}구절`;
  const a = `${BOOKS[b].name} ${c + 1}:${v + 1}`;
  if (c === c2 && v === v2) return a;
  return c === c2 ? `${a}-${v2 + 1}` : `${a} - ${c2 + 1}:${v2 + 1}`;
}

// 띄어쓰기로 나눈 낱말이 모두 들어 있는 구절을 찾는다. scope: all | ot | nt | 책 번호
export function search(bible, query, scope) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { terms, hits: [] };
  let [s, e] = [0, 65];
  if (scope === 'ot') e = NT_START - 1;
  else if (scope === 'nt') s = NT_START;
  else if (scope !== 'all') s = e = +scope;
  const hits = [];
  for (let b = s; b <= e; b++) {
    bible[b].forEach((ch, c) => ch.forEach((t, v) => { if (terms.every((w) => t.includes(w))) hits.push([b, c, v]); }));
  }
  return { terms, hits };
}
