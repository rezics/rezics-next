import { afterEach, describe, expect, test } from 'bun:test';
import { clearTypes } from '../catalogue/types.ts';
import { seedServedTypes, servedTypes } from '../catalogue/type-fixtures.ts';
import { shelfVerb } from '../work-page/shelf-words.ts';
import { showsBookControls, workExperience } from './experience.ts';

afterEach(seedServedTypes);

describe('known Work experience during a failed projection read', () => {
  test('keeps each served domain without inventing a projection link', () => {
    seedServedTypes();
    for (const presentation of ['book', 'recipe', 'prompt', 'skill', 'guide'] as const) {
      const entry = servedTypes.types.find(type => type.presentation === presentation);
      if (!entry) throw new Error(`Missing served ${presentation} fixture`);
      const experience = workExperience(null, [entry.type]);
      expect(experience.kind).toBe(presentation);
      expect(experience.presentation).toBe(presentation);
      expect(experience.primaryAction).toBe(entry.primaryAction);
      expect(experience.typeSection).toBeNull();
      expect(showsBookControls(experience)).toBe(presentation === 'book');
      if (presentation === 'recipe') expect(shelfVerb(experience)).toBe('cook');
    }
  });

  test('an unknown type never claims a known specialist experience', () => {
    seedServedTypes();
    expect(workExperience(null, ['https://example.test/Unknown']).kind).toBe('plain');
    clearTypes();
    expect(workExperience(null, []).kind).toBe('plain');
  });
});
