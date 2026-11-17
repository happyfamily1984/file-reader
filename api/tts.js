// GET /api/tts?voice=ko-KR-SunHiNeural&text=읽을 글
// Microsoft Edge 의 "소리 내어 읽기" 온라인 음성으로 글을 MP3 로 만들어 돌려준다. API 키가 필요 없다.
// 공식으로 제공되는 API 가 아니라서 Microsoft 쪽 변경으로 예고 없이 막힐 수 있다.
// 그때는 앱이 기기 내장 목소리로 대신 읽는다.
import edge from 'msedge-tts';

const { MsEdgeTTS, OUTPUT_FORMAT } = edge;
const MAX_TEXT = 600;

// 앱의 목소리 목록(public/js/tts.js 의 CLOUD_VOICES)과 맞춘다.
export const VOICES = new Set([
  'ko-KR-SunHiNeural', 'ko-KR-InJoonNeural', 'ko-KR-HyunsuMultilingualNeural',
  'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural',
  'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural',
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural',
]);

const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

async function synthesize(voice, text) {
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 15000 });
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text));
    const chunks = [];
    for await (const c of audioStream) chunks.push(c);
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error('empty audio');
    return audio;
  } finally {
    try { tts.close(); } catch { /* 이미 닫힘 */ }
  }
}

export default async function handler(req, res) {
  const fail = (status, error) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error }));
  };
  if (req.method !== 'GET') return fail(405, '지원하지 않는 요청입니다.');
  const q = new URL(req.url, 'http://x').searchParams;
  const voice = q.get('voice') || '';
  const text = (q.get('text') || '').replace(/\s+/g, ' ').trim();
  if (!VOICES.has(voice)) return fail(400, '지원하지 않는 목소리입니다.');
  if (!text) return fail(400, '읽을 글이 없습니다.');
  if (text.length > MAX_TEXT) return fail(413, `한 번에 ${MAX_TEXT}자까지만 읽을 수 있습니다.`);

  let audio, lastError;
  for (let attempt = 0; attempt < 2 && !audio; attempt++) { // 연결이 한 번 끊기는 일이 잦아 한 번 더 시도한다
    try { audio = await synthesize(voice, text); } catch (e) { lastError = e; }
  }
  if (!audio) {
    console.error('tts failed:', lastError?.message || lastError);
    return fail(502, '온라인 음성을 만들지 못했습니다.');
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'audio/mpeg');
  res.setHeader('content-length', audio.length);
  // 같은 목소리·같은 문장은 결과가 같으므로 오래 저장해 둔다 (반복 읽기·다시 듣기에 빠르다).
  res.setHeader('cache-control', 'public, max-age=2592000, s-maxage=2592000, immutable');
  res.end(audio);
}
