// 브라우저 내장 음성합성(Web Speech API)으로 문장 단위 재생을 관리한다.
const synth = window.speechSynthesis;
const SPEAKABLE = /[\p{L}\p{N}]/u;

// 너무 긴 문장은 일부 브라우저에서 중간에 끊기므로 쉼표/공백 기준으로 나눠 읽는다.
export function splitLong(text, max = 160) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = Math.max(...[',', ';', ':', '、', '，', '·'].map((ch) => win.lastIndexOf(ch))) + 1;
    if (cut < max * 0.4) cut = win.lastIndexOf(' ') + 1;
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter((p) => SPEAKABLE.test(p));
}

// ── 온라인 AI 목소리 ────────────────────────────────
// 서버(/api/tts)가 Microsoft Edge 의 온라인 음성으로 MP3 를 만들어 준다. 연결이 안 되면 기기 목소리로 대신 읽는다.
// 목록은 api/tts.js 의 VOICES 와 맞춘다.
const cloudVoice = (id, name, lang) => ({ name: `${name} (AI 온라인)`, lang, voiceURI: 'cloud:' + id, cloud: id });
export const CLOUD_VOICES = [
  cloudVoice('ko-KR-SunHiNeural', '선희 · 여성', 'ko-KR'),
  cloudVoice('ko-KR-InJoonNeural', '인준 · 남성', 'ko-KR'),
  cloudVoice('ko-KR-HyunsuMultilingualNeural', '현수 · 남성', 'ko-KR'),
  cloudVoice('en-US-AriaNeural', 'Aria · 여성', 'en-US'),
  cloudVoice('en-US-JennyNeural', 'Jenny · 여성', 'en-US'),
  cloudVoice('en-US-GuyNeural', 'Guy · 남성', 'en-US'),
  cloudVoice('ja-JP-NanamiNeural', 'Nanami · 여성', 'ja-JP'),
  cloudVoice('ja-JP-KeitaNeural', 'Keita · 남성', 'ja-JP'),
  cloudVoice('zh-CN-XiaoxiaoNeural', 'Xiaoxiao · 여성', 'zh-CN'),
  cloudVoice('zh-CN-YunxiNeural', 'Yunxi · 남성', 'zh-CN'),
];
export const CLOUD_PART = 300; // 온라인 음성은 한 번에 이 길이까지 보낸다
const CLOUD_RETRY_MS = 60000; // 연결에 실패하면 이 시간 동안은 기기 목소리로 읽는다
export const cloudUrl = (voice, text) => new URL(`api/tts?voice=${voice.cloud}&text=${encodeURIComponent(text)}`, document.baseURI).href;

export class Player {
  chunks = [];
  i = 0;
  round = 1;
  state = 'idle'; // idle | playing | paused
  voice = null;
  rate = 1;
  repeat = 1; // 전체 반복 횟수, 0 = 무한
  loopOne = false; // 현재 문장만 계속 반복
  onchange = () => {};
  onerror = () => {};
  #gen = 0;
  #utter = null; // 재생 중 GC 되지 않도록 참조 유지
  #audio = null; // 온라인 목소리용. 아이폰은 사용자가 누른 뒤 만든 요소만 재생하므로 하나를 계속 쓴다.
  #cloudDownUntil = 0;

  get supported() { return !!synth || typeof Audio !== 'undefined'; }
  get #useCloud() { return !!this.voice?.cloud && Date.now() >= this.#cloudDownUntil; }

  load(chunks, index = 0) {
    this.#halt();
    this.chunks = chunks;
    this.i = Math.min(Math.max(0, index), Math.max(0, chunks.length - 1));
    this.round = 1;
    this.state = 'idle';
    this.onchange();
  }

  play() {
    if (!this.supported || !this.chunks.length) return;
    this.state = 'playing';
    this.onchange();
    this.#speak();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.#halt();
    this.state = 'paused';
    this.onchange();
  }

  toggle() { this.state === 'playing' ? this.pause() : this.play(); }

  stop() {
    this.#halt();
    this.state = 'idle';
    this.i = 0;
    this.round = 1;
    this.onchange();
  }

