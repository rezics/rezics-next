import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo } from './land.test.ts';
import { processIdentity } from '../qa/process/identity.ts';

const reviewCount = (log: string) => readFileSync(log, 'utf8').trim().split('\n').length;

test('an all-scope tooling review keeps its explicit effort when landing resumes', () => {
  const r = repo();
  try {
    const file = join(r.settingsDirectory, 'settings.user.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')),
      reviewScope: 'all', reviewEngine: 'sample-b', reviewEffort: 'xhigh', reviewFallbackEngines: [] }));
    writeFileSync(r.task.brief, readFileSync(r.task.brief, 'utf8').replace('kind: implementation', 'kind: tooling'));
    const stopped = r.run('land', { LANE_TIMEOUT: 'yes' });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(1);
    expect(reviewCount(r.log)).toBe(1);
    expect(JSON.parse(readFileSync(r.log, 'utf8').trim())).toContain('model_reasoning_effort=xhigh');
    const resumed = r.run();
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(reviewCount(r.log)).toBe(1);
    expect(r.ledger().tasks[r.task.id]!.state).toBe('verified');
  } finally { r.cleanup(); }
});

test('enabling all-scope review reviews a stopped tooling landing that previously skipped review', () => {
  const r = repo();
  try {
    writeFileSync(r.task.brief, readFileSync(r.task.brief, 'utf8').replace('kind: implementation', 'kind: tooling'));
    expect(r.run('land', { LANE_TIMEOUT: 'yes' }).status).toBe(1);
    expect(existsSync(r.log)).toBe(false);
    const file = join(r.settingsDirectory, 'settings.user.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), reviewScope: 'all' }));
    const resumed = r.run();
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
});

test('a lane wait that ran out is recorded and the same reviewed landing lands again', () => {
  const r = repo();
  try {
    const stopped = r.run('land', { LANE_TIMEOUT: 'yes' });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain('No gate lane became free');
    expect(r.ledger().tasks[r.task.id]!.mergeStop).toMatchObject({ kind: 'wait', landing: true });
    const landed = r.run('land', { REVIEW_EXIT: '1' });
    expect(landed.status).toBe(0);
    expect(r.ledger().tasks[r.task.id]!.state).toBe('verified');
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
});

test('a rebase stopped by an index lock lands with its accepted review after that lock clears', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'target-only.txt'), 'target bytes\n');
    r.git(r.dir, 'add', '.'); r.git(r.dir, 'commit', '-qm', 'Advance rebase target');
    const lock = join(r.git(r.worktree, 'rev-parse', '--absolute-git-dir'), 'index.lock');
    writeFileSync(lock, '');
    const stopped = r.run();
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain('index.lock');
    expect(r.ledger().tasks[r.task.id]!.mergeStop).toMatchObject({ kind: 'wait', landing: true });
    rmSync(lock);
    expect(r.run('land', { REVIEW_EXIT: '1' }).status).toBe(0);
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
});

