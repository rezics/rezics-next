import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// Isolate the first import: an already initialized registry hides discovery
// deadlocks in profile modules that import their own read owners.
for (const first of ['recipe/structure-profile', 'section-list/structure-profile', 'structure/profiles']) {
  test(`Structure discovery completes when ${first} is imported first`, () => {
    const modules = new URL('../src/modules/', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--eval', `
      await import(${JSON.stringify(`${modules}${first}.ts`)});
      const { structureProfileFor } = await import(${JSON.stringify(`${modules}structure/profiles.ts`)});
      for (const id of ['recipe-composition', 'section-list-v1']) {
        const profile = structureProfileFor(id);
        if (!profile.workPublication || typeof profile.verifySourceCorrespondence !== 'function') {
          throw new Error('Missing source correspondence owner for ' + id);
        }
      }
    `], { encoding: 'utf8', timeout: 20_000 });
    expect({ status: result.status, signal: result.signal, error: result.error?.message,
      output: result.stdout + result.stderr }).toEqual({ status: 0, signal: null, error: undefined, output: '' });
  }, 25_000);
}
