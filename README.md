# 읽어줘 — 글 읽어주는 앱 (TTS)

파일, 링크, 붙여넣은 글, 성경(개역한글판)을 소리 내어 읽어주는 웹앱입니다.

## 기능

- **파일 읽기** — PDF(스캔본은 글자 인식), 한글(HWP·HWPX), 워드(DOC·DOCX), 파워포인트(PPT·PPTX), 엑셀(XLS·XLSX), EPUB, RTF, ODT, HTML, TXT·자막, 사진(JPG·PNG 등 글자 인식). 파일은 서버로 올라가지 않고 브라우저 안에서 처리됩니다.
- **링크 읽기** — 웹페이지 주소를 넣으면 본문만 골라 읽습니다. 링크가 PDF 같은 파일이면 파일로 읽습니다.
- **받은 글** — 앱마다 고유한 수신 주소가 있어, Claude 등 다른 곳에서 그 주소로 글(보고서)을 보내면 앱에 도착해 읽어줍니다. "도착하면 바로 읽기"를 켜 둘 수 있습니다.
- **목소리 · 속도** — 기기에 설치된 목소리 중 선택, 0.5~3배속.
- **반복** — 전체 2·3·5·10번 또는 계속 반복, 지금 문장만 반복.
- **성경 개역한글판** — 낱말 검색(전체·구약·신약·고른 책) 후 구절을 골라 읽기, `요 3:16` · `시 23편` · `창세기 1장 1-5절` 같은 표기로 바로 읽기, 책·장·절 범위 읽기.
- 문장을 누르면 그 자리부터 읽고, 읽던 글과 위치를 기억합니다.
- **앱으로 설치** — 홈 화면에 설치하면 주소창 없이 앱처럼 열리고, 한 번 연 화면과 성경은 인터넷 없이도 동작합니다. 안드로이드에서는 다른 앱의 공유 메뉴에서 파일·링크·글을 이 앱으로 보낼 수 있습니다.

## 실행

```bash
npm install
npm start        # http://localhost:3000
```

## 배포 (Vercel)

1. [vercel.com/new](https://vercel.com/new) 에서 이 저장소를 가져와 배포합니다. 설정은 `vercel.json` 에 들어 있어 바꿀 것이 없습니다.
2. "받은 글" 기능을 쓰려면 프로젝트의 **Storage → Create Database → Blob** 으로 저장소를 만들어 프로젝트에 연결하고(`BLOB_READ_WRITE_TOKEN` 이 자동으로 추가됨) 다시 배포합니다.

정적 파일은 `public/`, 링크 본문 추출은 `api/extract.js`, 받은 글 수신함은 `api/inbox.js` 서버리스 함수가 맡습니다.

## 다른 곳에서 글 보내기

앱의 "받은 글" 탭에 나오는 주소로 글을 POST 하면 됩니다. 주소에 들어 있는 `id` 가 열쇠이므로 남에게 알려주지 마세요.

```bash
curl -X POST "https://<배포 주소>/api/inbox?id=<내 id>&title=제목" \
  -H "Content-Type: text/markdown; charset=utf-8" --data-binary @report.md
```

본문은 일반 글·마크다운·HTML, 또는 JSON `{"title": "...", "text": "..."}` 을 받습니다 (최대 1MB, 최근 30편 보관).

## 안드로이드 앱 (APK)

`android/` 는 배포된 웹앱을 크롬 엔진으로 전체 화면에 띄우는 TWA(Trusted Web Activity) 프로젝트입니다. 음성 읽기가 일반 WebView 에서는 동작하지 않아 이 방식을 씁니다. 빌드된 파일은 `public/readforme.apk` 로 함께 배포됩니다.

```bash
cd android
ANDROID_HOME=<SDK 경로> READFORME_KEYSTORE=<키 파일> READFORME_KEYSTORE_PASSWORD=<암호> gradle assembleRelease
```

- 서명 키는 저장소에 넣지 않습니다. 같은 키로 서명해야 기존 설치본 위에 업데이트되고, `public/.well-known/assetlinks.json` 의 지문과 맞아야 주소창 없이 전체 화면으로 열립니다.
- 배포 주소가 바뀌면 `android/app/src/main/res/values/strings.xml` 의 주소를 바꿔 다시 빌드해야 합니다.

## 구조

- `public/js/tts.js` 재생 엔진 · `extract.js`/`office.js` 파일 글 추출 · `bible.js` 성경 검색 · `app.js` 화면
- `api/inbox.js` · `lib/store.js` 받은 글 수신함과 보관소
- `public/sw.js` · `manifest.webmanifest` 앱 설치·오프라인·공유받기
- `public/bible/krv.json` 개역한글판 본문 (66권)
- `scripts/build.mjs` 브라우저용 라이브러리를 `public/vendor/` 로 복사

## 알아둘 점

- 음성은 기기·브라우저에 내장된 목소리를 씁니다. 한국어 목소리가 없으면 기기 설정에서 한국어 음성을 설치하세요.
- 휴대폰에서 화면이 꺼지면 브라우저가 읽기를 멈출 수 있어, 읽는 동안 화면이 꺼지지 않게 유지합니다.
- 암호가 걸렸거나 배포용으로 잠긴 문서는 읽을 수 없습니다.
