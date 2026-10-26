import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';

const directory = new URL('./', import.meta.url);
const asymmetric =
  /expect\.(?:any|anything|arrayContaining|objectContaining|stringContaining|stringMatching|closeTo)\(/;

/** Each `.toMatchObject(` call in one test file whose expected value holds an asymmetric matcher, as `file:line`. */
function asymmetricMatchObjects(file: string, text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf('.toMatchObject('); start !== -1; start = text.indexOf('.toMatchObject(', start + 1)) {
    let end = start + '.toMatchObject('.length;
    for (let depth = 1; depth > 0 && end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')') depth--;
    }
    if (asymmetric.test(text.slice(start, end))) found.push(`${file}:${text.slice(0, start).split('\n').length}`);
  }
  return found;
}

// Bun's toMatchObject writes each asymmetric matcher into the value it checks, frozen or not. A test that matches
// the shared bundled release that way changes it for every later test file in the same run.
test('no definitions test hands toMatchObject an asymmetric matcher', async () => {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  const found: string[] = [];
  for (const file of files)
    found.push(...asymmetricMatchObjects(file, await Bun.file(new URL(file, directory)).text()));
  expect(found).toEqual([]);
});
