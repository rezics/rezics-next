import { afterEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Ledger, type Task } from './types.ts';
import { landedTaskCommit } from './merge-normalise.ts';
import { fusekiImageTag, stampFusekiImage } from '../dev/fuseki-image.ts';

const fixtures: ReturnType<typeof createFixture>[] = [];
function createFixture(fuseki = false) {
  const scratch = join(import.meta.dir, '../../.temp/merge-landing');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  const state = join(directory, '.temp/goal-orchestration');
  const run = join(state, 'runs/G-001');
  mkdirSync(run, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Landing fixture');
  git('config', 'user.email', 'landing@example.invalid');
  mkdirSync(join(directory, 'scripts/goal'), { recursive: true });
  for (const file of ['dedupe-imports.ts', 'composition-roots.ts']) copyFileSync(join(import.meta.dir, file), join(directory, 'scripts/goal', file));
  writeFileSync(join(directory, '.gitignore'), '.temp/\nnode_modules/\n');
  if (fuseki) {
    const put = (path: string, text: string) => {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), text);
    };
    put('infra/jena/Dockerfile', 'ARG FUSEKI_VERSION=5.4.0\nCOPY infra/jena/command-module /build\n');
    put('infra/jena/command-module/pom.xml', '<artifactId>fuseki-command</artifactId><version>1.0.0</version>');
    put('infra/jena/command-module/one.txt', 'base one\n');
    put('infra/jena/command-module/two.txt', 'base two\n');
    put('infra/dev/compose.yaml', 'services:\n  fuseki:\n    image: rezics/fuseki:initial\n    restart: always\n');
    put('scripts/dev/release-manifest.ts', "export const pins = {\n    fuseki: 'rezics/fuseki:initial',\n  fusekiModule: '1.0.0',\n};\n");
    put('docs/development/toolchain.md', 'Authored toolchain guidance.\n\n| Source | Image and digest |\n| --- | --- |\n| Compose | `rezics/fuseki:initial` |\n');
    stampFusekiImage(directory, false);
    const image = fusekiImageTag(directory);
    writeFileSync(join(directory, 'docs/development/toolchain.md'), readFileSync(join(directory, 'docs/development/toolchain.md'), 'utf8').replace('rezics/fuseki:initial', image));
    put('scripts/generate.ts', `import { readFileSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { stampFusekiImage, fusekiImageTag } from ${JSON.stringify(join(import.meta.dir, '../dev/fuseki-image.ts'))};
      const root = process.cwd(), check = process.argv.includes('--check');
      stampFusekiImage(root, check);
      const path = 'docs/development/toolchain.md', text = readFileSync(path, 'utf8');
      const next = text.replace(/rezics\\/fuseki:[^\\x60\\s]+/g, fusekiImageTag(root));
      if (check && next !== text) throw new Error('stale toolchain pin');
      if (!check) {
        writeFileSync(path, next);
        if (spawnSync('task', ['jena:image'], { stdio: 'inherit' }).status !== 0) process.exit(1);
      }
    `);
  }
  git('add', '.'); git('commit', '-qm', 'Initial fixture');
  const base = git('rev-parse', 'HEAD');
  const worktree = join(directory, '.temp/tree');
  git('worktree', 'add', '-qb', 'goal/fixture', worktree);
  const file = 'scripts/delivered.ts';
  writeFileSync(join(worktree, file), 'export const delivered = "value with spaces";\n');
  git('-C', worktree, 'add', file); git('-C', worktree, 'commit', '-qm', 'Deliver file');
  const brief = join(directory, '.temp/brief.md');
  writeFileSync(brief, `---\nid: G-001\nkind: tooling\ntitle: Deliver a file\neffort: high\npaths: [${file}]\n---\n\n## Mechanisms\n\nnone\n`);
  mkdirSync(join(worktree, '.temp/goal'), { recursive: true });
  copyFileSync(brief, join(worktree, '.temp/goal/brief.md'));
  const output = join(run, 'attempt.json');
  writeFileSync(output, JSON.stringify({ result: 'RESULT: done', is_error: false }));
  const task: Task = { id: 'G-001', title: 'Deliver a file', kind: 'tooling', effort: 'high', cases: [], paths: [file],
    migrations: [], shared: [], depends: [], brief, worktree, branch: 'goal/fixture', base, state: 'exited', goal: 'program',
    attempts: [{ n: 1, engine: 'claude', effort: 'high', pid: 2147483647, session: 'fixture', output,
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }] };
  const ledgerPath = join(state, 'ledger.json');
  const save = (ledger: Ledger) => writeFileSync(ledgerPath, JSON.stringify(ledger));
  const ledger = () => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
  save({ tasks: { [task.id]: task }, goals: { program: { manager: 'fixture-manager', startedAt: new Date().toISOString() } } });
  writeFileSync(join(state, 'confirm-interval-minutes'), '0\n');
  mkdirSync(join(run, 'review-000'));
  writeFileSync(join(run, 'review-000/findings.json'), JSON.stringify({ findings: [] }));
  const bin = join(directory, '.temp/bin'); mkdirSync(bin);
  const ready = join(directory, '.temp/gate-ready');
  const release = join(directory, '.temp/gate-release');
  writeFileSync(join(bin, 'task'), `#!/usr/bin/env bun
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const imageFile = process.env.FIXTURE_IMAGE_FILE;
    if (imageFile) {
      const image = /image: (\\S+)/.exec(readFileSync('infra/dev/compose.yaml', 'utf8'))[1];
      if (args[0] === 'jena:image') { writeFileSync(imageFile, image); process.exit(0); }
      if (!existsSync(imageFile) || readFileSync(imageFile, 'utf8') !== image) throw new Error('gate reached before the image was built');
      writeFileSync(imageFile + '.gate', image);
    }
    const kind = process.env.FIXTURE_GATE;
    if ((kind === 'types' && args.some(arg => arg.endsWith(':typecheck')))
      || (kind === 'units' && !args.includes('--list'))) {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      if (process.env.FIXTURE_FAIL) { console.error('fixture runner did not produce diagnostics'); process.exit(1); }
    }
    if (args.includes('--list')) console.log('Affected since HEAD: fixture\\n  unit: scripts/fixture.test.ts');
  `);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bun
    import { existsSync, readFileSync } from 'node:fs';
    const file = process.env.FIXTURE_IMAGE_FILE;
    process.exit(!file || existsSync(file) && readFileSync(file, 'utf8') === process.argv.at(-1) ? 0 : 1);
  `);
  chmodSync(join(bin, 'task'), 0o755); chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(worktree, 'scripts/fixture.test.ts'), '');
  // The selector needs a present file in the clean task branch.
  git('-C', worktree, 'add', 'scripts/fixture.test.ts'); git('-C', worktree, 'commit', '-qm', 'Gate fixture');
  task.paths.push('scripts/fixture.test.ts');
  save({ ...ledger(), tasks: { [task.id]: task } });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOAL_ID: 'program', GOAL_MANAGER: 'fixture-manager',
    GOAL_MEMORY_FLOOR_GIB: '0', GOAL_GATE_LANES: '25', GOAL_UNIT_GATE_SHARDS: '1', GOAL_UNIT_GATE_SCOPE: 'affected' };
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (args: string[], overrides: NodeJS.ProcessEnv = {}, source = false) => {
    const child = Bun.spawn([process.execPath, ...source ? ['-e', args[0]!] : [join(import.meta.dir, 'goalctl.ts'), ...args]],
      { cwd: directory, env: { ...env, ...overrides }, stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
    return { child, result };
  };
  const current = { directory, state, run, git, task, ledger, save, ready, release, start, children };
  return current;
}

function fixture(fuseki = false) {
  const current = createFixture(fuseki);
  fixtures.push(current);
  return current;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Landing fixture timed out');
    await Bun.sleep(10);
  }
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    writeFileSync(f.release, 'release');
    for (const child of f.children) if (child.exitCode === null) child.kill();
    await Promise.all(f.children.map(child => child.exited));
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const wave of [false, true]) test(`landing resolves generated Fuseki pins and builds the combined image before gating (${wave ? 'merge' : 'rebase'})`, async () => {
  const f = fixture(true);
  const pin = (root: string) => {
    stampFusekiImage(root, false);
    const path = join(root, 'docs/development/toolchain.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/rezics\/fuseki:[^`\s]+/g, fusekiImageTag(root)));
  };
  writeFileSync(join(f.task.worktree, 'infra/jena/command-module/one.txt'), 'worker one\n');
  pin(f.task.worktree);
  f.git('-C', f.task.worktree, 'add', '.'); f.git('-C', f.task.worktree, 'commit', '-qm', 'Worker Fuseki input');
  writeFileSync(join(f.task.worktree, 'infra/jena/command-module/one.txt'), 'worker one revised\n');
  pin(f.task.worktree);
  f.git('-C', f.task.worktree, 'add', '.'); f.git('-C', f.task.worktree, 'commit', '-qm', 'Revise worker Fuseki input');
  const workerPin = fusekiImageTag(f.task.worktree);
  if (wave) {
    // A real merge in the submitted branch selects the merge path in the landing tool.
    f.git('checkout', '-qb', 'side');
    writeFileSync(join(f.directory, 'side.txt'), 'side\n');
    f.git('add', '.'); f.git('commit', '-qm', 'Side branch');
    f.git('checkout', '-q', 'main');
    f.git('-C', f.task.worktree, 'merge', '--no-ff', '-qm', 'Composed branch', 'side');
  }
  writeFileSync(join(f.directory, 'infra/jena/command-module/two.txt'), 'main two\n');
  pin(f.directory);
  f.git('add', '.'); f.git('commit', '-qm', 'Main Fuseki input');
  const mainPin = fusekiImageTag(f.directory);
  const imageFile = join(f.directory, '.temp/built-image');
  const result = await f.start(['merge', f.task.id, '--allow-scope'], { FIXTURE_IMAGE_FILE: imageFile }).result;
  expect(result.code, result.stderr).toBe(0);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('merged');
  const expected = fusekiImageTag(f.directory);
  expect(expected).not.toBe(workerPin);
  expect(expected).not.toBe(mainPin);
  for (const path of ['infra/dev/compose.yaml', 'scripts/dev/release-manifest.ts', 'docs/development/toolchain.md']) {
    expect(readFileSync(join(f.directory, path), 'utf8')).toContain(expected);
  }
  expect(readFileSync(imageFile, 'utf8')).toBe(expected);
  expect(readFileSync(imageFile + '.gate', 'utf8')).toBe(expected);
  expect(f.git('-C', f.task.worktree, 'status', '--porcelain')).toBe('');
}, 60_000);

