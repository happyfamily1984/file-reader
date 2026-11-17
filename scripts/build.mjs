// node_modules 의 브라우저용 라이브러리를 public/vendor 로 복사한다 (CDN 없이 동작하도록).
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = (...p) => join(root, 'public', 'vendor', ...p);

rmSync(out(), { recursive: true, force: true });
for (const d of ['pdfjs', 'tesseract', 'tessdata']) mkdirSync(out(d), { recursive: true });

cpSync(nm('pdfjs-dist/build/pdf.min.mjs'), out('pdfjs/pdf.min.mjs'));
cpSync(nm('pdfjs-dist/build/pdf.worker.min.mjs'), out('pdfjs/pdf.worker.min.mjs'));
cpSync(nm('pdfjs-dist/cmaps'), out('pdfjs/cmaps'), { recursive: true });
cpSync(nm('pdfjs-dist/standard_fonts'), out('pdfjs/standard_fonts'), { recursive: true });
cpSync(nm('mammoth/mammoth.browser.min.js'), out('mammoth.min.js'));
cpSync(nm('jszip/dist/jszip.min.js'), out('jszip.min.js'));
cpSync(nm('cfb/dist/cfb.min.js'), out('cfb.min.js'));
cpSync(nm('tesseract.js/dist/tesseract.min.js'), out('tesseract/tesseract.min.js'));
cpSync(nm('tesseract.js/dist/worker.min.js'), out('tesseract/worker.min.js'));
for (const f of readdirSync(nm('tesseract.js-core'))) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) cpSync(nm('tesseract.js-core', f), out('tesseract', f));
}
for (const lang of ['kor', 'eng']) {
  cpSync(nm(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), out(`tessdata/${lang}.traineddata.gz`));
}
console.log('vendor 파일 복사 완료 → public/vendor');
