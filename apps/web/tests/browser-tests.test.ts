import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const tests = import.meta.dir;
const browser = /from 'playwright'/;
const interacts = /\.(?:click|dblclick|fill|press|type|check|tap|selectOption)\(/;

function contextOptions(source: string): string[] {
  const options: string[] = [];
  const calls = /\bnewContext\s*\(/g;
  let call: RegExpExecArray | null;
  while ((call = calls.exec(source))) {
    const opening = calls.lastIndex - 1;
    let depth = 1;
    let quote: string | undefined;
    let escaped = false;
    for (let index = opening + 1; index < source.length; index += 1) {
      const character = source[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')' && --depth === 0) {
        options.push(source.slice(opening + 1, index));
        break;
      }
    }
  }
  return options;
}

// An action before hydration reaches server-rendered markup without handlers, so it flakes on a loaded machine.
test('every browser test that interacts with a page waits for the hydration mark', async () => {
  const names = readdirSync(tests).filter((name) => name.endsWith('.test.ts'));
  expect(names.length).toBeGreaterThan(1);
  for (const name of names) {
    const text = await Bun.file(join(tests, name)).text();
    if (!browser.test(text) || !interacts.test(text)) continue;
    const contexts = contextOptions(text);
    if (contexts.length > 0 && contexts.every((options) => /\bjavaScriptEnabled\s*:\s*false\b/.test(options))) continue;
    expect(text.includes('html[data-hydrated]'), name).toBe(true);
  }
});
