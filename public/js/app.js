import { Player, listVoices, textToChunks } from './tts.js';
import { fileToDoc, linkToDoc } from './extract.js';
import * as bible from './bible.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('fr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fr.' + k, JSON.stringify(v)); } catch { /* 저장 공간 부족 등은 무시 */ } },
};
const player = new Player();
const PLAY = 'M7 4v16l14-8z', PAUSE = 'M6 4h4v16H6zM14 4h4v16h-4z';

// ── 상태 표시 ───────────────────────────────────────
function status(msg, isError) {
  $('status').hidden = !msg;
  $('status').textContent = msg || '';
  $('status').classList.toggle('err', !!isError);
}
async function run(task) {
  try { await task(); status(''); } catch (e) { console.error(e); status(e.message || '문제가 생겼습니다.', true); }
}

// ── 읽기 화면 ───────────────────────────────────────
let spans = [];
function showDoc(title, chunks, index = 0, autoplay = true) {
  if (!chunks.length) throw new Error('읽을 글이 없습니다.');
  $('title').textContent = title;
  const frag = document.createDocumentFragment();
  let p = null;
  spans = chunks.map((c, i) => {
    if (c.head || c.np || !p) { p = document.createElement(c.head ? 'h3' : 'p'); frag.append(p); }
    if (c.label) p.append(Object.assign(document.createElement('sup'), { textContent: c.label }));
    const s = Object.assign(document.createElement('span'), { className: 's', textContent: c.text });
    s.dataset.i = i;
    p.append(s, ' ');
    return s;
  });
  $('body').replaceChildren(frag);
  player.load(chunks, index);
  const json = JSON.stringify({ title, chunks });
  if (json.length < 2_000_000) store.set('doc', { title, chunks }); else store.set('doc', null);
  if (autoplay) {
    player.play();
    $('reader').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

$('body').addEventListener('click', (e) => {
  const s = e.target.closest('.s');
  if (!s) return;
  player.seek(+s.dataset.i);
  if (player.state !== 'playing') player.play();
});

let curEl = null, wake = null;
player.onchange = (ev) => {
  const n = player.chunks.length, playing = player.state === 'playing';
  $('play-icon').setAttribute('d', playing ? PAUSE : PLAY);
  $('play').setAttribute('aria-label', playing ? '일시정지' : '재생');
  $('seek').max = Math.max(0, n - 1);
  $('seek').value = player.i;
  const round = player.repeat !== 1 && player.state !== 'idle' ? ` · ${player.round}번째${player.repeat ? '/' + player.repeat + '번' : ''}` : '';
  $('pos').textContent = n ? `${player.i + 1} / ${n}${round}` : '0 / 0';
  const el = spans[player.i];
  if (el !== curEl) {
    curEl?.classList.remove('cur');
    curEl = el;
    if (el && player.state !== 'idle') {
      el.classList.add('cur');
      const r = el.getBoundingClientRect();
      const bottom = document.querySelector('.player').getBoundingClientRect().top;
      if (r.top < 70 || r.bottom > bottom - 20) window.scrollTo({ top: window.scrollY + r.top - (bottom - 60) / 3, behavior: 'smooth' });
    }
  } else if (el) el.classList.toggle('cur', player.state !== 'idle');
  if (n) store.set('pos', ev === 'end' ? 0 : player.i);
  if (playing && !wake) navigator.wakeLock?.request('screen').then((w) => { wake = w; w.onrelease = () => (wake = null); }).catch(() => {});
  if (!playing && wake) wake.release().catch(() => {});
};
player.onerror = (code) => status(code === 'not-allowed'
  ? '재생 버튼을 눌러 주세요.' : `음성 재생 중 문제가 생겼습니다 (${code}). 다른 목소리를 골라 보세요.`, true);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') player.onchange(); });

// ── 재생 조작 ───────────────────────────────────────
$('play').onclick = () => player.toggle();
$('stop').onclick = () => player.stop();
$('prev').onclick = () => player.seek(player.i - 1);
$('next').onclick = () => player.seek(player.i + 1);
$('seek').oninput = (e) => player.seek(+e.target.value);
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, button')) return;
  if (e.key === ' ') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowLeft') player.seek(player.i - 1);
  else if (e.key === 'ArrowRight') player.seek(player.i + 1);
});

