import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';

const generated = 'services/kernel/db/content/schema.sql';

function regeneration(h: ReturnType<typeof integrationHarness>, output: string): string[] {
  const script = join(h.settings.stateDirectory, `regenerate-${crypto.randomUUID()}.mjs`);
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(generated)}, ${JSON.stringify(output)});`,
  );
  return [process.execPath, script];
}

function generatedSettings(h: ReturnType<typeof integrationHarness>, command: string[]) {
  h.settings.affectedTests = [];
  (
    h.settings as typeof h.settings & { integrationChecks: { paths: string[]; command: string[] }[] }
  ).integrationChecks = [{ paths: ['services/kernel/**'], command: ['true'] }];
  h.settings.derivedFiles = [
    { path: 'services/kernel/db/*/schema.sql', stage: 'integration', command },
    { path: 'contracts/openapi.json', stage: 'promotion', command },
    { path: 'packages/client/src/kernel/**', stage: 'promotion', command },
  ];
}

async function dispatch(h: ReturnType<typeof integrationHarness>, file: string, stabilize = false) {
  const briefFile = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
  const brief = markdown
    .replace('paths: [result.txt]', `paths: [${file}]`)
    .replace('command: [bun, test]', 'command: ["true"]')
    .replace('waiting: []', `waiting: []${stabilize ? '\ntarget: stabilize' : ''}`);
  writeFileSync(briefFile, brief);
  const task = h.tasks.dispatch(briefFile);
  mkdirSync(dirname(join(task.worktree, file)), { recursive: true });
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: `worker ${file}\n` }));
  await h.start(task);
  return task;
}

test('a generated-only rebase conflict keeps integration and commits regenerated outputs in the landing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head();
    const command = regeneration(h, 'regenerated from integration\n');
    generatedSettings(h, command);
    const task = await dispatch(h, generated);
    h.advanceDev(generated, 'new integration schema\n');

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(git(h.root, 'show', `dev:${generated}`)).toBe('regenerated from integration');
    const landing = h.outcomes[0]?.mergedCommit;
    expect(landing).toBeTruthy();
    expect(git(h.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', landing!)).toContain(generated);
    expect(git(h.root, 'merge-base', '--is-ancestor', base, 'dev')).toBe('');
  } finally {
    h.dispose();
  }
}, 30_000);

test('a generated conflict in the stabilize-to-dev merge regenerates and commits into dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', h.head());
    const command = regeneration(h, 'regenerated from dev\n');
    generatedSettings(h, command);
    const task = await dispatch(h, generated, true);
    const stabilizeHead = h.head('stabilize');
    h.advanceDev(generated, 'new dev schema\n');

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${generated}`)).toBe('regenerated from dev');
    expect(git(h.root, 'merge-base', '--is-ancestor', stabilizeHead, 'dev')).toBe('');
  } finally {
    h.dispose();
  }
}, 30_000);

test('a rebase with any non-generated conflict remains with the worker', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const ordinary = 'services/kernel/db/content/migration.txt';
    const command = regeneration(h, 'must not be regenerated\n');
    generatedSettings(h, command);
    const task = await dispatch(h, generated);
    // Add the ordinary path to the worker commit and the integration side, alongside the generated conflict.
    const workerTree = task.worktree;
    git(workerTree, 'reset', '--soft', 'HEAD^');
    mkdirSync(dirname(join(workerTree, ordinary)), { recursive: true });
    writeFileSync(join(workerTree, ordinary), 'worker migration\n');
    git(workerTree, 'add', '--', ordinary);
    git(workerTree, 'commit', '-m', 'Add worker migration');
    h.advanceDev(generated, 'integration schema\n');
    h.advanceDev(ordinary, 'integration migration\n');

    await h.train(undefined, false);

    expect(h.outcomes[0]?.stage).toBe('rebase');
    expect(h.outcomes[0]?.conflictedFiles).toEqual(expect.arrayContaining([generated, ordinary]));
    expect(git(h.root, 'show', `dev:${generated}`)).toBe('integration schema');
    expect(git(h.root, 'show', `dev:${ordinary}`)).toBe('integration migration');
    expect(git(h.root, 'show', `${task.branch}:${generated}`)).toBe(`worker ${generated}`);
  } finally {
    h.dispose();
  }
}, 30_000);
