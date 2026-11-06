import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentAdapter, withAgentAdapter } from './agents.ts';
import { choosePoolWithFallback } from './allowance.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { identityLive, processIdentity, type ProcessIdentity } from './process.ts';
import type { RoutingTable } from './routing.ts';
import { integrationHarness } from './test-support.ts';
import { chooseResolverPool, resolverFallbacks, resolverProfile, TrainResolver } from './train-resolver.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

const HOUR = 3_600_000;
const file = 'packages/fixture/value.ts';
const base = 'export const value = "base";\n';
const worker = 'export const value = "worker";\n';
const dev = 'export const value = "dev";\n';
const resolved = 'export const value = "worker";\nexport const fromDev = true;\n';
/** A process that has exited: no leader or group member carries this incarnation. */
const exited: ProcessIdentity = { pid: 2_147_483_646, start: '1', boot: 'exited', group: 2_147_483_646 };

test('a resolver process that is gone releases its reservation, and a live one or this queue keeps it', async () => {
  const h = integrationHarness();
  h.ensureDev();
  const task = h.dispatch(file);
  await h.start(task);
  const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
  const entry = h.queue.entry(ref)!;
  const recordProcess = (process: ProcessIdentity) =>
    h.store.event(ref, 'train-resolver-process', { key: 'stopped', phase: 'resolve', process });
  h.queue.beginResolution(entry.id);
  recordProcess(processIdentity()!);
  // A restarted train has no reservations of its own.
  const restarted = new SqliteLandingQueue(h.store.db, h.store);
  expect(identityLive(processIdentity()!)).toBe(true);
  expect(restarted.releaseAbandonedResolutions()).toBe(0);
  recordProcess(exited);
  expect(h.queue.releaseAbandonedResolutions()).toBe(0);
  expect(restarted.releaseAbandonedResolutions()).toBe(1);
  expect(restarted.next()?.id).toBe(entry.id);
});

test('the next train releases a landing its earlier train left reserved, then integrates it', async () => {
  const h = integrationHarness();
  h.ensureDev();
  const task = h.dispatch(file);
  await h.start(task);
  const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
  h.queue.beginResolution(h.queue.entry(ref)!.id);
  h.store.event(ref, 'train-resolver-process', { key: 'stopped', phase: 'resolve', process: exited });
  const restarted = new SqliteLandingQueue(h.store.db, h.store);
  await new MergeTrain({
    ...h.settings,
    queue: restarted,
    fence: h.store,
    sink: { onGateOutcome() {}, onDevLandingTranspileHandoff() {} },
    runLaunchSmoke: async (_command, cwd) => ({
      passed: true,
      output: `release evidence: candidate=${git(cwd, 'rev-parse', 'HEAD')} dev-script-tree=${git(cwd, 'rev-parse', 'refs/heads/dev')} scenarios=test:passed lifecycle-regressions=test:passed\n`,
      timedOut: false,
    }),
  }).run();
  expect(restarted.entry(ref)?.delivered).toBe(1);
});

test('the resolver starts on codex above its burn ceiling, then falls back along the routed implementation profiles', () => {
  const now = Date.parse('2026-11-06T01:00:00.000Z');
  const policy = { weight: 1, reservePercent: 20, allowUnknown: true, maxAgeMs: HOUR };
  const pool = (name: string, cli: Pool['cli'], extra = {}) =>
    ({
      name,
      cli,
      classes: [cli],
      command: cli,
      configDirectory: `/${name}`,
      allowanceKey: name,
      policy: { ...policy, ...extra },
    }) as unknown as Pool;
  const codex = pool('codex', 'codex', { maxBurnPerHour: 5 });
  const cursorGrok = pool('cursor-grok', 'cursor');
  const claudeWorker = pool('claude-worker', 'claude');
  const pools = [codex, cursorGrok, claudeWorker];
  const reading = (name: string, usedPercent: number, observed = now, exhausted = false) =>
    ({
      pool: name,
      allowanceKey: name,
      exhausted,
      observedAt: new Date(observed).toISOString(),
      at: new Date(observed).toISOString(),
      windows: [{ usedPercent, minutes: 300, resetsAt: now + 4 * HOUR }],
    }) as unknown as PoolReading;
  const luna: Profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'max', poolClass: 'codex' };
  const grok: Profile = { cli: 'cursor', model: 'grok-4.7', effort: 'high', poolClass: 'cursor' };
  const haiku: Profile = { cli: 'claude', model: 'claude-haiku-5-5', effort: 'high', poolClass: 'claude' };
  const table = {
    version: 'test',
    experiments: [],
    consultation: resolverProfile,
    classes: { implementation: { first: luna, fallbacks: [luna, grok, haiku], maxSteps: 1, maxMs: 1 } },
  } as unknown as RoutingTable;
  expect(resolverFallbacks(table)).toEqual([grok, haiku]);
  const options = { now, spanMs: 2 * HOUR, history: [reading('codex', 10, now - HOUR)] };

  // Codex is 50 points an hour against a ceiling of 5: a routed worker is refused, the resolver is not.
  const overCeiling = [reading('codex', 60)];
  expect(() => choosePoolWithFallback(resolverProfile, [], [codex], overCeiling, options)).toThrow('no allowed pool');
  const onCodex = chooseResolverPool(table, pools, overCeiling, options);
  expect([onCodex.pool.name, onCodex.profile]).toEqual(['codex', resolverProfile]);

  // Exhausted codex falls back to cursor-grok, then to claude-worker Haiku, and waits for neither when all are spent.
  const codexSpent = reading('codex', 100, now, true);
  const grokSpent = reading('cursor-grok', 100, now, true);
  const onGrok = chooseResolverPool(
    table,
    pools,
    [codexSpent, reading('cursor-grok', 0), reading('claude-worker', 0)],
    options,
  );
  expect([onGrok.pool.name, onGrok.profile]).toEqual(['cursor-grok', grok]);
  const onHaiku = chooseResolverPool(table, pools, [codexSpent, grokSpent, reading('claude-worker', 0)], options);
  expect([onHaiku.pool.name, onHaiku.profile]).toEqual(['claude-worker', haiku]);
  expect(() =>
    chooseResolverPool(table, pools, [codexSpent, grokSpent, reading('claude-worker', 100, now, true)], options),
  ).toThrow('no allowed pool');
});

