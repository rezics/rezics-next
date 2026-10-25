import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const messagesDirectory = join(import.meta.dir, '..', 'messages');

test("every locale's messages have the same keys, sorted by key", () => {
  const files = readdirSync(messagesDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  expect(files).toHaveLength(8);

  const locales = files.map((file) => ({
    locale: file.slice(0, -5),
    messages: JSON.parse(readFileSync(join(messagesDirectory, file), 'utf8')) as Record<string, string>,
  }));
  const expectedKeys = Object.keys(locales[0]!.messages).sort();

  for (const { locale, messages } of locales) {
    const keys = Object.keys(messages);
    expect(keys, `${locale} keys are sorted`).toEqual([...keys].sort());
    expect(keys, `${locale} keys match every other locale`).toEqual(expectedKeys);
  }
});
