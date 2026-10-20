import { expect, test } from 'bun:test';
import { seedServedTypes, servedTypes } from '../catalogue/type-fixtures.ts';
import { projectionFor } from './fixtures.ts';
import { showsBookControls, workExperience } from './experience.ts';

for (const presentation of ['book', 'recipe', 'prompt', 'skill', 'guide'] as const) {
  test(`a known ${presentation} retains its task when the projection or section is unavailable`, () => {
    seedServedTypes();
    const entry = servedTypes.types.find(entry => entry.presentation === presentation && !entry.default);
    if (!entry) throw new Error(`Missing served ${presentation} type`);
    const types = [entry.type];
    const projected = projectionFor({ base: 'work', types, name: 'Known native Work' });
    const noSection = { ...projected, sections: projected.sections.filter(section =>
      !['recipe', 'prompt', 'skill'].includes(section.id)) };
    for (const projection of [null, noSection]) {
      const experience = workExperience(projection, types);
      expect(experience.kind).toBe(presentation);
      expect(experience.primaryAction).toBe(entry.primaryAction);
      expect(experience.typeSection).toBeNull();
      expect(showsBookControls(experience)).toBe(presentation === 'book');
    }
    expect(workExperience(null, ['https://example.org/UnknownWork']).kind).toBe('plain');
  });
}
