// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFile, checkLocator } from '../src/index.ts';
import { epubFixture } from './epub-fixture.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../tests/fixtures/wiki-toolkit/${name}`, import.meta.url));
const root = resolve(import.meta.dir, '../../..');
const pride = Buffer.from(
  JSON.parse(
    readFileSync(
      resolve(
        root,
        'tests/fixtures/gutenberg/6f7ec2a018dd7b7ddaed1e6117e299c25945faa082880fe63fb0b51a722b7ccb.json',
      ),
      'utf8',
    ),
  ).text,
);
function roundtrip(bytes: Uint8Array, format: 'txt' | 'epub' | 'rpy', encoding?: string) {
  const parsed = parseFile(bytes, format, { encoding });
  expect(parsed.units.length).toBeGreaterThan(0);
  for (const unit of parsed.units) {
    expect(checkLocator(unit.locator)).toBe(true);
    expect(parsed.verify(unit.locator).quote).toBe(unit.text);
    const changed = Uint8Array.from(bytes);
    changed[changed.length - 1] ^= 1;
    // Hash mismatch fails before selector resolution even if the mutation remains parseable.
    if (format !== 'epub')
      expect(() => parseFile(changed, format, { encoding }).verify(unit.locator)).toThrow();
  }
  return parsed;
}
test('G-848: every Pride and Prejudice TXT and EPUB 2/3 chapter locator round-trips', () => {
  const txt = roundtrip(pride, 'txt');
  expect(txt.units.length).toBeGreaterThanOrEqual(61);
  for (const version of ['2.0', '3.0'] as const)
    roundtrip(epubFixture(pride.toString(), { version }), 'epub');
});
test('G-848: original CRLF, BOM, non-BMP and Shift_JIS bytes are located exactly', () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be', 'windows1252', 'latin1', 'ascii']) {
    const text = ['windows1252', 'latin1', 'ascii'].includes(encoding)
      ? 'Chapter 1\r\nA line.\r\n'
      : 'Chapter 1\r\nA😀 line.\r\n';
    const iconv = require('iconv-lite');
    const bytes = iconv.encode(text, encoding, { addBOM: encoding.startsWith('utf') });
    const parsed = roundtrip(bytes, 'txt', encoding),
      unit = parsed.units[0]!;
    const start = unit.text.indexOf('line');
    const locator = parsed.locate(unit, start, start + 4);
    expect(parsed.verify(locator).quote).toBe('line');
    if (locator.selector.type === 'ByteRangeSelector')
      expect(
        iconv.decode(bytes.subarray(locator.selector.start, locator.selector.end), encoding),
      ).toBe('line');
  }
  const bytes = fixture('pride-shift-jis.txt');
  for (const encoding of ['Shift_JIS', undefined]) {
    const parsed = roundtrip(bytes, 'txt', encoding);
    expect(parsed.units[0]!.text).toBe(fixture('pride-shift-jis.utf8.txt').toString());
    expect(parsed.units[0]!.decoding?.uncertain).toBe(!encoding);
  }
  expect(() => parseFile(new Uint8Array([0xff, 0x01]), 'txt')).toThrow();
  expect(() => parseFile(new Uint8Array([0xff]), 'txt', { encoding: 'utf8' })).toThrow();
});
test('G-848: CFI counts UTF-16, escapes IDs, separates ruby and skips scripts', () => {
  const bytes = epubFixture('', {
    markup: 'A😀<ruby>漢<rt>かん</rt><rp>(</rp><rp>)</rp></ruby>Z<![CDATA[!]]><!-- inert -->?',
  });
  const parsed = roundtrip(bytes, 'epub');
  const unit = parsed.units[0]!;
  expect(unit.text).toBe('A😀漢Z!?');
  expect(unit.ruby).toEqual([{ base: '漢', reading: 'かん', start: 3, end: 4 }]);
  expect(unit.label).toBe('Chapter one');
  expect(parsed.units[1]!.text).toBe('Second spine item.');
  const range = parsed.locate(unit, 1, 3);
  expect(range.selector.type === 'EpubCfiSelector' && range.selector.cfi).toContain(':3)');
  expect(parsed.verify(range).quote).toBe('😀');
  expect(() => parsed.locate(unit, 1, 2)).toThrow();
  const across = parsed.locate(unit, 1, 6);
  expect(parsed.verify(across).quote).toBe('😀漢Z!');
  const fallback = structuredClone(across);
  if (fallback.selector.type === 'EpubCfiSelector')
    fallback.selector.cfi = 'epubcfi(/6/2!/4,/900/1:0,/900/1:2)';
  expect(parsed.verify(fallback)).toMatchObject({ quote: '😀漢Z!', resolution: 'quote-fallback' });
  const changed = epubFixture('changed');
  expect(() => parseFile(changed, 'epub').verify(unit.locator)).toThrow('different representation');
});
test('G-848: only obfuscated fonts are tolerated; protected content and entity declarations fail plainly', () => {
  roundtrip(epubFixture('Plain text', { encryption: 'font' }), 'epub');
  expect(() => parseFile(epubFixture('Protected', { encryption: 'content' }), 'epub')).toThrow(
    'Protected EPUB',
  );
  expect(() => parseFile(new Uint8Array([1, 2, 3]), 'epub')).toThrow(
    'Unsupported or protected EPUB',
  );
  expect(() =>
    parseFile(epubFixture('', { markup: '<!ENTITY steal SYSTEM="file:///etc/passwd">' }), 'epub'),
  ).toThrow('entity declaration');
});
test('G-848: Ren’Py preserves branch guards, jumps, dynamic speakers and distinct repeated lines without executing Python', () => {
  const parsed = roundtrip(fixture('pride.rpy'), 'rpy');
  const lines = parsed.units.filter(
    (unit) => unit.text === 'It is a truth universally acknowledged.',
  );
  expect(lines).toHaveLength(4);
  expect(new Set(lines.map((unit) => JSON.stringify(unit.locator))).size).toBe(4);
  expect(parsed.units.map((unit) => unit.text).join(' ')).not.toMatch(
    /THIS MUST|Python, not|Unreachable/,
  );
  const dynamic = parsed.units.find(
    (unit) => unit.label === 'start' && unit.route?.some((guard) => guard.includes('if staying')),
  )!;
  expect(dynamic.speaker).toBe(null);
  expect(dynamic.jumps).toContain('home');
  const elizabeth = parsed.units.find((unit) => unit.speaker === 'elizabeth')!;
  expect(elizabeth.route?.some((guard) => guard.includes('choice-'))).toBe(true);
  expect(elizabeth.jumps).toContain('visit');
  const locator = structuredClone(elizabeth.locator);
  if (locator.selector.type === 'ScriptSelector') locator.selector.route = ['other'];
  expect(() => parsed.verify(locator)).toThrow('route guard');
  expect(parsed.verify(parsed.locate(elizabeth, 0, 20)).quote).toBe(elizabeth.text.slice(0, 20));
});