test('a generated Fuseki pin conflict never resolves an authored Compose conflict', async () => {
  const f = fixture(true);
  for (const [root, input, restart] of [[f.task.worktree, 'one', 'on-failure'], [f.directory, 'two', 'unless-stopped']] as const) {
    writeFileSync(join(root, `infra/jena/command-module/${input}.txt`), `${input} changed\n`);
    const compose = join(root, 'infra/dev/compose.yaml');
    writeFileSync(compose, readFileSync(compose, 'utf8').replace('restart: always', `restart: ${restart}`));
    stampFusekiImage(root, false);
    f.git('-C', root, 'add', '.'); f.git('-C', root, 'commit', '-qm', 'Authored Compose change with generated pin');
  }
  const head = f.git('-C', f.task.worktree, 'rev-parse', 'HEAD');
  const result = await f.start(['merge', f.task.id, '--allow-scope']).result;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('infra/dev/compose.yaml');
  expect(f.git('-C', f.task.worktree, 'rev-parse', 'HEAD')).toBe(head);
  expect(f.git('-C', f.task.worktree, 'status', '--porcelain')).toBe('');
});

for (const kind of ['types', 'units']) {
  for (const recorded of [false, true]) test(`${kind} refusal cannot overwrite a landing ${recorded ? 'already recorded and cleaned' : 'not yet recorded'}`, async () => {
    const f = fixture();
    const merge = f.start(['merge', f.task.id], { FIXTURE_GATE: kind, FIXTURE_FAIL: '1' });
    await until(() => existsSync(f.ready));
    const commit = f.git('rev-parse', f.task.branch);
    f.git('merge', '--ff-only', f.task.branch);
    if (recorded) {
      const ledger = f.ledger();
      Object.assign(ledger.tasks[f.task.id]!, { state: 'merged', mergedCommit: commit });
      f.save(ledger);
      f.git('worktree', 'remove', f.task.worktree);
    }
    writeFileSync(f.release, 'release');
    const result = await merge.result;
    expect(result.code, result.stderr).toBe(0);
    expect(f.ledger().tasks[f.task.id]).toMatchObject({ state: 'merged', mergedCommit: commit });
    expect(f.ledger().tasks[f.task.id]!.refusal).toBeUndefined();
    expect(f.ledger().tasks[f.task.id]!.mergeStop).toBeUndefined();
  }, 60_000);
}

