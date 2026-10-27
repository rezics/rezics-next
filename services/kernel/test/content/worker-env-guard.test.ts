import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const testRoot = resolve(import.meta.dir, '..');
const guardPath = resolve(import.meta.dir, 'worker-env-guard.test.ts');
function spawnsKernelWorker(source: string): boolean {
  const directWorkerSpawn = /\bBun\.spawn\s*\(\s*\[[^\]]*['"]src\/worker\.ts['"]/s.test(source);
  const workerEntrypointProcess =
    /process\.argv\.includes\([\s\S]*?\)[\s\S]*?startWorker\s*\(\s*readWorkerConfig\s*\(\s*process\.env\s*\)\s*\)/.test(
      source,
    );
  return directWorkerSpawn || workerEntrypointProcess;
}

const workerSpawners = ['content', 'community'].flatMap((area) => {
  const directory = resolve(testRoot, area);
  return Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: directory }), (file) => resolve(directory, file))
    .filter((file) => file !== guardPath)
    .filter((file) => spawnsKernelWorker(readFileSync(file, 'utf8')));
});

test('content and community child workers use the shared worker environment', () => {
  const missing = workerSpawners
    .filter((file) => !readFileSync(file, 'utf8').includes('workerTestEnv('))
    .map((file) => relative(testRoot, file).split('\\').join('/'))
    .sort();

  expect(missing).toEqual([]);
});
