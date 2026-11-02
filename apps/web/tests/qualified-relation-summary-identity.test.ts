import { expect, test } from 'bun:test';
import { qualifiedStatement } from '../src/kernel/fake/qualified-relations';
import { qualifiedNotes } from '../src/features/pages/qualified-relations';

test('qualified labels and unit labels require the supplied summary identity to match their target', () => {
  const role = 'role';
  const character = 'character';
  const unit = 'https://example.test/unit';
  const item = qualifiedStatement('statement', 'wdt:P725', 'person', [
    { property: { id: 'wdt:P3831', data_type: 'wikibase-item' }, value: { type: 'value', content: role } },
    { property: { id: 'wdt:P453', data_type: 'wikibase-item' }, value: { type: 'value', content: character } },
    {
      property: { id: 'schema:position', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+2', unit } },
    },
  ]);
  const notes = qualifiedNotes(
    item,
    {
      [role]: { id: 'foreign-role', label: { value: 'Foreign role', language: 'en' } },
      [character]: { id: character, label: 'Current character' },
      [unit]: { id: 'foreign-unit', label: { value: 'Foreign unit', language: 'en' } },
    },
    'en',
  );
  expect(notes.map((note) => note.text)).toEqual([
    'Role: Unlabelled subject',
    'Character: Current character',
    'Order:',
  ]);
  expect(notes[0]?.subject).toBeUndefined();
  expect(notes[1]?.subject).toEqual({ id: character, label: 'Current character' });
  expect(notes[2]?.quantity?.presentation.unitLabel).toBeNull();
});
