import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './merge.ts';
import { stagePaths } from './merge-train.ts';
import { integrationHarness } from './test-support.ts';

function commitFixture(h: ReturnType<typeof integrationHarness>, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(h.root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  git(h.root, 'add', '.');
  git(h.root, 'commit', '-m', 'Add fixture generator');
}

test('integration admits a branch whose only out-of-scope changes are derived files', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const generated = 'packages/client/src/kernel/fixture.d.ts';
    const task = h.dispatch(generated);
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.brief.paths = ['owned.txt'];
    });
    mkdirSync(join(task.worktree, dirname(generated)), { recursive: true });
    await h.start(task);
    await h.train(undefined, false);

    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    expect(h.head()).toBe(h.head(task.branch));
    expect(git(h.root, 'show', `dev:${generated}`)).toBe(generated);
  } finally {
    h.dispose();
  }
});

test('staging derived files skips one whose deletion is already staged', () => {
  const h = integrationHarness();
  try {
    const orphan = 'packages/client/src/kernel/orphan.d.ts',
      kept = 'packages/client/src/kernel/kept.d.ts';
    commitFixture(h, { [orphan]: 'orphan\n', [kept]: 'kept\n' });
    git(h.root, 'rm', '-q', '--', orphan);
    writeFileSync(join(h.root, kept), 'regenerated\n');
    stagePaths(h.root, [orphan, kept]);

    expect(git(h.root, 'diff', '--cached', '--name-status')).toBe(`M\t${kept}\nD\t${orphan}`);
  } finally {
    h.dispose();
  }
});

test('a rebase conflict in a promotion derived file regenerates it on the dev side', async () => {
  const h = integrationHarness();
  try {
    const generated = 'contracts/openapi.json';
    commitFixture(h, { [generated]: 'base contract\n' });
    h.ensureDev();
    const regenerate = join(h.settings.stateDirectory, 'regenerate-openapi.mjs');
    writeFileSync(
      regenerate,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(generated)}, 'regenerated contract\\n');`,
    );
    h.settings.derivedFiles = [{ path: generated, stage: 'promotion', command: [process.execPath, regenerate] }];
    const task = h.dispatch(generated);
    await h.start(task);
    const dev = h.advanceDev(generated, 'dev contract\n');
    await h.train(undefined, false);

    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.head()).not.toBe(dev);
    expect(git(h.root, 'show', `dev:${generated}`)).toBe('regenerated contract');
  } finally {
    h.dispose();
  }
});

test('promotion regenerates derived files on the dev head and gates the regenerated head', async () => {
  const h = integrationHarness();
  try {
    const route = 'contracts/routes.json';
    const contract = 'contracts/openapi.json';
    const declaration = 'packages/client/src/kernel/fixture.d.ts';
    commitFixture(h, {
      [route]: 'initial route\n',
      [contract]: 'initial contract\n',
      [declaration]: 'initial declaration\n',
      'services/kernel/package.json': JSON.stringify({
        private: true,
        scripts: { derived: 'bun scripts/derived-fixture.ts' },
      }),
      'services/kernel/scripts/derived-fixture.ts': `import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../..');
const routes = readFileSync(resolve(root, 'contracts/routes.json'), 'utf8');
writeFileSync(resolve(root, 'contracts/openapi.json'), 'contract: ' + routes);
writeFileSync(resolve(root, 'packages/client/src/kernel/fixture.d.ts'), 'declare const route: ' + JSON.stringify(routes) + ';\\n');
`,
    });
    h.ensureDev();
    const task = h.dispatch(route);
    await h.start(task);
    await h.train(undefined, false);
    const integrated = h.head();
    const checkedHeads: string[] = [];

    await h.promote(async (_command, cwd) => {
      checkedHeads.push(git(cwd, 'rev-parse', 'HEAD'));
      const routes = readFileSync(join(cwd, route), 'utf8');
      const valid =
        readFileSync(join(cwd, contract), 'utf8') === `contract: ${routes}` &&
        readFileSync(join(cwd, declaration), 'utf8') === `declare const route: ${JSON.stringify(routes)};\n`;
      return { passed: valid, output: valid ? '' : 'AssertionError: derived output is stale', timedOut: false };
    });

    const regenerated = h.head();
    expect(regenerated).not.toBe(integrated);
    expect(git(h.root, 'show', '-s', '--format=%s', regenerated)).toBe('chore: regenerate derived files');
    expect(git(h.root, 'rev-parse', `${regenerated}^`)).toBe(integrated);
    expect(h.head('main')).toBe(regenerated);
    expect(checkedHeads.length).toBeGreaterThan(0);
    expect(new Set(checkedHeads)).toEqual(new Set([regenerated]));
    expect(h.store.task(task.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});

test('promotion installs dependencies in the derived worktree before running a generator that needs them', async () => {
  const h = integrationHarness();
  try {
    const route = 'contracts/routes.json';
    commitFixture(h, {
      [route]: 'initial route\n',
      'contracts/openapi.json': 'initial contract\n',
      '.gitignore': '.temp/\nnode_modules\ninstalled\n',
      'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { postinstall: 'touch installed' } }),
      'services/kernel/package.json': JSON.stringify({
        private: true,
        scripts: { derived: 'bun scripts/derived-fixture.ts' },
      }),
      'services/kernel/scripts/derived-fixture.ts': `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../..');
if (!existsSync(resolve(root, 'installed'))) throw new Error('dependencies are not installed');
writeFileSync(resolve(root, 'contracts/openapi.json'), 'contract: ' + readFileSync(resolve(root, 'contracts/routes.json'), 'utf8'));
`,
    });
    h.ensureDev();
    const task = h.dispatch(route);
    await h.start(task);
    await h.train(undefined, false);
    const integrated = h.head();

    await h.promote(async () => ({ passed: true, output: '', timedOut: false }));

    expect(h.head()).not.toBe(integrated);
    expect(git(h.root, 'show', '-s', '--format=%s', h.head())).toBe('chore: regenerate derived files');
    expect(h.head('main')).toBe(h.head());
    expect(h.store.task(task.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});
