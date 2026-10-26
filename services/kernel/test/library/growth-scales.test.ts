import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scaleList = /\bscales\s*[:=]\s*\[([^\]]*)\]/g;

test('library growth checks keep the largest scale at most 4096 with an equal ratio of at least four', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(import.meta.dir).filter((name) => name.endsWith('.test.ts'))) {
    const source = readFileSync(resolve(import.meta.dir, file), 'utf8');
    for (const match of source.matchAll(scaleList)) {
      const scales = match[1]!
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => Number(value.replaceAll('_', '')));
      const ratios = scales.slice(1).map((scale, index) => scale / scales[index]!);
      const equal = ratios.every((ratio) => ratio === ratios[0]);
      if (scales.length !== 3 || scales.some(Number.isNaN) || Math.max(...scales) > 4096 || !equal || ratios[0]! < 4)
        offenders.push(`${file}: [${match[1]}]`);
    }
  }
  expect(offenders).toEqual([]);
});
