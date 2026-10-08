import { expect, test } from 'bun:test';
import { actingSubject, fakeMain, id, startRecipe, work } from './fixtures.ts';
import { initialDetails } from './initial-details.ts';
import { createDetailsSaver, entryOf } from './saves.ts';

const blank = { description: null, tagline: null, originalTitle: null, completionStatus: null, mainVersionLabel: null };

test('a new Work opens with its label as the title, so a description can be saved', async () => {
  const values = initialDetails({ localized: [], originalTitle: null, completionStatus: null }, 'en', {
    label: { value: 'Lemon muffins', language: 'en' }, ...blank,
  });
  expect(entryOf(values, 'en')).toEqual({ title: 'Lemon muffins', description: '' });
  const fake = fakeMain({ recipe: startRecipe, details: values, metadataHead: id(700) });
  const saver = createDetailsSaver({ main: fake.main, actingSubject, work, language: 'en', initial: { head: id(700), values } });
  // The title field already holds the label, so leaving the description writes both.
  expect(await saver.submit({ title: entryOf(values, 'en').title, description: 'Bright and tender.' })).toEqual({ kind: 'saved' });
  expect(fake.world().metadata.values.entries[0]).toMatchObject({ title: 'Lemon muffins', description: 'Bright and tender.' });
});

test('a Work that already has a description, tagline and original title opens with them', () => {
  const values = initialDetails(null, 'ja', {
    label: { value: 'レモンマフィン', language: 'ja' },
    description: { value: 'しっとり', language: 'ja' },
    tagline: { value: '朝のパン', language: 'ja' },
    originalTitle: { value: 'Lemon muffins', language: 'en' },
    completionStatus: 'completed',
    mainVersionLabel: { value: '初版', language: 'ja' },
  });
  expect(entryOf(values, 'ja')).toEqual({ title: 'レモンマフィン', description: 'しっとり' });
  expect(values.entries[0]).toMatchObject({ tagline: '朝のパン', label: '初版' });
  expect(values.originalTitle).toBe('Lemon muffins');
  expect(values.originalLanguage).toBe('en');
  expect(values.completion).toBe('completed');
});

test('an English display title does not replace the Japanese title the Work stored', () => {
  const values = initialDetails({
    localized: [
      { language: 'en', title: 'Lemon muffins', description: 'Bright', tagline: null, mainVersionLabel: null },
      { language: 'ja', title: 'レモンマフィン', description: null, tagline: null, mainVersionLabel: null },
    ],
    originalTitle: null, completionStatus: null,
  }, 'ja', {
    label: { value: '古い名前', language: 'ja' },
    description: { value: 'Bright', language: 'en' },
    tagline: { value: 'Morning', language: 'en' },
    originalTitle: null, completionStatus: null, mainVersionLabel: { value: 'First', language: 'en' },
  });
  expect(entryOf(values, 'ja')).toEqual({ title: 'レモンマフィン', description: '' });
  expect(values.entries.find(entry => entry.language === 'ja')).toMatchObject({ tagline: '', label: null });
  expect(entryOf(values, 'en').title).toBe('Lemon muffins');
});

test('upcoming and cancelled stay on the header when the cook saves a description', async () => {
  for (const completionStatus of ['upcoming', 'cancelled'] as const) {
    for (const source of ['metadata', 'work'] as const) {
      const values = initialDetails(
        { localized: [], originalTitle: null, completionStatus: source === 'metadata' ? completionStatus : null },
        'en',
        { label: { value: 'Lemon muffins', language: 'en' }, ...blank, completionStatus: source === 'work' ? completionStatus : null },
      );
      expect(values.completion).toBe(completionStatus);
      const fake = fakeMain({ recipe: startRecipe, details: values, metadataHead: id(700) });
      const saver = createDetailsSaver({ main: fake.main, actingSubject, work, language: 'en', initial: { head: id(700), values } });
      expect(await saver.submit({ title: 'Lemon muffins', description: 'Bright and tender.' })).toEqual({ kind: 'saved' });
      const saved = fake.calls.filter(call => call.name === 'details').at(-1)?.body as { state: { completionStatus: string | null } };
      expect(saved.state.completionStatus).toBe(completionStatus);
    }
  }
});
