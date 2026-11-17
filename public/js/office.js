// 옛 바이너리 문서(HWP, DOC, PPT, XLS)와 RTF 에서 글을 뽑아낸다.
// cfb: CFB.read() 결과, find(path): 스트림 내용(Uint8Array) 또는 null 을 돌려주는 함수를 받는다.
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf16 = new TextDecoder('utf-16le');
const cp1252 = new TextDecoder('windows-1252');

async function inflateRaw(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch (e) {
    // 한글 파일은 압축 데이터 뒤에 여분 바이트가 붙는 일이 있어, 이미 풀린 내용이 있으면 그대로 쓴다.
    if (!parts.length) throw new Error('한글 문서의 압축을 풀지 못했습니다.');
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

// ── HWP 5.0 ─────────────────────────────────────────
export async function hwpText(find, names) {
  const head = find('FileHeader');
  if (!head) throw new Error('한글 3.0 이하의 아주 오래된 HWP 형식은 지원하지 않습니다. 한글에서 다시 저장해 주세요.');
  const flags = u32(head, 36);
  if (flags & 2) throw new Error('암호가 걸린 한글 문서는 읽을 수 없습니다.');
  const dir = flags & 4 ? 'ViewText' : 'BodyText';
  if (flags & 4) throw new Error('배포용으로 잠긴 한글 문서는 읽을 수 없습니다.');
  const sections = names.map((n) => new RegExp(`${dir}/Section(\\d+)$`).exec(n)).filter(Boolean)
    .sort((a, b) => a[1] - b[1]).map((m) => `${dir}/Section${m[1]}`);
  const paras = [];
  for (const name of sections) {
    let b = find(name);
    if (flags & 1) b = await inflateRaw(b);
    for (let o = 0; o + 4 <= b.length;) {
      const h = u32(b, o);
      let size = h >>> 20;
      o += 4;
      if (size === 0xfff) { size = u32(b, o); o += 4; }
      if ((h & 0x3ff) === 67) paras.push(hwpParaText(b, o, size)); // HWPTAG_PARA_TEXT
      o += size;
    }
  }
  return paras.join('\n');
}
function hwpParaText(b, start, size) {
  let out = '';
  for (let o = start; o + 1 < start + size; o += 2) {
    const c = u16(b, o);
    if (c >= 32) out += String.fromCharCode(c);
    else if (c === 10 || c === 13) out += '\n';
    else if (c === 0) continue;
    else if (c >= 24) out += c === 24 ? '-' : ' ';
    else { if (c === 9) out += ' '; o += 14; } // 확장/인라인 컨트롤: 8글자 분량
  }
  return out;
}

// ── DOC (Word 97-2003) ──────────────────────────────
export function docText(find) {
  const w = find('WordDocument');
  if (!w) throw new Error('워드 문서 내용을 찾지 못했습니다.');
  const fl = u16(w, 0x0a);
  if (fl & 0x0100) throw new Error('암호가 걸린 워드 문서는 읽을 수 없습니다.');
  const t = find(fl & 0x0200 ? '1Table' : '0Table');
  const ccpText = u32(w, 0x4c);
  let o = u32(w, 0x1a2);
  const end = o + u32(w, 0x1a6);
  while (o < end && t[o] === 1) o += 3 + u16(t, o + 1);
  if (t[o] !== 2) throw new Error('워드 문서 구조를 해석하지 못했습니다.');
  const lcb = u32(t, o + 1), base = o + 5, n = (lcb - 4) / 12;
  let text = '';
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const len = u32(t, base + (i + 1) * 4) - u32(t, base + i * 4);
    const fc = u32(t, base + (n + 1) * 4 + i * 8 + 2);
    text += fc & 0x40000000
      ? cp1252.decode(w.subarray((fc & 0x3fffffff) / 2, (fc & 0x3fffffff) / 2 + len))
      : utf16.decode(w.subarray(fc, fc + len * 2));
  }
  return text.slice(0, ccpText)
    .replace(/\x13[^\x14\x15]*\x14/g, '').replace(/\x13[^\x15]*\x15/g, '') // 필드 코드
    .replace(/[\r\x07\x0b\x0c]/g, '\n').replace(/[\x00-\x08\x0e-\x1f]/g, '');
}

// ── PPT (PowerPoint 97-2003) ────────────────────────
export function pptText(find) {
  const b = find('PowerPoint Document');
  if (!b) throw new Error('프레젠테이션 내용을 찾지 못했습니다.');
  const out = [];
  (function walk(o, end) {
    while (o + 8 <= end) {
      const ver = b[o] & 0x0f, type = u16(b, o + 2), len = u32(b, o + 4), body = o + 8;
      if (ver === 0x0f) walk(body, Math.min(end, body + len));
      else if (type === 4000) out.push(utf16.decode(b.subarray(body, body + len)));
      else if (type === 4008) out.push(cp1252.decode(b.subarray(body, body + len)));
      o = body + len;
    }
  })(0, b.length);
  return out.filter((s) => !/^(\*|Click to edit|마스터 )/.test(s)).join('\n').replace(/[\r\x0b]/g, '\n');
}

// ── XLS (Excel 97-2003): 문자열 표(SST)만 읽는다 ────
export function xlsText(find) {
  const b = find('Workbook') || find('Book');
  if (!b) throw new Error('엑셀 내용을 찾지 못했습니다.');
  const segs = []; // SST 와 뒤따르는 CONTINUE 조각들
  for (let o = 0, inSst = false; o + 4 <= b.length;) {
    const type = u16(b, o), len = u16(b, o + 2);
    if (type === 0x00fc) { inSst = true; segs.push([o + 4, o + 4 + len]); }
    else if (type === 0x003c && inSst) segs.push([o + 4, o + 4 + len]);
    else if (inSst) break;
    o += 4 + len;
  }
  if (!segs.length) return '';
  let s = 0, o = segs[0][0] + 8;
  const total = u32(b, segs[0][0] + 4), out = [];
  const fix = () => { while (s < segs.length && o >= segs[s][1]) { const over = o - segs[s][1]; s++; if (s < segs.length) o = segs[s][0] + over; } return s < segs.length; };
  for (let i = 0; i < total && fix(); i++) {
    let cch = u16(b, o), fl = b[o + 2];
    o += 3;
    const runs = fl & 8 ? u16(b, o) : 0; if (fl & 8) o += 2;
    const ext = fl & 4 ? u32(b, o) : 0; if (fl & 4) o += 4;
    let str = '';
    while (cch > 0) {
      if (o >= segs[s][1]) { if (++s >= segs.length) break; o = segs[s][0]; fl = b[o++]; } // 이어지는 조각은 새 플래그로 시작
      const wide = fl & 1, room = Math.min(cch, Math.floor((segs[s][1] - o) / (wide ? 2 : 1)));
      if (room <= 0) break;
      str += wide ? utf16.decode(b.subarray(o, o + room * 2)) : cp1252.decode(b.subarray(o, o + room));
      o += room * (wide ? 2 : 1);
      cch -= room;
    }
    o += runs * 4 + ext;
    if (str.trim()) out.push(str);
  }
  return out.join('\n');
}

// ── RTF ─────────────────────────────────────────────
const CHARSET_CP = { 0: 1252, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
const CP_NAME = { 949: 'euc-kr', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 874: 'windows-874', 1361: 'euc-kr' };
const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr',
  'object', 'themedata', 'datastore', 'colorschememapping', 'latentstyles', 'generator', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'fldinst', 'filetbl', 'revtbl']);
