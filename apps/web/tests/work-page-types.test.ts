import { describe, expect, test } from 'bun:test';
import { workPageKind } from '../features/work-page/types/kind.ts';
import { guideSections } from '../features/work-page/types/guide.tsx';

describe('Work page rdf:type selection', () => {
  test('specific Hub types win over a generic document type in any order', () => {
    expect(workPageKind(['https://schema.org/DigitalDocument',
      'https://rezics.com/vocab/PromptTemplate'])).toBe('prompt');
    expect(workPageKind(['https://rezics.com/vocab/SkillPackage',
      'https://schema.org/DigitalDocument'])).toBe('skill');
  });

  test('recipes and guides receive their own pages; books and untyped Works keep the book page', () => {
    expect(workPageKind(['https://schema.org/Recipe'])).toBe('recipe');
    expect(workPageKind(['https://schema.org/DigitalDocument'])).toBe('guide');
    expect(workPageKind(['https://schema.org/Book'])).toBe('book');
    expect(workPageKind([])).toBe('book');
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