for (const cherryPick of [false, true]) test(`merge --landed recovers ${cherryPick ? 'patch-equivalent commits' : 'branch ancestry'} after worktree removal`, async () => {
  const f = fixture();
  if (cherryPick) {
    writeFileSync(join(f.directory, 'maintainer.txt'), 'before\n');
    f.git('add', '.'); f.git('commit', '-qm', 'Maintainer before');
    for (const commit of f.git('rev-list', '--reverse', `${f.task.base}..${f.task.branch}`).split('\n')) f.git('cherry-pick', commit);
  } else f.git('merge', '--ff-only', f.task.branch);
  const commit = f.git('rev-parse', 'main');
  writeFileSync(join(f.directory, 'maintainer.txt'), 'after\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Maintainer after');
  f.git('worktree', 'remove', f.task.worktree);
  const ledger = f.ledger();
  Object.assign(ledger.tasks[f.task.id]!, { state: 'conflict', refusal: 'stale failure' }); f.save(ledger);
  const result = await f.start(['merge', f.task.id, '--landed']).result;
  expect(result.code, result.stderr).toBe(0);
  expect(f.ledger().tasks[f.task.id]).toMatchObject({ state: 'merged', mergedCommit: commit });
  expect(f.ledger().tasks[f.task.id]!.refusal).toBeUndefined();
  const events = readFileSync(join(f.state, 'merges.jsonl'), 'utf8');
  expect((await f.start(['merge', f.task.id, '--landed']).result).code).toBe(0);
  expect(readFileSync(join(f.state, 'merges.jsonl'), 'utf8')).toBe(events);
});