export function rtfText(bytes) {
  const src = new TextDecoder('latin1').decode(bytes);
  const fonts = {};
  for (const m of src.matchAll(/\\f(\d+)[^{};]*?\\fcharset(\d+)/g)) fonts[m[1]] = CHARSET_CP[m[2]];
  let defCp = +(/\\ansicpg(\d+)/.exec(src)?.[1] || 1252);
  const dec = {};
  const decode = (arr, cp) => (dec[cp] ??= (() => { try { return new TextDecoder(CP_NAME[cp] || 'windows-' + cp); } catch { return cp1252; } })()).decode(new Uint8Array(arr));
  let out = '', pend = [], st = { skip: false, cp: defCp, uc: 1 }, toSkip = 0;
  const stack = [];
  const flush = () => { if (pend.length) { out += decode(pend, st.cp); pend = []; } };
  const re = /\\([a-z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-z'])|([{}])|[\r\n]+|([^\\{}\r\n]+)/g;
  for (let m; (m = re.exec(src));) {
    if (m[5] === '{') { flush(); stack.push(st); st = { ...st }; }
    else if (m[5] === '}') { flush(); st = stack.pop() || st; }
    else if (st.skip) continue;
    else if (m[1]) {
      const w = m[1], n = m[2] === undefined ? null : +m[2];
      if (SKIP.has(w)) st.skip = true;
      else if (w === 'par' || w === 'line' || w === 'row' || w === 'sect' || w === 'page') { flush(); out += '\n'; }
      else if (w === 'tab' || w === 'cell') { flush(); out += ' '; }
      else if (w === 'u' && n !== null) { flush(); out += String.fromCharCode(n < 0 ? n + 65536 : n); toSkip = st.uc; }
      else if (w === 'uc' && n !== null) st.uc = n;
      else if (w === 'f' && n !== null) { flush(); st.cp = fonts[n] || defCp; }
      else if (w === 'bin' && n) re.lastIndex += n;
    } else if (m[3]) { if (toSkip > 0) toSkip--; else pend.push(parseInt(m[3], 16)); }
    else if (m[4]) {
      if (m[4] === '*') st.skip = true;
      else if (m[4] === '~') { flush(); out += ' '; }
      else if ('\\{}'.includes(m[4])) { flush(); out += m[4]; }
    } else if (m[6]) {
      let t = m[6];
      if (toSkip > 0) { const k = Math.min(toSkip, t.length); t = t.slice(k); toSkip -= k; }
      for (let i = 0; i < t.length; i++) pend.push(t.charCodeAt(i) & 0xff);
    }
  }
  flush();
  return out;
}
