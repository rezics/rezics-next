import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const messagesDirectory = join(import.meta.dir, '..', 'messages');

// Code-point order, with `$schema` first when present.
function sortedKeys(keys: readonly string[]): string[] {
  const rest = keys.filter((key) => key !== '$schema').sort();
  return keys.includes('$schema') ? ['$schema', ...rest] : rest;
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

  for (const { locale, messages } of locales) {
    const keys = Object.keys(messages);
    expect(keys, `${locale} keys are sorted`).toEqual(sortedKeys(keys));
    expect(sortedKeys(keys), `${locale} keys match English`).toEqual(expectedKeys);
    expect(
      typeof messages.library_copy_more_actions === 'string' && Boolean(messages.library_copy_more_actions.trim()),
      `${locale} copy more-actions label`,
    ).toBe(true);
  }
});