test('merge repairs an unrecorded fast-forward without a worktree or mergedCommit', async () => {
  const f = fixture();
  f.git('merge', '--ff-only', f.task.branch);
  const commit = f.git('rev-parse', 'main');
  f.git('worktree', 'remove', f.task.worktree);
  const result = await f.start(['merge', f.task.id]).result;
  expect(result.code, result.stderr).toBe(0);
  expect(f.ledger().tasks[f.task.id]).toMatchObject({ state: 'merged', mergedCommit: commit });
});

test('merge --landed repairs a recorded landing after branch and worktree cleanup', async () => {
  const f = fixture();
  f.git('merge', '--ff-only', f.task.branch);
  const commit = f.git('rev-parse', 'main');
  f.git('worktree', 'remove', f.task.worktree);
  f.git('branch', '-d', f.task.branch);
  const ledger = f.ledger();
  Object.assign(ledger.tasks[f.task.id]!, { state: 'conflict', mergedCommit: commit }); f.save(ledger);
  const result = await f.start(['merge', f.task.id, '--landed']).result;
  expect(result.code, result.stderr).toBe(0);
  expect(f.ledger().tasks[f.task.id]).toMatchObject({ state: 'merged', mergedCommit: commit });
});

test('landing recovery preserves meaningful whitespace in patch equivalence', () => {
  const f = fixture();
  for (const commit of f.git('rev-list', '--reverse', `${f.task.base}..${f.task.branch}`).split('\n')) f.git('cherry-pick', commit);
  f.git('reset', '--soft', f.task.base);
  writeFileSync(join(f.directory, 'scripts/delivered.ts'), 'export const delivered = "valuewithspaces";\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Different string value');
  expect(landedTaskCommit(f.directory, f.task)).toBeUndefined();
});

test('a failed gate with only part of the branch landed remains a conflict', async () => {
  const f = fixture();
  const merge = f.start(['merge', f.task.id], { FIXTURE_GATE: 'types', FIXTURE_FAIL: '1' });
  await until(() => existsSync(f.ready));
  f.git('cherry-pick', f.git('rev-list', '--reverse', `${f.task.base}..${f.task.branch}`).split('\n')[0]!);
  writeFileSync(f.release, 'release');
  const result = await merge.result;
  expect(result.code).toBe(1);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('conflict');
  expect(existsSync(join(f.run, 'land.lock'))).toBe(false);
});

for (const first of ['settlement', 'merge']) test(`${first} holds the landing lock before the other starts`, async () => {
  const f = fixture();
  const settle = () => f.start([`import { settleTask } from ${JSON.stringify(join(import.meta.dir, 'settle.ts'))}; await settleTask('${f.task.id}');`], { FIXTURE_GATE: 'types' }, true);
  const merge = () => f.start(['merge', f.task.id], { FIXTURE_GATE: 'types' });
  const owner = first === 'settlement' ? settle() : merge();
  await until(() => existsSync(f.ready));
  const head = f.git('rev-parse', 'main');
  const other = first === 'settlement' ? await merge().result : await settle().result;
  expect(f.git('rev-parse', 'main')).toBe(head);
  if (first === 'settlement') {
    expect(other.code).toBe(1);
    expect(other.stderr).toContain('landing lock');
  } else {
    expect(other.code, other.stderr).toBe(0);
    expect(f.ledger().tasks[f.task.id]!.settlement!.reason).toContain('landing is already being watched');
  }
  writeFileSync(f.release, 'release');
  const result = await owner.result;
  expect(result.code, result.stderr).toBe(0);
  expect(f.ledger().tasks[f.task.id]!.state).toBe(first === 'settlement' ? 'verified' : 'merged');
  expect(existsSync(join(f.run, 'land.lock'))).toBe(false);
}, 60_000);

test('landing a lockfile installs main dependencies before reporting the merge', async () => {
  const f = fixture();
  writeFileSync(join(f.task.worktree, 'yarn.lock'), 'new lockfile');
  f.git('-C', f.task.worktree, 'add', 'yarn.lock');
  f.git('-C', f.task.worktree, 'commit', '-qm', 'Upgrade dependencies');
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.paths.push('yarn.lock'); f.save(ledger);
  const result = await f.start(['merge', f.task.id, '--skip-unit-gate', '--skip-type-gate']).result;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(existsSync(join(f.directory, 'node_modules/.rezics-dependencies'))).toBe(true);
  expect(result.stdout).toContain(`Dependencies changed in ${f.directory}; running task install`);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('merged');
});
