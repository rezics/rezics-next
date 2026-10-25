import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const media = join(import.meta.dir, '..', 'src', 'media');

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
