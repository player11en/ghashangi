// Link parsing and rewriting, tested in-browser so the real module runs with
// import.meta.env resolved by Vite.
//
// Usage: node test/links.mjs [url]   (needs the dev server running)

import { chromium } from 'playwright';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:5173/';
const failures = [];

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got:      ${actual}\n        expected: ${expected}`}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
await page.goto(URL_UNDER_TEST, { waitUntil: 'load', timeout: 60_000 });

const results = await page.evaluate(async () => {
  const drive = await import('/src/sources/drive.js');
  const url = await import('/src/sources/url.js');

  const ID = '1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW';

  const safe = (fn) => {
    try { return fn(); } catch (e) { return `THREW: ${e.name}`; }
  };

  return {
    // Every share-link shape Drive hands out.
    fileD: drive.parseDriveId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`),
    openId: drive.parseDriveId(`https://drive.google.com/open?id=${ID}`),
    ucId: drive.parseDriveId(`https://drive.google.com/uc?export=download&id=${ID}`),
    shortD: drive.parseDriveId(`https://drive.google.com/d/${ID}`),
    bareId: drive.parseDriveId(ID),
    withSpaces: drive.parseDriveId(`  https://drive.google.com/file/d/${ID}/view  `),
    garbage: drive.parseDriveId('https://example.com/model.glb'),
    empty: drive.parseDriveId(''),

    looksDrive: drive.looksLikeDriveLink(`https://drive.google.com/file/d/${ID}/view`),
    looksNotDrive: drive.looksLikeDriveLink('https://example.com/model.glb'),

    // Share-link rewriting.
    dropbox: safe(() => url.normalizeUrl('https://www.dropbox.com/s/abc123/model.glb?dl=0').url),
    github: safe(() => url.normalizeUrl('https://github.com/user/repo/blob/main/model.glb').url),
    direct: safe(() => url.normalizeUrl('https://example.com/a/model.glb').url),
    ftp: safe(() => url.normalizeUrl('ftp://example.com/model.glb').url),
    notAUrl: safe(() => url.normalizeUrl('just some text').url),

    // Filenames drive loader selection, so they must survive encoding.
    name1: url.filenameFromUrl('https://example.com/path/My%20Model.glb'),
    name2: url.filenameFromUrl('https://example.com/path/model.glb?token=xyz'),
  };
});

const ID = '1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW';

console.log('Drive id extraction');
check('  /file/d/{id}/view', results.fileD, ID);
check('  /open?id={id}', results.openId, ID);
check('  /uc?export=download&id={id}', results.ucId, ID);
check('  /d/{id}', results.shortD, ID);
check('  bare id', results.bareId, ID);
check('  surrounding whitespace', results.withSpaces, ID);
check('  non-Drive URL yields null', results.garbage, null);
check('  empty input yields null', results.empty, null);

console.log('\nDrive detection');
check('  recognises a Drive link', results.looksDrive, true);
check('  ignores a non-Drive link', results.looksNotDrive, false);

console.log('\nShare-link rewriting');
check('  dropbox -> dl.dropboxusercontent', results.dropbox, 'https://dl.dropboxusercontent.com/s/abc123/model.glb');
check('  github blob -> raw', results.github, 'https://raw.githubusercontent.com/user/repo/main/model.glb');
check('  direct link untouched', results.direct, 'https://example.com/a/model.glb');
check('  ftp rejected', results.ftp, 'THREW: InvalidUrlError');
check('  non-URL rejected', results.notAUrl, 'THREW: InvalidUrlError');

console.log('\nFilename extraction');
check('  percent-decoded', results.name1, 'My Model.glb');
check('  query string stripped', results.name2, 'model.glb');

await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
