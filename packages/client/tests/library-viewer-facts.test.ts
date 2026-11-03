import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('generated Library and readable Collection declarations expose bounded current viewer facts', () => {
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const fixture = mkdtempSync(resolve(root, '.temp/library-viewer-facts-'));
  try {
    writeFileSync(
      resolve(fixture, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve(root, 'tsconfig.base.json'),
        compilerOptions: { types: ['bun'] },
        include: ['consumer.ts'],
      }),
    );
    writeFileSync(
      resolve(fixture, 'consumer.ts'),
      `
import { expectTypeOf } from 'bun:test';
import type { KernelClient } from ${JSON.stringify(resolve(root, 'packages/client/src/index.ts'))};
import type { ViewerFactsPage, MAX_VIEWER_FACTS_ROWS } from ${JSON.stringify(resolve(root, 'packages/client/src/kernel/library/viewer-facts.ts'))};
type LibraryPage = NonNullable<Awaited<ReturnType<KernelClient['libraryEntries']['get']>>['data']>;
type CollectionPage = Extract<NonNullable<Awaited<ReturnType<ReturnType<KernelClient['collections']>['members']['get']>>['data']>, { members: unknown[] }>;
type Facts = NonNullable<LibraryPage['viewerFacts']>;
expectTypeOf<CollectionPage['viewerFacts']>().toEqualTypeOf<Facts | undefined>();
expectTypeOf<Facts>().toMatchTypeOf<Extract<ViewerFactsPage, { state: 'current' }>>();
expectTypeOf<Facts['state']>().toEqualTypeOf<'current'>();
expectTypeOf<Facts['rows'][number]['entry']['state']>().toEqualTypeOf<'present' | 'absent' | 'unavailable'>();
expectTypeOf<Facts['rows'][number]['vote']['state']>().toEqualTypeOf<'present' | 'absent' | 'unavailable'>();
expectTypeOf<Extract<ViewerFactsPage, { state: 'unavailable' }>['reason']>().toEqualTypeOf<'identity' | 'currentness' | 'response_limit'>();
expectTypeOf<typeof MAX_VIEWER_FACTS_ROWS>().toEqualTypeOf<100>();
`,
    );
    const result = spawnSync(
      resolve(root, 'node_modules/.bin/bun'),
      ['check', '--no-script', '-p', resolve(fixture, 'tsconfig.json')],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 60_000);
