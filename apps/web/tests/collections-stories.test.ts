import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const map = readFileSync(join(root, 'docs/development/page-stories.md'), 'utf8');
const collectionStories = [
  'apps/web/src/stories/collection.stories.tsx',
  'apps/web/src/stories/library-collection.stories.tsx',
  'apps/web/src/stories/library-collections.stories.tsx',
];

const stories = new Map(
  collectionStories.map((path) => [path, readFileSync(join(root, path), 'utf8')]),
);

test('every missing Collection page cell is replaced by an existing story export', () => {
  const collectionSections = [
    '## apps/web/src/routes/collections/$id.tsx',
    '## apps/web/src/routes/collections/new.tsx',
    '## apps/web/src/routes/library/collections.tsx',
  ];
  for (const section of collectionSections) {
    const start = map.indexOf(section);
    expect(start, `missing map section ${section}`).toBeGreaterThanOrEqual(0);
    const nextSection = map.indexOf('\n## ', start + section.length);
    const text = map.slice(start, nextSection < 0 ? map.length : nextSection);
    expect(text).not.toMatch(/\| missing \|/);
    for (const [, desktop, phone] of text.matchAll(/\|\s*(apps\/web\/src\/stories\/[^#]+\.stories\.tsx#[\w$]+)\s*\|\s*(apps\/web\/src\/stories\/[^#]+\.stories\.tsx#[\w$]+)\s*\|/g)) {
      for (const reference of [desktop, phone]) {
        const [file, name] = reference!.split('#');
        expect(stories.has(file!), `story file is outside the Collection catalogue: ${file}`).toBe(true);
        expect(stories.get(file!), `missing export ${reference}`).toMatch(new RegExp(`export\\s+const\\s+${name}\\b`));
      }
    }
  }
});

test('Collections page stories document all supported review cases and render via page fixtures', () => {
  const allStories = [...stories.values()].join('\n');
  for (const required of [
    'NoCollections', 'OneCollection', 'ManyCollections', 'CreateValid', 'CreateInvalid',
    'CreatePending', 'CreateFailed', 'PrivateCurator', 'UnlistedVisitor', 'PublicVisitor',
    'Empty', 'OnePage', 'ManyPages', 'NotesAndDuplicates', 'Editing', 'Reordering',
    'Following', 'DeepPage', 'FinalPage', 'Preparing', 'RestartAfterEpochChange',
  ]) expect(allStories, `missing story ${required}`).toMatch(new RegExp(`export\\s+const\\s+${required}\\b`));
  expect(allStories).toContain('PageStory');
  expect(allStories).toContain('play:');
  expect(allStories).toContain('within(');
  expect(allStories).toContain('expect(');
});

test('the Collections ledger marks unsupported outcomes planned instead of inventing responses', () => {
  const section = map.slice(map.indexOf('## apps/web/src/routes/collections/$id.tsx'), map.indexOf('## apps/web/src/routes/collections/new.tsx'));
  expect(section).toContain('planned:');
  for (const outcome of ['Everything', 'state', 'Liked', 'bulk', 'export', 'Zone mounts']) {
    expect(section.toLowerCase()).toContain(outcome.toLowerCase());
  }
});