/** A dispatched worker whose landing conflicts with dev on the same file, and a detached worktree at dev to resolve in. */
async function conflictRequest(h: ReturnType<typeof integrationHarness>) {
  mkdirSync(dirname(join(h.root, file)), { recursive: true });
  writeFileSync(join(h.root, file), base);
  git(h.root, 'add', '--', file);
  git(h.root, 'commit', '-m', 'Seed resolver fixture');
  h.ensureDev();
  const task = h.dispatch(file);
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: worker }));
  await h.start(task);
  h.advanceDev(file, dev);
  const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
  const tree = join(h.settings.stateDirectory, 'resolver-tree');
  git(h.root, 'worktree', 'add', '--detach', tree, 'dev');
  return { ref, request: h.queue.entry(ref)!.request, tree, logPath: join(h.settings.stateDirectory, 'resolver.log') };
}

/** Compose the conflict; `frozen` names files the resolver may not touch, so an empty list starts a resolver pass. */
function compose(
  h: ReturnType<typeof integrationHarness>,
  fixture: Awaited<ReturnType<typeof conflictRequest>>,
  frozen: string[],
) {
  const target = git(h.root, 'rev-parse', 'dev');
  const source = git(h.root, 'rev-parse', `${fixture.request.branch}^{commit}`);
  return new TrainResolver(h.store, h.tasks).compose(
    fixture.request,
    fixture.tree,
    target,
    'refs/heads/dev',
    source,
    frozen,
    fixture.logPath,
  );
}

/** The conflict key the first compose recorded; a frozen file records it without starting a resolver. */
async function recordedConflict(
  h: ReturnType<typeof integrationHarness>,
  fixture: Awaited<ReturnType<typeof conflictRequest>>,
) {
  await compose(h, fixture, [file]);
  const key = JSON.parse(
    h.store.events(fixture.ref.taskId, fixture.ref.attempt).findLast((event) => event.kind === 'train-conflict')!.body,
  ).key as string;
  return { key, identityPath: join(h.settings.stateDirectory, 'train-resolver', key, 'resolve.process.json') };
}

/** A fake codex resolver: it reads its prompt from stdin and writes the resolved file in its worktree. */
function fakeResolver(starts: { count: number }) {
  const script = `const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(resolved)}));`;
  return {
    ...agentAdapter('codex'),
    start: () => {
      starts.count++;
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
  };
}

test('a resolver pass killed with its controller does not spend the bounded pass; the retry resolves the conflict', async () => {
  const h = integrationHarness();
  const fixture = await conflictRequest(h);
  const { key, identityPath } = await recordedConflict(h, fixture);
  h.store.event(fixture.ref, 'train-resolver-started', { key, phase: 'resolve', identityPath });
  h.store.event(fixture.ref, 'train-resolver-process', { key, phase: 'resolve', process: exited });
  const starts = { count: 0 };
  const conflict = await withAgentAdapter(fakeResolver(starts), () => compose(h, fixture, []));
  expect(starts.count).toBe(1);
  expect(conflict?.detail).toBeUndefined();
  expect(conflict?.resolvedCommit).toBeDefined();
});

test('a resolver pass that recorded its exit stays spent and is not retried', async () => {
  const h = integrationHarness();
  const fixture = await conflictRequest(h);
  const { key, identityPath } = await recordedConflict(h, fixture);
  h.store.event(fixture.ref, 'train-resolver-started', { key, phase: 'resolve', identityPath });
  h.store.event(fixture.ref, 'train-resolver-completed', { key, phase: 'resolve', ok: false, detail: 'exited with 1' });
  const starts = { count: 0 };
  const conflict = await withAgentAdapter(fakeResolver(starts), () => compose(h, fixture, []));
  expect(starts.count).toBe(0);
  expect(conflict?.detail).toMatch(/already spent/);
});
