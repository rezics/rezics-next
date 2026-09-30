import { beforeEach, describe, expect, test } from 'bun:test';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { showsBookControls, workExperience } from '../features/entity-page/experience.ts';
import { projectionFor } from '../features/entity-page/fixtures.ts';
import { guideSections } from '../features/work-page/types/guide.tsx';

const experienceOf = (types: string[], listed = true) => workExperience(listed
  ? projectionFor({ base: 'work', types, name: 'A Work' }) : null, types);

describe('Work page selection from the served registry and the projection’s sections', () => {
  beforeEach(seedServedTypes);

  test('specific Hub types win over a generic document type in any order', () => {
    expect(experienceOf(['https://schema.org/DigitalDocument', 'https://rezics.com/vocab/PromptTemplate']).kind)
      .toBe('prompt');
    expect(experienceOf(['https://rezics.com/vocab/SkillPackage', 'https://schema.org/DigitalDocument']).kind)
      .toBe('skill');
  });

  test('a type section comes from the projection’s own link, and only when the projection lists one', () => {
    const recipe = experienceOf(['https://schema.org/Recipe']);
    expect(recipe.kind).toBe('recipe');
    expect(recipe.typeSection?.href).toMatch(/^\/v1\/recipes\/works\//);
    const prompt = experienceOf(['https://rezics.com/vocab/PromptTemplate']);
    expect(prompt.typeSection?.href).toMatch(/^\/v1\/hub\/works\//);
    // Without the projection the page shows less: no recipe section is guessed from the type.
    expect(experienceOf(['https://schema.org/Recipe'], false).typeSection).toBeNull();
    expect(experienceOf(['https://schema.org/Recipe'], false).kind).toBe('plain');
  });

  test('guides read from their registry presentation; only books get book controls', () => {
    expect(experienceOf(['https://schema.org/DigitalDocument']).kind).toBe('guide');
    expect(showsBookControls(experienceOf(['https://schema.org/Book']))).toBe(true);
    expect(showsBookControls(experienceOf(['https://schema.org/BookSeries']))).toBe(true);
  });

  test('an unknown type, an untyped Work and every non-book presentation are not books', () => {
    for (const types of [[], ['https://example.com/Hologram'], ['https://schema.org/VideoGame'],
      ['https://schema.org/Movie'], ['https://schema.org/SoftwareApplication'], ['https://rezics.com/vocab/ModPackage'],
      ['https://schema.org/CreativeWork']]) {
      expect(showsBookControls(experienceOf(types, false)), types.join()).toBe(false);
    }
  });
});

test('guide heading links preserve section order and the published paragraphs', () => {
  expect(guideSections('# Start\nInstall Bun.\n## Run\nRun the script.', 'Bun guide'))
    .toEqual([
      { id: 'guide-section-1', heading: 'Start', paragraphs: ['Install Bun.'] },
      { id: 'guide-section-2', heading: 'Run', paragraphs: ['Run the script.'] },
    ]);
  expect(guideSections('Bun guide\nA single introductory paragraph.', 'Bun guide'))
    .toEqual([{ id: 'guide-section-1', heading: 'Bun guide',
      paragraphs: ['A single introductory paragraph.'] }]);
});
