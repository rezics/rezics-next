import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const messagesDirectory = join(import.meta.dir, '..', 'messages');

// Code-point order, with `$schema` first when present.
function sortedKeys(keys: readonly string[]): string[] {
  const rest = keys.filter((key) => key !== '$schema').sort();
  return keys.includes('$schema') ? ['$schema', ...rest] : rest;
}

function interpolationNames(message: string): string[] {
  return [...new Set(message.match(/\{[A-Za-z_][A-Za-z_0-9]*\}/g))].sort();
}

test("every locale's site messages have the same keys, sorted by key", () => {
  const files = readdirSync(messagesDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const locales = files.map((file) => ({
    locale: file.slice(0, -5),
    messages: JSON.parse(readFileSync(join(messagesDirectory, file), 'utf8')) as Record<string, unknown>,
  }));
  const english = locales.find((entry) => entry.locale === 'en');
  expect(english, 'English messages').toBeDefined();
  const expectedKeys = sortedKeys(Object.keys(english!.messages));
  const invalidMessages: string[] = [];

  for (const { locale, messages } of locales) {
    const keys = Object.keys(messages);
    expect(keys, `${locale} keys are sorted`).toEqual(sortedKeys(keys));
    expect(sortedKeys(keys), `${locale} keys match English`).toEqual(expectedKeys);
    for (const key of expectedKeys) {
      if (key === '$schema') continue;
      const source = english!.messages[key];
      const message = messages[key];
      if (typeof message !== 'string' || !message.trim()) {
        invalidMessages.push(`${locale}/${key} has no message text`);
      } else if (
        typeof source === 'string' &&
        interpolationNames(message).join() !== interpolationNames(source).join()
      ) {
        invalidMessages.push(`${locale}/${key} has different interpolation names`);
      }
    }
  }
  expect(invalidMessages).toEqual([]);
});
