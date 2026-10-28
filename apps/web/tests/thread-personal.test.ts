import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const source = (path: string) => readFile(join(app, path), 'utf8');

test('board and thread routes render anonymously without session rereads', async () => {
  for (const route of ['routes/boards/$id.tsx', 'routes/threads/$id_.$slug.tsx', 'routes/threads/$id.tsx']) {
    const text = await source(`src/${route}`);
    expect(text).not.toContain('sessionReread');
  }
  const reads = await source('src/threads/reads.ts');
  expect(reads).toContain('personalRead');
  expect(reads).toContain('readThreadPersonal');
});

test('personal controls use browser queries and reserve their first-paint space', async () => {
  const queries = await source('src/threads/thread-queries.ts');
  expect(queries).toContain('personalRead');
  expect(queries).toContain('threadPersonalQuery');
  const route = await source('src/routes/threads/$id_.$slug.tsx');
  expect(route).toContain('useQuery');
  expect(route).toContain('personal');
  expect(route).toContain('min-h');
  expect(route).toContain('sign-in');
});

test('thread mutations update or invalidate cached thread and personal reads', async () => {
  const route = await source('src/routes/threads/$id_.$slug.tsx');
  const reactions = await source('src/threads/thread-reactions.tsx');
  expect(route).toContain('invalidateQueries');
  expect(route).toContain('setQueryData');
  expect(reactions).toContain('invalidateQueries');
  expect(route).not.toContain('location.reload');
});
