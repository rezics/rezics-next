import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { validateRelease } from '../src/index.ts';
const hint = (type: string) => Reflect.get(bundledRelease.types[type]!, 'listPresentation');
test('actual released book film and recipe lists carry different inert frames and real property hints', () => {
  expect(hint('schema:Book')).toEqual({
    imageAspect: 'portrait',
    keyFacts: ['schema:author', 'schema:datePublished', 'schema:wordCount'],
  });
  expect(hint('schema:Movie')).toEqual({
    imageAspect: 'landscape',
    keyFacts: ['schema:director', 'schema:datePublished', 'schema:duration'],
  });
  expect(hint('schema:Recipe')).toEqual({
    imageAspect: 'landscape',
    keyFacts: ['schema:cookTime', 'schema:suitableForDiet'],
  });
  expect(hint('schema:MusicAlbum')).toEqual({
    imageAspect: 'square',
    keyFacts: ['schema:datePublished', 'schema:genre'],
  });
  expect(validateRelease(bundledRelease)).toEqual([]);
});
test('old releases omit hints and remain valid while list hints reject hostile or unrenderable references', () => {
  const old = structuredClone(bundledRelease);
  for (const value of Object.values(old.types)) Reflect.deleteProperty(value, 'listPresentation');
  expect(validateRelease(old)).toEqual([]);
  const bad = [
    { imageAspect: 'diagonal', keyFacts: [] },
    { imageAspect: 'portrait', keyFacts: ['schema:author', 'schema:author'] },
    { imageAspect: 'portrait', keyFacts: ['schema:doesNotExist'] },
    { imageAspect: 'portrait', keyFacts: ['schema:cookTime'] },
    { imageAspect: 'portrait', keyFacts: ['schema:abstract'] },
    { imageAspect: 'portrait', keyFacts: [], formatter: 'eval' },
    {
      imageAspect: 'portrait',
      keyFacts: ['schema:author', 'schema:datePublished', 'schema:genre', 'schema:inLanguage', 'schema:wordCount'],
    },
  ];
  for (const value of bad) {
    const release = structuredClone(old);
    Reflect.set(release.types['schema:Book']!, 'listPresentation', value);
    expect(validateRelease(release).length).toBeGreaterThan(0);
  }
});
async function compiled(n: number) {
  return compileCatalogue({
    root: 'lists.yaml',
    schemas: {
      'lists.yaml': `id: https://rezics.com/catalogue/lists
name: lists
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
imports:
  - linkml:types
classes:
  Base:
    abstract: true
    slots: [published]
    annotations:
      list_presentation:
        imageAspect: portrait
        keyFacts: [schema:datePublished]
  Movie:
    is_a: Base
    class_uri: schema:Movie
    annotations:
      list_presentation:
        imageAspect: landscape
        keyFacts: []
${Array.from({ length: n }, (_, i) => `  Item${i}:\n    is_a: Base\n    class_uri: schema:Item${i}`).join('\n')}
slots:
  published:
    slot_uri: schema:datePublished
    range: date
    annotations:
      datatype: time
`,
    },
    presentation: {
      'lists/en': `types:\n  schema:Movie: movie\n${Array.from({ length: n }, (_, i) => `  schema:Item${i}: item ${i}`).join('\n')}\n`,
    },
  });
}
test('nearest explicit whole-object replacement clears parent facts and new vertical counts stay data only', async () => {
  for (const n of [10, 100]) {
    const release = await compiled(n);
    expect(validateRelease(release)).toEqual([]);
    expect(Reflect.get(release.types['schema:Movie']!, 'listPresentation')).toEqual({
      imageAspect: 'landscape',
      keyFacts: [],
    });
    for (let i = 0; i < n; i++)
      expect(Reflect.get(release.types[`schema:Item${i}`]!, 'listPresentation')).toEqual({
        imageAspect: 'portrait',
        keyFacts: ['schema:datePublished'],
      });
  }
});
