// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  openSync,
  closeSync,
  writeSync,
  truncateSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import iconv from 'iconv-lite';
import { parseFile } from '../src/index.ts';
import { openTxtFile, TXT_LIMITS } from '../src/txt.ts';
const root = resolve(import.meta.dir, '../../..');
const temporary = () => mkdtempSync(resolve(root, '.temp/g848-stream-'));

test('G-848: TXT segments preserve every byte across chunk, encoding and long-line boundaries', () => {
  for (const encoding of ['utf8', 'utf16le', 'utf16be', 'shift_jis']) {
    const text =
      'Chapter 1\r\n' +
      '漢あ\r\n'.repeat(20_000) +
      'X'.repeat(300_000) +
      '\nChapter 2\n' +
      (encoding === 'shift_jis' ? '漢' : '😀').repeat(40_000);
    const bytes = iconv.encode(text, encoding, { addBOM: encoding.startsWith('utf') });
    const parsed = parseFile(bytes, 'txt', { encoding });
    expect(parsed.units.map((unit) => unit.text).join('')).toBe(text);
    expect(parsed.units.length).toBeGreaterThan(2);
    for (const unit of parsed.units) {
      if (unit.locator.selector.type !== 'ByteRangeSelector')
        throw new Error('Expected byte range');
      expect(unit.locator.selector.end - unit.locator.selector.start).toBeLessThanOrEqual(
        TXT_LIMITS.segmentBytes,
      );
      expect(parsed.verify(unit.locator).quote).toBe(unit.text);
      const end = Math.min(10, unit.text.length);
      const safeEnd = /[\uD800-\uDBFF]/.test(unit.text[end - 1]!) ? end - 1 : end;
      expect(parsed.verify(parsed.locate(unit, 0, safeEnd)).quote).toBe(
        unit.text.slice(0, safeEnd),
      );
    }
  }
});

test('G-848: CLI streams normal 10/50 MiB books below 384 MiB RSS instead of retaining per-byte Maps or stdout', () => {
  const temp = temporary();
  try {
    const peaks: number[] = [];
    for (const sizeMiB of [10, 50]) {
      const file = resolve(temp, `${sizeMiB}.txt`),
        fd = openSync(file, 'w');
      const chunk = Buffer.from('A plain line.\n'.repeat(4681).padEnd(64 * 1024, ' '));
      try {
        for (let i = 0; i < sizeMiB * 16; i++) writeSync(fd, chunk);
      } finally {
        closeSync(fd);
      }
      const child = spawnSync('bun', [resolve(import.meta.dir, 'txt-memory-probe.ts'), file], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.status).toBe(0);
      const rss = JSON.parse(child.stderr).maxRssKiB;
      expect(Number.isFinite(rss)).toBe(true);
      expect(rss).toBeLessThan(384 * 1024);
      peaks.push(rss);
    }
    expect(peaks[1]! - peaks[0]!).toBeLessThan(128 * 1024);
    console.error(`TXT stream RSS: 10 MiB=${peaks[0]} KiB; 50 MiB=${peaks[1]} KiB`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 90_000);

test('G-848: byte ceiling rejects oversize files before output and retained-unit ceiling bounds the convenience API', () => {
  const temp = temporary();
  try {
    const file = resolve(temp, 'oversize.txt');
    writeFileSync(file, '');
    truncateSync(file, TXT_LIMITS.inputBytes + 1);
    expect(() => openTxtFile(file)).toThrow('128 MiB input byte ceiling');
    const child = spawnSync(
      'bun',
      [resolve(root, 'packages/wiki-toolkit/src/cli.ts'), 'units', file],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('128 MiB input byte ceiling');
    expect(() => parseFile(new Uint8Array(TXT_LIMITS.inputBytes + 1), 'txt')).toThrow(
      '128 MiB input byte ceiling',
    );
    expect(() =>
      parseFile(Buffer.from('Chapter 1\n'.repeat(TXT_LIMITS.retainedUnits + 1)), 'txt'),
    ).toThrow('4096-unit in-memory ceiling');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('G-848: a TXT edit between hashing and iteration cannot emit a locator for altered text', () => {
  const temp = temporary();
  try {
    const file = resolve(temp, 'changed.txt');
    writeFileSync(file, 'Original text.\n');
    const stream = openTxtFile(file);
    try {
      writeFileSync(file, 'Changed text.\n');
      expect(() => [...stream.units]).toThrow('TXT file changed while reading');
    } finally {
      stream.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
