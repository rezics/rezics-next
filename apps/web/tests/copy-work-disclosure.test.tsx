import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { copyWorkDisclosureControl, relationDefinitions } from '../src/subject/relations';

test('copy/work disclosure keeps complete-empty and withheld distinct without leaking members', () => {
  expect(copyWorkDisclosureControl({ items: [] })).toBe('empty');
  expect(copyWorkDisclosureControl({ items: [], count: { value: 0 } })).toBe('empty');
  expect(copyWorkDisclosureControl({ items: [], count: { value: 2 } })).toBe('withheld');
  expect(copyWorkDisclosureControl({ items: [{ id: 'visible' }], count: { value: 2 } })).toBe('available');
  const withheld = copyWorkDisclosureControl({ items: [], count: { value: 2 } });
  expect(JSON.stringify({ withheld, items: [] })).not.toContain('hidden-work');
  const definitions = relationDefinitions(bundledRelease, ['schema:exampleOfWork'], 'en');
  expect(definitions['schema:exampleOfWork']?.forwardReaderLabel).toBeTruthy();
  expect(definitions['schema:exampleOfWork']?.readerLabel).toBeTruthy();
});