  seek(index) {
    if (!this.chunks.length) return;
    this.i = Math.min(Math.max(0, index), this.chunks.length - 1);
    this.onchange();
    if (this.state === 'playing') this.#speak();
  }

  // 목소리·속도를 바꾼 뒤 현재 문장을 새 설정으로 다시 읽는다.
  refresh() { if (this.state === 'playing') this.#speak(); }

  // 설정을 재생기에 전달한다 (앱 전용 재생기에서만 의미가 있다).
  sync() {}

  #halt() {
    this.#gen++;
    synth?.cancel();
    this.#audio?.pause();
  }

  // 온라인 목소리로 한 조각을 읽는다. upcoming 은 다음에 읽을 조각으로, 미리 받아 두어 문장 사이가 끊기지 않게 한다.
  #playCloud(text, gen, done, upcoming) {
    const a = (this.#audio ??= new Audio());
    const failed = () => {
      if (gen !== this.#gen) return;
      this.#cloudDownUntil = Date.now() + CLOUD_RETRY_MS;
      this.onerror('cloud');
      this.#speak(); // 같은 문장을 기기 목소리로 다시
    };
    a.onended = () => { if (gen === this.#gen) done(); };
    a.onerror = failed;
    a.src = cloudUrl(this.voice, text);
    a.defaultPlaybackRate = a.playbackRate = this.rate;
    a.play().catch((e) => {
      if (gen !== this.#gen || e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') { this.pause(); this.onerror('not-allowed'); } else failed();
    });
    if (upcoming) fetch(cloudUrl(this.voice, upcoming)).catch(() => {}); // 브라우저 저장소에 미리 받아 둔다
  }

  #speak() {
    const gen = ++this.#gen;
    const chunk = this.chunks[this.i];
    const cloud = this.#useCloud;
    const parts = splitLong(chunk.say || chunk.text, cloud ? CLOUD_PART : 160);
    let p = 0;
    const next = () => {
      if (gen !== this.#gen) return;
      if (p >= parts.length) return this.#advance();
      if (cloud) {
        const after = this.loopOne ? this.chunks[this.i] : this.chunks[this.i + 1];
        const upcoming = parts[p + 1] ?? (after ? splitLong(after.say || after.text, CLOUD_PART)[0] : null);
        return this.#playCloud(parts[p++], gen, next, upcoming);
      }
      if (!synth) { this.pause(); return this.onerror('no-voice'); }
      const u = new SpeechSynthesisUtterance(parts[p++]);
      // 온라인 목소리 대신 읽을 때는 기기가 그 언어의 기본 목소리를 고르게 둔다.
      if (this.voice && !this.voice.cloud) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = this.voice?.lang || 'ko-KR';
      u.rate = this.rate;
      u.onend = next;
      u.onerror = (e) => {
        if (gen !== this.#gen || e.error === 'interrupted' || e.error === 'canceled') return;
        this.pause();
        this.onerror(e.error);
      };
      this.#utter = u;
      synth.speak(u);
    };
    this.#audio?.pause();
    if (synth && (synth.speaking || synth.pending)) {
      synth.cancel();
      setTimeout(next, 80); // cancel 직후 speak 가 무시되는 브라우저 대응
    } else if (cloud) next(); // 누른 직후에 바로 재생을 시작해야 브라우저가 소리를 허락한다
    else setTimeout(next, 0);
  }

  #advance() {
    if (!this.loopOne) {
      if (this.i < this.chunks.length - 1) this.i++;
      else if (this.repeat === 0 || this.round < this.repeat) { this.round++; this.i = 0; }
      else {
        this.state = 'idle';
        this.i = 0;
        this.round = 1;
        this.onchange('end');
        return;
      }
    }
    this.onchange();
    this.#speak();
  }
}

// ── 안드로이드 앱 전용 재생기 ───────────────────────
// 앱(APK) 안에서는 화면이 꺼지거나 다른 앱을 써도 끊기지 않도록, 읽기를 앱의 재생 서비스에 맡긴다.
// 서비스가 문장 넘김·반복·오디오 포커스·알림창 조작을 모두 처리하고, 여기서는 상태만 받아 화면에 반영한다.
const native = window.ReadForMeNative || null;
export const isNative = !!native;

class NativePlayer extends Player {
  title = '';
  constructor() {
    super();
    window.__rfmState = (s) => {
      this.#apply(s);
      this.onchange(s.ev);
      if (s.error) this.onerror(s.error);
    };
  }
  get supported() { return true; }
  #apply(s) {
    this.state = s.state;
    if (s.n === this.chunks.length) { this.i = s.i; this.round = s.round; }
  }
  sync() {
    native.configure(JSON.stringify({ rate: this.rate, voice: this.voice?.voiceURI || '', repeat: this.repeat, loopOne: this.loopOne }));
  }
  load(chunks, index = 0, title = '') {
    this.chunks = chunks;
    this.title = title;
    this.i = Math.min(Math.max(0, index), Math.max(0, chunks.length - 1));
    this.round = 1;
    this.state = 'idle';
    this.sync();
    // 같은 글을 이미 읽는 중이면 서비스가 위치와 상태를 그대로 유지한다.
    native.load(JSON.stringify({ title, index: this.i, texts: chunks.map((c) => c.say || c.text) }));
    this.#apply(JSON.parse(native.state()));
    this.onchange();
  }
  play() {
    if (!this.chunks.length) return;
    this.sync();
    this.state = 'playing';
    this.onchange();
    native.play();
  }
  pause() { if (this.state === 'playing') native.pause(); }
  stop() { native.stop(); }
  seek(index) {
    if (!this.chunks.length) return;
    this.i = Math.min(Math.max(0, index), this.chunks.length - 1);
    this.onchange();
    native.seek(this.i);
  }
  refresh() { this.sync(); }
}

export const createPlayer = () => (native ? new NativePlayer() : new Player());

const voiceRank = (v) => (v.lang.startsWith('ko') ? 0 : v.lang.startsWith('en') ? 1 : 2);
const byLang = (a, b) => voiceRank(a) - voiceRank(b) || a.lang.localeCompare(b.lang);

// 온라인 AI 목소리를 앞에, 기기 목소리(연결이 안 될 때 대신 읽는 목소리)를 뒤에 둔다.
export function listVoices() {
  return [...CLOUD_VOICES, ...deviceVoices()].sort((a, b) => byLang(a, b) || !!b.cloud - !!a.cloud);
}

function deviceVoices() {
  if (native) {
    // 같은 언어 안에서는 품질이 높은 목소리를 앞에 둔다.
    const list = JSON.parse(native.voices() || '[]').sort((a, b) => byLang(a, b) || (b.quality || 0) - (a.quality || 0) || a.name.localeCompare(b.name));
    const count = {}; // 엔진이 주는 이름(ko-kr-x-ism-local 등)은 알아보기 어려워 번호를 붙인다
    return list.map((v) => ({ ...v, name: `폰 목소리 ${(count[v.lang] = (count[v.lang] || 0) + 1)}${v.online ? ' (온라인)' : ''}` }));
  }
  if (!synth) return [];
  return synth.getVoices().slice().sort((a, b) => byLang(a, b) || a.name.localeCompare(b.name));
}

// 일반 글을 문단/문장 단위 조각으로 나눈다.
export function textToChunks(text) {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'sentence' }) : null;
  const chunks = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const sentences = seg
      ? Array.from(seg.segment(t), (s) => s.segment)
      : t.match(/[^.!?。！？]+[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？]+$/g) || [t];
    let first = true;
    for (const s of sentences) {
      const st = s.trim();
      if (!st) continue;
      // 글자가 없는 조각(기호뿐)은 앞 문장에 붙인다.
      if (!SPEAKABLE.test(st) && !first) { chunks[chunks.length - 1].text += ' ' + st; continue; }
      chunks.push({ text: st, np: first });
      first = false;
    }
  }
  return chunks;
}

// 마크다운 기호(#, **, 표, 링크 등)를 소리 내어 읽기 좋은 글로 바꾼다.
export function mdToPlain(md) {
  return md.replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', '))
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>+[ \t]?/gm, '')
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_\n]+?)(?<=\S)\2(?=[\s).,!?:;]|$)/gm, '$1$3')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}