// ── 설정: 목소리 · 속도 · 반복 ──────────────────────
function fillVoices() {
  const voices = listVoices(), sel = $('voice'), saved = store.get('voice', '');
  if (!voices.length) {
    sel.replaceChildren(new Option('기기 기본 목소리', ''));
    return;
  }
  const names = new Intl.DisplayNames(['ko'], { type: 'language' });
  const groups = new Map();
  for (const v of voices) {
    const lang = v.lang.replace('_', '-');
    let label = lang;
    try { label = names.of(lang) || lang; } catch { /* 알 수 없는 언어 코드 */ }
    if (!groups.has(label)) groups.set(label, Object.assign(document.createElement('optgroup'), { label }));
    groups.get(label).append(new Option(v.name.replace(/^Microsoft | Online \(Natural\).*$/g, ''), v.voiceURI));
  }
  sel.replaceChildren(...groups.values());
  const pick = voices.find((v) => v.voiceURI === saved) || voices.find((v) => v.lang.startsWith('ko')) || voices.find((v) => v.default) || voices[0];
  sel.value = pick.voiceURI;
  player.voice = pick;
}
if (player.supported) {
  fillVoices();
  speechSynthesis.addEventListener?.('voiceschanged', fillVoices);
} else status('이 브라우저는 음성 읽기를 지원하지 않습니다. 크롬, 엣지, 사파리에서 열어 주세요.', true);

$('voice').onchange = (e) => {
  player.voice = listVoices().find((v) => v.voiceURI === e.target.value) || null;
  store.set('voice', e.target.value);
  player.refresh();
};
let rateTimer;
function setRate(r, restart) {
  player.rate = r;
  $('rate').value = r;
  $('rate-out').textContent = r.toFixed(1) + '배';
  store.set('rate', r);
  clearTimeout(rateTimer);
  if (restart) rateTimer = setTimeout(() => player.refresh(), 300);
}
$('rate').oninput = (e) => setRate(+e.target.value, true);
setRate(store.get('rate', 1));
$('repeat').value = String(store.get('repeat', 1));
player.repeat = +$('repeat').value;
$('repeat').onchange = (e) => { player.repeat = +e.target.value; store.set('repeat', player.repeat); player.onchange(); };
$('loop-one').onchange = (e) => { player.loopOne = e.target.checked; };
const setOpts = (open) => { $('opts').hidden = !open; $('opts-btn').setAttribute('aria-expanded', open); store.set('opts', open); };
$('opts-btn').onclick = () => setOpts($('opts').hidden);
setOpts(store.get('opts', true));
let fs = store.get('fs', 19);
const setFs = (v) => { fs = Math.min(40, Math.max(14, v)); document.documentElement.style.setProperty('--fs', fs + 'px'); store.set('fs', fs); };
setFs(fs);
$('font-up').onclick = () => setFs(fs + 2);
$('font-down').onclick = () => setFs(fs - 2);

// ── 탭 ──────────────────────────────────────────────
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === name);
  $('tab-doc').hidden = name !== 'doc';
  $('tab-bible').hidden = name !== 'bible';
  store.set('tab', name);
  if (name === 'bible') initBible();
}
document.querySelector('.tabs').onclick = (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };

// ── 파일 · 링크 · 글 ────────────────────────────────
const openFile = (file) => run(async () => {
  player.pause();
  const doc = await fileToDoc(file, status);
  showDoc(doc.title, textToChunks(doc.text));
});
const openLink = (url) => run(async () => {
  player.pause();
  const doc = await linkToDoc(url, status);
  showDoc(doc.title, textToChunks(doc.text));
});
const URL_ONLY = /^(https?:\/\/\S+|www\.\S+\.\S+)$/i;
const openText = (text, title) => run(async () => {
  const t = text.trim();
  if (URL_ONLY.test(t)) return openLink(t);
  showDoc(title || t.slice(0, 30).replace(/\s+/g, ' ') + (t.length > 30 ? '…' : ''), textToChunks(t));
});

$('file').onchange = (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; };
$('link-form').onsubmit = (e) => { e.preventDefault(); const u = $('link').value.trim(); if (u) openLink(u); };
$('text-form').onsubmit = (e) => { e.preventDefault(); if ($('text').value.trim()) openText($('text').value); };
addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
addEventListener('dragleave', () => $('drop').classList.remove('over'));
addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const f = e.dataTransfer.files[0], t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (f) openFile(f); else if (t) openText(t);
});
addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea')) return;
  const f = e.clipboardData.files[0], t = e.clipboardData.getData('text/plain');
  if (f) openFile(f); else if (t.trim()) openText(t);
});

// ── 성경 ────────────────────────────────────────────
let bibleReady, hits = [], terms = [], shown = 0;
const picked = new Set();
const PAGE = 200;
const opts = (n, from = 0) => Array.from({ length: n - from }, (_, i) => new Option(i + from + 1, i + from));

