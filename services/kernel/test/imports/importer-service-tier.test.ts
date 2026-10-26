import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('the importer runs on the service tier set through governance, with no budget override', () => {
  const directory = resolve(import.meta.dir);
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && name !== 'importer-service-tier.test.ts')
    .map((name) => [name, readFileSync(resolve(directory, name), 'utf8')] as const);
  expect(
    sources.filter(([, text]) => /\bupload\b\s*:|RATE_LIMIT_V1\s*\.\s*service/.test(text)).map(([name]) => name),
  ).toEqual([]);
  expect(sources.some(([, text]) => /:setRateTier\b/.test(text))).toBe(true);
});