test('main changing outside the train is recorded and land goes on next time', () => {
  const r = repo({ files: { 'value.test.ts': "import { test } from 'bun:test'; test('value', () => {});\n" } });
  try {
    const plan = join(r.dir, '.temp/plan.txt');
    writeFileSync(plan, '  unit: value.test.ts\n');
    const stopped = r.run('land', { GATE_MAIN_ADVANCE: 'yes', GOAL_TEST_PLAN: plan });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain('main changed outside the merge train');
    expect(r.ledger().tasks[r.task.id]!.mergeStop).toMatchObject({ kind: 'main-moved', landing: true });
    const landed = r.run('land', { REVIEW_EXIT: '1' });
    expect(landed.status).toBe(0);
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
}, 30_000);

test('an inconclusive unit gate is recorded and land uses its accepted review again', () => {
  const r = repo();
  try {
    writeFileSync(join(r.worktree, 'value.test.ts'), "import { test } from 'bun:test'; test('wait', async () => { if (process.env.GATE_HANG) await new Promise(() => {}); }, 100);\n");
    r.git(r.worktree, 'add', '.'); r.git(r.worktree, 'commit', '-qm', 'Add gate evidence');
    const stopped = r.run('land', { GATE_HANG: 'yes', GATE_FAILURE: 'yes', GOAL_UNIT_GATE_BUDGET_MS: '2000', GOAL_UNIT_GATE_CEILING_MS: '2000' });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain('unit gate remains inconclusive');
    expect(r.ledger().tasks[r.task.id]!.mergeStop).toMatchObject({ kind: 'inconclusive', landing: true });
    expect(r.run('land', { REVIEW_EXIT: '1' }).status).toBe(0);
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
}, 30_000);

test.each(['head', 'brief'])('a stopped landing reviews again when the accepted %s changed', change => {
  const r = repo();
  try {
    expect(r.run('land', { LANE_TIMEOUT: 'yes' }).status).toBe(1);
    if (change === 'head') {
      writeFileSync(join(r.worktree, 'services/account/src/value.ts'), 'export const value = 2;\n');
      r.git(r.worktree, 'commit', '-qam', 'Change value');
    } else writeFileSync(r.task.brief, readFileSync(r.task.brief, 'utf8') + '\nA changed outcome.\n');
    expect(r.run().status).toBe(0);
    expect(reviewCount(r.log)).toBe(2);
  } finally { r.cleanup(); }
});

test.each(['rebase', 'merge'])('a mechanism landing keeps its admitted scope after the manager resolves a %s conflict', operation => {
  const r = repo({ paths: [] });
  try {
    const brief = readFileSync(r.task.brief, 'utf8').replace('kind: implementation', 'kind: mechanism');
    writeFileSync(r.task.brief, brief);
    writeFileSync(join(r.dir, 'services/account/src/value.ts'), 'export const value = 9;\n');
    r.git(r.dir, 'commit', '-qam', 'Conflicting value');
    const submitted = r.ledger().tasks[r.task.id]!;
    const handoff = readFileSync(submitted.attempts[0]!.lastMessage!, 'utf8');
    const head = r.git(r.worktree, 'rev-parse', 'HEAD');
    const stopped = r.run();
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain('services/account/src/value.ts');
    expect(stopped.stderr).not.toContain('Correct the brief');
    expect(r.ledger().tasks[r.task.id]!.mergeStop).toMatchObject({ kind: 'rebase-conflict', landing: true });
    // An unresolved conflict can be tried again without replacing claims or the submission.
    expect(r.run('land', { REVIEW_EXIT: '1' }).status).toBe(1);
    expect(reviewCount(r.log)).toBe(1);
    expect(r.ledger().tasks[r.task.id]!.paths).toEqual([]);
    expect(r.ledger().tasks[r.task.id]!.attempts).toEqual(submitted.attempts);
    expect(readFileSync(r.task.brief, 'utf8')).toBe(brief);
    expect(readFileSync(submitted.attempts[0]!.lastMessage!, 'utf8')).toBe(handoff);
    expect(r.git(r.worktree, 'rev-parse', 'HEAD')).toBe(head);

    const resolution = spawnSync('git', [operation, ...(operation === 'merge' ? ['--no-edit'] : []), 'main'],
      { cwd: r.worktree, encoding: 'utf8' });
    expect(resolution.status).toBe(1);
    writeFileSync(join(r.worktree, 'services/account/src/value.ts'), 'export const value = 10;\n');
    r.git(r.worktree, 'add', 'services/account/src/value.ts');
    if (operation === 'rebase') r.git(r.worktree, '-c', 'core.editor=true', 'rebase', '--continue');
    else r.git(r.worktree, 'commit', '-qm', 'Resolve main conflict');
    const resolved = r.git(r.worktree, 'rev-parse', 'HEAD');
    expect(resolved).not.toBe(head);
    const landed = r.run();
    expect(landed.status, landed.stdout + landed.stderr).toBe(0);
    expect(r.ledger().tasks[r.task.id]!.state).toBe('verified');
    expect(r.ledger().tasks[r.task.id]!.paths).toEqual([]);
    expect(reviewCount(r.log)).toBe(2);
    expect(r.git(r.dir, 'show', 'main:services/account/src/value.ts')).toBe('export const value = 10;');
    expect(JSON.parse(readFileSync(join(r.runDir, 'landing.json'), 'utf8')).accepted.head).toBe(resolved);
  } finally { r.cleanup(); }
});

test.each(['failed', 'queued'])('a verified landing closes beside a %s manager snapshot and reports that snapshot separately', status => {
  const r = repo();
  try {
    const directory = join(r.dir, '.temp/goal-orchestration/manager-commits');
    mkdirSync(directory, { recursive: true });
    const id = 'manager-00000000-0000-0000-0000-000000000001';
    const record = { id, status, goal: 'alpha', base: r.base, source: status === 'failed' ? r.base : 'missing-source',
      paths: ['obsolete-brief.md'], message: 'Obsolete brief snapshot', queuedAt: new Date().toISOString(),
      cleared: true, ...status === 'failed' ? { error: 'Obsolete snapshot failure' } : {} };
    const file = join(directory, `${id}.json`);
    writeFileSync(file, JSON.stringify(record));
    const peer = { ...record, id: 'manager-00000000-0000-0000-0000-000000000002', status: 'failed', error: 'Another snapshot failure' };
    const foreign = { ...peer, id: 'manager-00000000-0000-0000-0000-000000000003', goal: 'another-goal' };
    for (const snapshot of [peer, foreign]) writeFileSync(join(directory, `${snapshot.id}.json`), JSON.stringify(snapshot));
    r.git(r.dir, 'update-ref', `refs/goal-manager/${id}`, r.base);
    const landed = r.run();
    expect(landed.status, landed.stdout + landed.stderr).toBe(0);
    expect(r.ledger().tasks[r.task.id]!.state).toBe('verified');
    expect(landed.stdout).toContain(`${r.task.id}: landed and verified`);
    expect(landed.stderr).toContain(`${id}: manager snapshot failed:`);
    expect(landed.stderr).toContain(`${peer.id}: manager snapshot failed: ${peer.error}`);
    expect(landed.stderr).not.toContain(foreign.id);
    expect(landed.stderr).not.toContain(`${r.task.id}: land stopped`);
    const retained = JSON.parse(readFileSync(file, 'utf8'));
    expect(retained.status).toBe('failed');
    expect(retained.error).toContain(status === 'failed' ? 'Obsolete snapshot failure' : 'missing-source');
    if (status === 'failed') expect(retained).toEqual(record);
    expect(r.git(r.dir, 'rev-parse', `refs/goal-manager/${id}`)).toBe(r.base);
  } finally { r.cleanup(); }
});

test('a real task gate failure remains refused and names its evidence', () => {
  const r = repo();
  try {
    writeFileSync(join(r.worktree, 'value.test.ts'), "import { test, expect } from 'bun:test'; test('value', () => expect(1).toBe(2));\n");
    r.git(r.worktree, 'add', '.'); r.git(r.worktree, 'commit', '-qm', 'Failing value proof');
    expect(r.run('land', { GATE_FAILURE: 'yes' }).status).toBe(1);
    expect(r.ledger().tasks[r.task.id]!.mergeStop?.kind).toBe('task');
    const refused = r.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('land requires an exited task (conflict)');
    expect(refused.stderr).toContain('value.test.ts');
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
});

function interrupt(r: ReturnType<typeof repo>) {
  writeFileSync(join(r.dir, 'target-only.txt'), 'target bytes\n');
  r.git(r.dir, 'add', '.'); r.git(r.dir, 'commit', '-qm', 'Advance rebase target');
  const stopped = r.run('land', { INTERRUPT_REBASE: 'yes' });
  expect(stopped.signal).toBe('SIGKILL');
  const gitDir = r.git(r.worktree, 'rev-parse', '--absolute-git-dir');
  expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(true);
  writeFileSync(join(gitDir, 'index.lock'), '');
  return gitDir;
}

test('land restores its killed rebase, preserves both commit histories and the worker files, and goes on', () => {
  const r = repo();
  try {
    const original = r.git(r.worktree, 'rev-parse', 'HEAD');
    mkdirSync(join(r.worktree, '.temp'), { recursive: true });
    writeFileSync(join(r.worktree, '.temp/worker-note'), 'worker bytes\n');
    const gitDir = interrupt(r);
    const interrupted = r.git(r.worktree, 'rev-parse', 'HEAD');
    const landed = r.run('land', { REVIEW_EXIT: '1' }, ['--step']);
    expect(landed.status).toBe(0);
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(false);
    expect(r.git(r.dir, 'rev-parse', `refs/goal-land/${r.task.id}/original`)).toBe(original);
    expect(r.git(r.dir, 'rev-parse', `refs/goal-land/${r.task.id}/interrupted`)).toBe(interrupted);
    expect(r.git(r.dir, 'rev-parse', `refs/goal-land/${r.task.id}/retained/${original}`)).toBe(original);
    expect(r.git(r.dir, 'rev-parse', `refs/goal-land/${r.task.id}/retained/${interrupted}`)).toBe(interrupted);
    expect(readFileSync(join(r.worktree, 'services/account/src/value.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect(readFileSync(join(r.worktree, '.temp/worker-note'), 'utf8')).toBe('worker bytes\n');
    expect(readFileSync(join(r.worktree, 'target-only.txt'), 'utf8')).toBe('target bytes\n');
    expect(reviewCount(r.log)).toBe(1);
  } finally { r.cleanup(); }
});

test.each(['owner', 'lock', 'branch'])('recovery refuses a live %s or a changed head and preserves the in-progress rebase', kind => {
  const r = repo();
  let descriptor: number | undefined;
  try {
    const gitDir = interrupt(r);
    if (kind === 'owner') {
      const file = join(r.runDir, 'landing.json');
      const state = JSON.parse(readFileSync(file, 'utf8'));
      state.rebase.owner = processIdentity(process.pid);
      writeFileSync(file, JSON.stringify(state));
    } else if (kind === 'lock') descriptor = openSync(join(gitDir, 'index.lock'), 'r');
    else r.git(r.worktree, 'update-ref', r.task.branch.startsWith('refs/') ? r.task.branch : `refs/heads/${r.task.branch}`, r.base);
    const refused = r.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(kind === 'owner' ? 'owner is still running' : kind === 'lock' ? 'index.lock is held by a live process' : 'recorded head is no longer the task head');
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(true);
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(true);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    r.cleanup();
  }
});

test('recovery refuses a target file with worker edits before deleting the lock or aborting', () => {
  const r = repo();
  try {
    const gitDir = interrupt(r);
    writeFileSync(join(r.worktree, 'target-only.txt'), 'worker changed target bytes\n');
    const refused = r.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('worker file target-only.txt');
    expect(readFileSync(join(r.worktree, 'target-only.txt'), 'utf8')).toBe('worker changed target bytes\n');
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(true);
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(true);
  } finally { r.cleanup(); }
});

test.each(['rebase', 'merge'])('a foreign %s is refused by name before checking cleanliness', operation => {
  const r = repo();
  try {
    const gitDir = r.git(r.worktree, 'rev-parse', '--absolute-git-dir');
    if (operation === 'rebase') mkdirSync(join(gitDir, 'rebase-merge'));
    else writeFileSync(join(gitDir, 'MERGE_HEAD'), r.base + '\n');
    const refused = r.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(operation === 'rebase' ? 'a rebase the landing did not start' : 'a merge in progress');
    expect(refused.stderr).not.toContain('clean worktree');
    expect(existsSync(r.log)).toBe(false);
  } finally { r.cleanup(); }
});
