import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

/** Process startup and the integration stacks must build the same dependency object.
 * A dependency added only beside `createMainApp` in the process entry, or only in a
 * hand-built stack, is how an Access pool disappeared from publication tests. */
test('Main process and integration stacks compose dependencies once', () => {
  const index = source('services/main/src/index.ts');
  const composition = source('services/main/src/composition.ts');
  const media = source('tests/qa/integration/media-support.ts');
  const home = source('tests/qa/integration/feed-read-support.ts');
  expect(index).toContain('composeMain(');
  expect(index).not.toContain('createMainApp(');
  expect(index).not.toContain('eventTemporalAccess');
  expect(composition).toContain('export async function composeMain');
  expect(composition).toContain('eventTemporalAccess: pool');
  expect(composition).toContain('createMainApp(fuseki, dependencies)');
  expect(composition).not.toMatch(/\w\.start\(\)/);
  expect(media).toContain('composeMain(');
  expect(media).not.toContain('createMainApp(');
  expect(home).toContain('stack.composition.dependencies');
  expect(home).not.toMatch(/environment:\s*\{\s*fuseki/);
});
