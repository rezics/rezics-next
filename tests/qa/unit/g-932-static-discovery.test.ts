import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  finishMergeTask,
  runMergeOwner,
} from '../../../services/main/src/modules/identity-merge/engine.ts';
import { fixture } from '../../../services/main/tests/g-836-fixture.ts';

const root = join(import.meta.dir, '../../..');

test('G933: discovered editorial owners and conformance fixtures remain Knip entry points', () => {
  const config = Bun.JSON5.parse(readFileSync(join(root, 'knip.jsonc'), 'utf8')) as {
    workspaces: Record<string, { entry: string[] }>;
  };
  const entries = config.workspaces['services/main']!.entry.map((pattern) => new Bun.Glob(pattern));
  const directory = join(root, 'services/main');
  for (const discovery of [
    'src/modules/editorial-review/*-adapter.ts',
    'src/modules/*/merge-handler.ts',
    'tests/g-865-*-fixture.ts',
  ]) {
    const files = [...new Bun.Glob(discovery).scanSync({ cwd: directory })];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(
        entries.some((entry) => entry.match(file)),
        file,
      ).toBe(true);
  }
});

test('G933: the production finalizer refuses incomplete stages and substituted final receipts', async () => {
  const f = fixture(65);
  expect(await runMergeOwner(f.wanted, f.handler.owner, f.journal, [f.handler], f.runtime)).toEqual(
    { complete: false, processed: 32 },
  );
  await expect(
    f.journal.locked(f.wanted.key, (scope) => finishMergeTask(scope, f.wanted, f.runtime)),
  ).rejects.toThrow('Owner stage is incomplete');
  expect(f.finalizations()).toBe(0);
  while (
    !(await runMergeOwner(f.wanted, f.handler.owner, f.journal, [f.handler], f.runtime)).complete
  ) {
    /* bounded resumption */
  }
  for (const bad of [
    { commandKey: 'substituted' },
    { receipt: '' },
    { receipt: 'x'.repeat(513) },
  ]) {
    await expect(
      f.journal.locked(f.wanted.key, (scope) =>
        finishMergeTask(scope, f.wanted, {
          ...f.runtime,
          finish: async (...args) => ({ ...(await f.runtime.finish(...args)), ...bad }),
        }),
      ),
    ).rejects.toThrow('exact owner receipt');
    expect(f.journal.tasks.get(f.wanted.key)!.completion).toBeNull();
  }
  const completion = await f.journal.locked(f.wanted.key, (scope) =>
    finishMergeTask(scope, f.wanted, f.runtime),
  );
  expect(
    await f.journal.locked(f.wanted.key, (scope) => finishMergeTask(scope, f.wanted, f.runtime)),
  ).toEqual(completion);
  expect(f.finalizations()).toBe(1);
});
