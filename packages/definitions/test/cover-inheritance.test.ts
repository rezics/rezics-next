import { expect, test } from 'bun:test';
import { compileCatalogue } from '../src/compile.ts';

test('cover ratios follow structural ancestors without a distinct CURIE', async () => {
  const release = await compileCatalogue({
    root: 'covers.yaml',
    schemas: {
      'covers.yaml': `id: https://rezics.com/catalogue/covers
name: covers
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wd: http://www.wikidata.org/entity/
imports:
  - linkml:types
classes:
  Thing:
    abstract: true
    class_uri: schema:Thing
    annotations:
      cover_ratio: 1:1
  Portrait:
    abstract: true
    is_a: Thing
    annotations:
      cover_ratio: 3:4
  Person:
    is_a: Portrait
    class_uri: schema:Person
  GameBase:
    abstract: true
    is_a: Thing
    class_uri: schema:VideoGame
    annotations:
      cover_ratio: 3:4
  Game:
    is_a: GameBase
    class_uri: schema:VideoGame
  VisualNovel:
    is_a: GameBase
    class_uri: wd:Q689445
`,
    },
    presentation: {
      'covers/en': `types:
  schema:Person: person
  schema:VideoGame: game
  wd:Q689445: visual novel
`,
    },
  });
  for (const type of Object.values(release.types)) expect(type.coverRatio).toBe('3:4');
});