test('G-848: units then verify on stdin round-trips every fixture locator through the actual CLI', () => {
  const temp = mkdtempSync(resolve(root, '.temp/g848-cli-'));
  const cli = resolve(root, 'packages/wiki-toolkit/src/cli.ts');
  try {
    const fixtures: [string, Uint8Array, string[]][] = [
      ['pride.txt', pride, []],
      ['pride.rpy', fixture('pride.rpy'), []],
      ['shift.txt', fixture('pride-shift-jis.txt'), ['--encoding', 'Shift_JIS']],
      ['pride2.epub', epubFixture(pride.toString(), { version: '2.0' }), []],
      ['pride3.epub', epubFixture(pride.toString()), []],
      ['nonbmp.epub', epubFixture('A😀B'), []],
    ];
    for (const [name, bytes, options] of fixtures) {
      const file = resolve(temp, name);
      writeFileSync(file, bytes);
      const output = execFileSync('bun', [cli, 'units', file, ...options], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of output.trim().split('\n')) {
        const unit = JSON.parse(line);
        const verified = JSON.parse(
          execFileSync('bun', [cli, 'verify', file, '-', ...options], {
            input: JSON.stringify(unit.locator),
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
          }),
        );
        expect(verified.quote).toBe(unit.text);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 60_000);

test('G-848: bad byte boundaries, fallback contexts and unsafe script blocks are rejected or skipped', () => {
  const txt = parseFile(Buffer.from('A😀B'), 'txt');
  const locator = txt.locate(txt.units[0]!, 1, 3);
  const split = structuredClone(locator);
  if (split.selector.type === 'ByteRangeSelector') split.selector.start++;
  expect(() => txt.verify(split)).toThrow('boundaries');
  const context = structuredClone(locator);
  context.quote!.prefix = 'wrong';
  expect(() => txt.verify(context)).toThrow('quote does not match');
  expect(() => parseFile(Buffer.from([0x00, 0xd8]), 'txt', { encoding: 'utf16le' })).toThrow(
    'surrogate',
  );
  const script = parseFile(
    Buffer.from(
      'label start:\n    python early:\n        "must not be a unit"\n    custom_block:\n        "also skipped"\n    "kept"\n',
    ),
    'rpy',
  );
  expect(script.units.map((unit) => unit.text)).toEqual(['kept']);
  const epub = parseFile(epubFixture('A😀B'), 'epub');
  const forged = structuredClone(epub.units[0]!.locator);
  if (forged.selector.type === 'EpubCfiSelector')
    forged.selector.cfi = forged.selector.cfi.replace('[body]', '[wrong]');
  delete forged.quote;
  expect(() => epub.verify(forged)).toThrow('cannot be resolved');
});

test('G-848: returned units cannot be edited into forged hash-pinned verification results', () => {
  const parsed = parseFile(fixture('pride.rpy'), 'rpy');
  const unit = parsed.units[0]!;
  const original = unit.text;
  expect(() => {
    unit.text = 'forged';
  }).toThrow();
  expect(() => {
    unit.locator.source.type = 'hosted';
  }).toThrow();
  expect(parsed.verify(unit.locator).quote).toBe(original);
});
