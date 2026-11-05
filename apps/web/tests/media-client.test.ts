import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validVariant } from '../src/media/download.ts';

const media = join(import.meta.dir, '..', 'src', 'media');

test('download syntax admits native small widths and the fixed ladder without granting a slot', () => {
  expect(validVariant('original')).toBe(true);
  for (const format of ['webp', 'avif']) {
    for (const width of [1, 9, 10, 99, 100, 160, 319, 320, 640, 960, 1280, 1920, 2560])
      expect(validVariant(`${format}-${width}`)).toBe(true);
    for (const width of [
      '0',
      '01',
      '0160',
      '-1',
      '+1',
      '1.5',
      '1e2',
      ' 160',
      '160 ',
      '160\n',
      '321',
      '639',
      '2561',
      '9999',
      '10000',
    ])
      expect(validVariant(`${format}-${width}`), `${format}-${width}`).toBe(false);
  }
  for (const variant of [
    'png-160',
    'WEBP-160',
    'original ',
    'original\n',
    'webp-%31',
    'webp-160%20',
    'webp-160%2f..',
    'webp-160/../original',
  ])
    expect(validVariant(variant), variant).toBe(false);
});

// The kernel client is the one authority for the media wire contract: the site keeps no copy of its paths or calls.
test('the media routes call the kernel only through its client', async () => {
  const sources = await Promise.all(
    readdirSync(media)
      .filter((name) => name.endsWith('.ts'))
      .map(async (name) => [name, await Bun.file(join(media, name)).text()] as const),
  );
  expect(sources.some(([, text]) => /from '@rezics\/client'/.test(text))).toBe(true);
  for (const [name, text] of sources) {
    expect(text, name).not.toMatch(/\bfetch\s*\(/);
    expect(text, name).not.toMatch(/\/v1\//);
  }
});
