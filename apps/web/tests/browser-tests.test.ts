import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const tests = import.meta.dir;
const browser = /from 'playwright'/;
const interacts = /\.(?:click|dblclick|fill|press|type|check|tap|selectOption)\(/;

// An action before hydration reaches server-rendered markup without handlers, so it flakes on a loaded machine.
test('every browser test that interacts with a page waits for the hydration mark', async () => {
  const names = readdirSync(tests).filter((name) => name.endsWith('.test.ts'));
  expect(names.length).toBeGreaterThan(1);
  for (const name of names) {
    const text = await Bun.file(join(tests, name)).text();
    if (!browser.test(text) || !interacts.test(text)) continue;
    expect(text.includes('html[data-hydrated]'), name).toBe(true);
  }
});
