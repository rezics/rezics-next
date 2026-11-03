import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';

const root = resolve(import.meta.dir, '../../..');
const manifest = readFileSync(resolve(root, 'docs/goals/library.capabilities.md'), 'utf8');
const pageStories = readFileSync(resolve(root, 'docs/development/page-stories.md'), 'utf8');

test('Library manifest story references resolve to exact source exports', () => {
  const references = new Set(
    [...manifest.matchAll(/([\w-]+\.stories\.tsx)([\s\S]*?)(?=[\w-]+\.stories\.tsx|$)/g)].flatMap(([, file, text]) =>
      [...text.matchAll(/#([A-Z][A-Za-z0-9_]*)/g)].map(([, name]) => `${file}#${name}`),
    ),
  );
  const missing = [...references].filter((reference) => {
    const [file, name] = reference.split('#');
    const source = resolve(root, 'apps/web/src/stories', file);
    return !readFileSync(source, 'utf8').match(new RegExp(`\\bexport\\s+const\\s+${name}\\b`));
  });

  expect(missing).toEqual([]);
});

test('Library page ledger keeps missing families explicit and log viewers correctly mapped', () => {
  expect(pageStories).not.toMatch(/\|\s*planned:/);
  expect(pageStories).toContain(
    'apps/web/src/routes/library/operations/$id.tsx         | bulk operation status     | owner or curator | missing | missing',
  );
  expect(pageStories).toContain(
    'apps/web/src/routes/library/operations/$id_.undo.tsx   | bulk operation Undo | owner or curator | missing | missing',
  );
  expect(pageStories).toContain(
    'apps/web/src/routes/logs/$id.tsx | populated               | anonymous | apps/web/src/stories/library-log.stories.tsx#SignedOut | apps/web/src/stories/library-log.stories.tsx#SignedOut',
  );
  expect(pageStories).toContain(
    'apps/web/src/routes/logs/$id.tsx | populated               | member    | apps/web/src/stories/library-log.stories.tsx#SignedIn  | apps/web/src/stories/library-log.stories.tsx#SignedIn',
  );
  expect(pageStories).not.toContain('## apps/web/src/routes/library/history');
});