function initBible() {
  return (bibleReady ??= (async () => {
    $('book').replaceChildren(...bible.BOOKS.map((b, i) => new Option(b.name, i)));
    $('scope').replaceChildren(new Option('전체', 'all'), new Option('구약', 'ot'), new Option('신약', 'nt'), new Option('고른 책', 'book'));
    status('성경 본문 불러오는 중…');
    try {
      const data = await bible.loadBible();
      status('');
      const b = () => +$('book').value;
      const setVerses = (sel, c, value) => { sel.replaceChildren(...opts(data[b()][c].length)); sel.value = value === 'last' ? data[b()][c].length - 1 : value; };
      const bookChanged = (c = 0) => {
        $('c1').replaceChildren(...opts(data[b()].length));
        $('c2').replaceChildren(...opts(data[b()].length));
        $('c1').value = $('c2').value = c;
        setVerses($('v1'), c, 0);
        setVerses($('v2'), c, 'last');
      };
      $('book').onchange = () => { bookChanged(); store.set('book', b()); };
      $('c1').onchange = () => {
        if (+$('c2').value < +$('c1').value) $('c2').value = $('c1').value;
        setVerses($('v1'), +$('c1').value, 0);
        setVerses($('v2'), +$('c2').value, 'last');
      };
      $('c2').onchange = () => {
        if (+$('c2').value < +$('c1').value) { $('c1').value = $('c2').value; setVerses($('v1'), +$('c1').value, 0); }
        setVerses($('v2'), +$('c2').value, 'last');
      };
      $('book').value = store.get('book', 0);
      bookChanged();
      return data;
    } catch (e) { bibleReady = undefined; status(e.message, true); throw e; }
  })());
}

function readVerses(data, verses) {
  showDoc(bible.describe(verses), bible.versesToChunks(data, verses, $('say-num').checked));
}

$('range-form').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const data = await initBible();
    const from = [+$('c1').value, +$('v1').value], to = [+$('c2').value, +$('v2').value];
    if (to[0] === from[0] && to[1] < from[1]) to[1] = from[1];
    readVerses(data, bible.rangeVerses(data, +$('book').value, from, to));
  });
};

$('search-form').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const data = await initBible(), q = $('q').value.trim();
    if (!q) return;
    const ref = bible.parseRef(q, data);
    if (ref) { // 구절 표기면 바로 읽기
      $('results').hidden = true;
      return readVerses(data, bible.rangeVerses(data, ref.b, ref.from, ref.to));
    }
    const scope = $('scope').value === 'book' ? $('book').value : $('scope').value;
    ({ hits, terms } = bible.search(data, q, scope));
    picked.clear();
    shown = 0;
    $('hits').replaceChildren();
    $('results').hidden = false;
    $('hits').hidden = !hits.length;
    renderHits(data);
  });
};

function renderHits(data) {
  const frag = document.createDocumentFragment();
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
  for (const [b, c, v] of hits.slice(shown, shown + PAGE)) {
    const li = document.createElement('li'), label = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value: `${b}.${c}.${v}` });
    const div = document.createElement('div');
    div.append(Object.assign(document.createElement('b'), { textContent: bible.refLabel(b, c, v) }));
    data[b][c][v].split(re).forEach((part, i) => div.append(i % 2 ? Object.assign(document.createElement('mark'), { textContent: part }) : part));
    label.append(cb, div);
    li.append(label);
    frag.append(li);
  }
  $('hits').append(frag);
  shown = Math.min(hits.length, shown + PAGE);
  $('more').hidden = shown >= hits.length;
  updateSel();
}
function updateSel() {
  $('count').textContent = hits.length ? `${hits.length.toLocaleString()}구절 찾음` + (shown < hits.length ? ` (${shown}개 표시)` : '') : '찾은 구절이 없습니다';
  $('read-sel').disabled = !picked.size;
  $('read-sel').textContent = picked.size ? `선택한 ${picked.size}구절 읽기` : '선택 구절 읽기';
  $('sel-all').hidden = !hits.length;
  $('sel-all').textContent = picked.size === hits.length ? '선택 해제' : '전체 선택';
}
$('more').onclick = () => initBible().then((data) => {
  renderHits(data);
  for (const cb of $('hits').querySelectorAll('input')) cb.checked = picked.has(cb.value);
});
$('hits').onchange = (e) => { e.target.checked ? picked.add(e.target.value) : picked.delete(e.target.value); updateSel(); };
$('sel-all').onclick = () => {
  const all = picked.size !== hits.length;
  picked.clear();
  if (all) hits.forEach((h) => picked.add(h.join('.')));
  for (const cb of $('hits').querySelectorAll('input')) cb.checked = all;
  updateSel();
};
$('read-sel').onclick = () => run(async () => {
  const data = await initBible();
  readVerses(data, hits.filter((h) => picked.has(h.join('.')))); // 성경 순서대로
});

// ── 시작: 공유로 받은 내용 또는 지난번에 읽던 글 ────
const params = new URLSearchParams(location.search);
const shared = [params.get('url'), params.get('text')].filter(Boolean).join(' ').trim();
if (shared) {
  history.replaceState(null, '', location.pathname);
  const url = /https?:\/\/\S+/.exec(shared)?.[0];
  if (url) { $('link').value = url; openLink(url); } else openText(shared, params.get('title'));
} else {
  const doc = store.get('doc', null);
  if (doc?.chunks?.length) run(async () => showDoc(doc.title, doc.chunks, store.get('pos', 0), false));
  if (store.get('tab', 'doc') === 'bible') showTab('bible');
}
