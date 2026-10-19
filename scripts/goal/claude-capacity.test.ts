import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertPreviousClaudeExited, briefDigest, capacityDecision, capacityFingerprint, coordinateClaudeCapacity, fetchClaudeCapacity,
  normalizeClaudeUsage, ownsClaudeProcess, pauseCanResume, providerReset, readCapacityCache, recordClaudeLaunch,
  refreshClaudeCapacity, type CapacityCache, type CapacityPolicy, type CapacityTask } from './claude-capacity.ts';
import type { Ledger, Task } from './types.ts';
import { jobDirectory, JOB_WAIT_MS, JobStore, wakeJobs } from './job.ts';
import { processIdentity } from '../qa/process/identity.ts';

const NOW = Date.parse('2026-10-19T00:00:00Z');
const directories: string[] = [];
function temporary() {
  const parent = join(import.meta.dir, '../../.temp/claude-capacity-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-')); directories.push(directory); return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
// Provider-shaped, sanitized usage captures. No fixture contains a real credential or account identity.
function provider(five = 20, seven = 70, fiveReset = NOW + 3600_000, weekReset = NOW + 86400_000) {
  return { five_hour: { utilization: five, resets_at: new Date(fiveReset).toISOString() },
    seven_day: { utilization: seven, resets_at: new Date(weekReset).toISOString() }, extra_usage: { is_enabled: false } };
}
function cache(five = 20, seven = 70, at = NOW, fiveReset = NOW + 3600_000, weekReset = NOW + 86400_000): CapacityCache {
  return { current: normalizeClaudeUsage(provider(five, seven, fiveReset, weekReset), at) };
}
function credentials(directory: string, expiresAt = NOW + 3600_000) {
  const file = join(directory, 'credentials.json');
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt } }));
  return file;
}

test('native OAuth usage normalization retains only the two windows, observation time and safe errors', () => {
  const normalized = normalizeClaudeUsage({ ...provider(), email: 'fixture-address', organization: 'fixture-org',
    accessToken: 'fixture-access', headers: { Authorization: 'fixture-access' }, seven_day_sonnet: { utilization: 99 } }, NOW);
  expect(normalized).toEqual({ observedAt: NOW, five_hour: { used: 20, resetsAt: NOW + 3600_000 },
    seven_day: { used: 70, resetsAt: NOW + 86400_000 } });
  expect(JSON.stringify(normalized)).not.toMatch(/fixture|Authorization|sonnet/);
});

test('an exhausted session remains closed after its clock reset until the provider reports a new window', () => {
  const exhausted = cache(100);
  expect(capacityDecision(exhausted, false, NOW)).toMatchObject({ admit: false, stop: true, reason: 'allowance-exhausted' });
  expect(capacityDecision(exhausted, false, NOW + 3600_001).admit).toBe(false);
  const refreshed = cache(0, 72, NOW + 3600_001, NOW + 5 * 3600_000);
  expect(providerReset(exhausted.current.five_hour, refreshed.current.five_hour, refreshed.current.observedAt)).toBe(true);
  expect(capacityDecision(refreshed, false, refreshed.current.observedAt).admit).toBe(true);
  expect(providerReset(exhausted.current.five_hour, refreshed.current.five_hour, NOW + 1000)).toBe(false);
  expect(providerReset(exhausted.current.five_hour, exhausted.current.five_hour, NOW + 3600_001)).toBe(false);
});

test('an advanced provider window confirms a reset even when a frozen zero baseline has since been used by about', () => {
  const previous = cache(0).current.five_hour;
  const at = NOW + 3600_001;
  const current = cache(12, 72, at, NOW + 5 * 3600_000).current.five_hour;
  expect(providerReset(previous, current, at)).toBe(true);
  expect(providerReset(previous, current, NOW + 1000)).toBe(false);
  expect(providerReset(previous, previous, at)).toBe(false);
  expect(providerReset(previous, { used: 12, resetsAt: at - 1 }, at)).toBe(false);
  expect(providerReset(undefined, current, at)).toBe(false);
});

test('stale, future, missing or invalid session/weekly evidence fails closed, including a seven-day-only cache', () => {
  for (const value of [undefined, { current: { observedAt: NOW, seven_day: cache().current.seven_day } },
    cache(0, 0, NOW - 45_001), cache(0, 0, NOW + 1), cache(0, 0, NOW, NOW - 1),
    cache(0, 0, NOW, NOW + 3600_000, NOW - 1),
    { current: normalizeClaudeUsage({ ...provider(), five_hour: { utilization: -1, resets_at: 'invalid' } }, NOW) },
    { current: normalizeClaudeUsage({ ...provider(), seven_day: { utilization: 101 } }, NOW) }]) {
    expect(capacityDecision(value, false, NOW)).toMatchObject({ admit: false, stop: true });
  }
});

test('unfinished, absent and idle about state all keep the reserve; only explicit verified release removes it', () => {
  expect(capacityDecision(cache(51), false, NOW).admit).toBe(true);
  expect(capacityDecision(cache(52), false, NOW)).toMatchObject({ admit: false, stop: false });
  expect(capacityDecision(cache(57), false, NOW)).toMatchObject({ admit: false, stop: true, reason: 'about-reserve' });
  expect(capacityDecision(cache(99, 99), true, NOW)).toMatchObject({ admit: true, stop: false });
  expect(capacityDecision(cache(100), true, NOW).admit).toBe(false);
  expect(capacityDecision(cache(5, 100), true, NOW)).toMatchObject({ admit: false, stop: true });
  expect(capacityDecision(cache(5, 99), false, NOW).admit).toBe(true);
});

test('measured shared-account rise increases the interruption margin instead of pacing away weekly allowance', () => {
  const value = cache(40);
  value.previous = cache(35, 70, NOW - 30_000).current;
  expect(capacityDecision(value, false, NOW)).toMatchObject({ margin: 20, stopAt: 200 / 3 - 20, admit: true });
  value.current.five_hour!.used = 50;
  expect(capacityDecision(value, false, NOW)).toMatchObject({ margin: 60, stop: true });
  value.previous!.five_hour!.resetsAt -= 5 * 3600_000;
  expect(capacityDecision(value, false, NOW).margin).toBe(10);
});

test('usage GET uses native OAuth headers, rejects paid fallback, and never returns credential/provider errors', async () => {
  const credentialFile = credentials(temporary());
  const value = await fetchClaudeCapacity({ credentialFile, now: () => NOW, fetcher: async (url, init) => {
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage'); expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error'); expect(init.headers).toEqual({ Authorization: 'Bearer fixture-access', 'anthropic-beta': 'oauth-2025-04-20' });
    return Response.json(provider());
  } });
  expect(value).toEqual(cache().current);
  for (const [body, error] of [
    [{ ...provider(), extra_usage: { is_enabled: true, balance: 999 } }, 'paid-usage-enabled'],
    [{ five_hour: provider().five_hour, seven_day: provider().seven_day }, 'paid-usage-unknown'],
  ] as const) {
    const response = await fetchClaudeCapacity({ credentialFile, now: () => NOW, fetcher: async () => Response.json(body) });
    expect(response.error).toBe(error); expect(JSON.stringify(response)).not.toMatch(/balance|999|fixture/);
  }
  for (const [status, error] of [[401, 'unauthorized'], [429, 'rate-limited'], [503, 'request-failed']] as const) {
    const response = await fetchClaudeCapacity({ credentialFile, now: () => NOW,
      fetcher: async () => new Response('fixture-access fixture-address', { status }) });
    expect(response).toEqual({ observedAt: NOW, error });
  }
  expect(await fetchClaudeCapacity({ credentialFile, now: () => NOW,
    fetcher: async () => { throw new Error('fixture-access fixture-refresh'); } })).toEqual({ observedAt: NOW, error: 'request-failed' });
});

test('missing/expired credentials and request/body hangs are bounded without refresh or model calls', async () => {
  const directory = temporary();
  let called = 0;
  const never = async () => { called++; return await new Promise<Response>(() => {}); };
  expect((await fetchClaudeCapacity({ credentialFile: join(directory, 'absent'), now: () => NOW, fetcher: never })).error).toBe('credentials-missing');
  expect((await fetchClaudeCapacity({ credentialFile: credentials(directory, NOW + 60_000), now: () => NOW, fetcher: never })).error).toBe('credentials-expired');
  expect(called).toBe(0);
  const credentialFile = credentials(directory);
  const started = Date.now();
  expect((await fetchClaudeCapacity({ credentialFile, now: () => NOW, timeoutMs: 15, fetcher: never })).error).toBe('timeout');
  expect((await fetchClaudeCapacity({ credentialFile, now: () => NOW, timeoutMs: 15,
    fetcher: async () => new Response(new ReadableStream({ start() {} })) })).error).toBe('timeout');
  expect(Date.now() - started).toBeLessThan(1000);
  for (const body of ['not-json', JSON.stringify({ ...provider(), raw: 'x'.repeat(64 * 1024) })]) {
    expect((await fetchClaudeCapacity({ credentialFile, now: () => NOW,
      fetcher: async () => new Response(body) })).error).toBe('invalid-response');
  }
});

test('failed refresh invalidates fresh admission and retains only the last normalized successful baseline', async () => {
  const directory = temporary(), file = join(directory, 'observation.json'), credentialFile = credentials(directory);
  const successful = await refreshClaudeCapacity({ file, credentialFile, now: () => NOW, fetcher: async () => Response.json(provider(30)) });
  const failed = await refreshClaudeCapacity({ file, credentialFile, now: () => NOW + 1000,
    fetcher: async () => new Response('fixture-access', { status: 429 }) });
  expect(failed.previous).toEqual(successful.current);
  expect(capacityDecision(failed, false, NOW + 1000).admit).toBe(false);
  await refreshClaudeCapacity({ file, credentialFile, now: () => NOW + 2000, fetcher: async () => { throw new Error('fixture-refresh'); } });
  expect(readCapacityCache(file)?.previous).toEqual(successful.current);
  expect(readFileSync(file, 'utf8')).not.toMatch(/fixture|Bearer|email|org/);
});

test('malformed caches fail closed and refresh/status never retain unexpected provider or credential fields', async () => {
  const directory = temporary(), file = join(directory, 'observation.json');
  for (const malformed of ['null', '{}', '{"current":null}', '{"current":{"observedAt":"yesterday"}}', '{']) {
    writeFileSync(file, malformed);
    expect(readCapacityCache(file)).toBeUndefined();
    expect(capacityDecision(readCapacityCache(file), false, NOW).admit).toBe(false);
    const failed = await refreshClaudeCapacity({ file, credentialFile: join(directory, 'missing'), now: () => NOW });
    expect(failed.current.error).toBe('credentials-missing');
  }
  writeFileSync(file, JSON.stringify({ current: { ...cache().current, accessToken: 'fixture-access',
    five_hour: { ...cache().current.five_hour, headers: { Authorization: 'fixture-access' } } }, raw: 'fixture-raw' }));
  expect(JSON.stringify(readCapacityCache(file))).not.toMatch(/fixture|headers|Authorization/);
  await refreshClaudeCapacity({ file, credentialFile: join(directory, 'missing'), now: () => NOW });
  expect(readFileSync(file, 'utf8')).not.toMatch(/fixture|headers|Authorization/);
});

test('overlapping refreshes make only one provider request and cannot overwrite its reset evidence', async () => {
  const directory = temporary(), file = join(directory, 'observation.json'), credentialFile = credentials(directory);
  let finish!: (value: Response) => void;
  const first = refreshClaudeCapacity({ file, credentialFile, now: () => NOW,
    fetcher: () => new Promise<Response>(resolveResponse => { finish = resolveResponse; }) });
  const overlap = await refreshClaudeCapacity({ file, credentialFile, now: () => NOW + 1000,
    fetcher: async () => { throw new Error('second request must not start'); } });
  expect(overlap.current.error).toBe('refresh-in-progress');
  expect(capacityDecision(overlap, false, NOW + 1000).admit).toBe(false);
  finish(Response.json(provider(0)));
  await first;
  expect(readCapacityCache(file)?.current).toEqual(cache(0).current);
});

function managedFixture() {
  const directory = temporary(), brief = join(directory, 'brief.md'); writeFileSync(brief, 'reviewed frontend brief');
  const task = { id: 'G-900', brief, worktree: directory, branch: 'goal/frontend', base: 'base', title: 'Frontend',
    paths: ['apps/web/'], cases: [], migrations: [], shared: [], depends: [], engine: 'claude', effort: 'high', state: 'running',
    attempts: [{ n: 1, engine: 'claude', effort: 'high', pid: 1234, session: 'retained-native-session', output: join(directory, 'output'), startedAt: new Date(NOW).toISOString() }],
    claudeCapacity: { attempt: 1, owner: { pid: 1234, start: '123', boot: 'boot', cgroup: '' } } } as CapacityTask;
  const research = { ...task, id: 'G-899', state: 'verified', engine: 'codex-2',
    attempts: [{ ...task.attempts[0]!, engine: 'codex-2', effort: 'max' }], claudeCapacity: undefined } as Task;
  const policy: CapacityPolicy = { version: 1, repository: directory, enabled: true,
    review: { sha: 'reviewed-source', by: 'codex-1/xhigh', fingerprint: capacityFingerprint() }, tasks: {
      [task.id]: { brief, digest: briefDigest(brief), purpose: 'frontend-implementation', researchTask: research.id } } };
  let ledger: Ledger = { tasks: { [task.id]: task, [research.id]: research } };
  const signals: string[] = [];
  let alive = true;
  const mutate = async (work: (value: Ledger) => void) => { work(ledger); ledger = JSON.parse(JSON.stringify(ledger)) as Ledger; };
  const pass = (value: CapacityCache, now: number, enabled = true) => coordinateClaudeCapacity({ policy: { ...policy, enabled }, cache: value, now, mutate,
    owns: candidate => alive && candidate.id === task.id,
    signal: (candidate, signal) => {
      // Check the previously committed transaction, not just the current mutable callback argument.
      expect(ledger.tasks[candidate.id]!.state).toBe('stopped');
      expect((ledger.tasks[candidate.id] as CapacityTask).claudeCapacity?.pause).toBeDefined();
      signals.push(signal);
    } });
  return { task, policy, signals, ledger: () => ledger, alive: (value: boolean) => { alive = value; }, pass };
}

test('pause checkpoints before interruption, survives restart, escalates narrowly and queues one same-session resume after a real reset', async () => {
  const f = managedFixture();
  const foreign = { ...f.task, id: 'G-901', worktree: '/separate/about', claudeCapacity: undefined };
  f.ledger().tasks[foreign.id] = foreign;
  await f.pass(cache(60), NOW); expect(f.signals).toEqual(['SIGINT']);
  await f.pass(cache(60, 70, NOW + 6000), NOW + 6000); expect(f.signals.at(-1)).toBe('SIGTERM');
  await f.pass(cache(60, 70, NOW + 12000), NOW + 12000); expect(f.signals.at(-1)).toBe('SIGKILL');
  f.alive(false);
  await f.pass(cache(60, 70, NOW + 18000), NOW + 18000);
  let retained = f.ledger().tasks[f.task.id] as CapacityTask;
  expect(retained.state).toBe('stopped'); expect(retained.attempts).toHaveLength(1);
  expect(retained.attempts[0]!.session).toBe('retained-native-session'); expect(retained.waitingResume).toBeUndefined();
  expect(f.ledger().tasks[foreign.id]!.state).toBe('running');
  // A lower reading alone, or just passing the timestamp with old evidence, cannot resume.
  await f.pass(cache(0, 70, NOW + 20_000), NOW + 20_000);
  expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeUndefined();
  await f.pass(cache(60), NOW + 3600_001); expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeUndefined();
  const resetAt = NOW + 3600_001, fresh = cache(0, 72, resetAt, NOW + 5 * 3600_000);
  await f.pass(fresh, resetAt); retained = f.ledger().tasks[f.task.id] as CapacityTask;
  expect(retained.waitingResume).toMatchObject({ fresh: false, forceUsage: false });
  const token = retained.waitingResume!.token;
  await f.pass(fresh, resetAt + 1000); expect(f.ledger().tasks[f.task.id]!.waitingResume!.token).toBe(token);
  expect(retained.attempts).toHaveLength(1);
});

test('policy stop, revoked approval and source-review invalidation interrupt only managed work and retain claims', async () => {
  for (const cause of ['stop', 'revoke', 'source'] as const) {
    const f = managedFixture();
    if (cause === 'revoke') delete f.policy.tasks[f.task.id];
    if (cause === 'source') f.policy.review!.fingerprint = 'changed-source';
    await f.pass(cache(), NOW, cause !== 'stop');
    expect(f.signals).toEqual(['SIGINT']); expect(f.ledger().tasks[f.task.id]!.paths).toEqual(f.task.paths);
    f.alive(false);
    await f.pass(cache(0, 70, NOW + 3600_001, NOW + 5 * 3600_000), NOW + 3600_001, cause !== 'stop');
    expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeUndefined();
  }
});

test('loss of the usage cache checkpoints a task baseline and still permits resumption after refreshed reset evidence', async () => {
  const f = managedFixture();
  await f.pass(cache(20), NOW);
  await f.pass({ current: { observedAt: NOW + 1000, error: 'request-failed' } }, NOW + 1000);
  f.alive(false);
  const task = f.ledger().tasks[f.task.id] as CapacityTask;
  expect(task.claudeCapacity?.pause?.five_hour?.used).toBe(20);
  const at = NOW + 3600_001;
  await f.pass(cache(0, 70, at, NOW + 5 * 3600_000), at);
  expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeDefined();
});

test.each(['stop', 'source', 'revoke', 'request-failed', 'capacity-unknown'] as const)(
  'a resolved %s pause resumes in the same window without completing the interrupted worker', async cause => {
    const { settlementOwed } = await import('./settle.ts');
    const f = managedFixture(), grant = f.policy.tasks[f.task.id]!;
    if (cause === 'source') f.policy.review!.fingerprint = 'changed-source';
    if (cause === 'revoke') delete f.policy.tasks[f.task.id];
    const failed: CapacityCache = cause === 'request-failed' ? { current: { observedAt: NOW, error: 'request-failed' } }
      : cause === 'capacity-unknown' ? cache(0, 70, NOW - 45_001) : cache(0);
    await f.pass(failed, NOW, cause !== 'stop');
    expect(f.signals).toEqual(['SIGINT']);
    f.policy.review!.fingerprint = capacityFingerprint(); f.policy.tasks[f.task.id] = grant;
    // Fixing policy/observations cannot replace a process which is still exiting.
    await f.pass(cache(12, 71, NOW + 1000), NOW + 1000);
    expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeUndefined();
    f.alive(false);
    await f.pass(cache(12, 71, NOW + 2000), NOW + 2000);
    const task = f.ledger().tasks[f.task.id] as CapacityTask;
    expect(task.waitingResume).toMatchObject({ fresh: false, forceUsage: false });
    expect(task.state).toBe('stopped'); expect(task.attempts).toHaveLength(1);
    expect(task.claudeCapacity?.pause?.stage).toBe('waiting');
    expect(settlementOwed(task)).toBe(false);
    const token = task.waitingResume!.token;
    await f.pass(cache(12, 71, NOW + 3000), NOW + 3000);
    expect(f.ledger().tasks[f.task.id]!.waitingResume!.token).toBe(token);
  });

test('recovering a configuration pause still waits for real headroom and retains the about reserve', async () => {
  const f = managedFixture(); await f.pass(cache(0), NOW, false); f.alive(false);
  for (const [five, seven] of [[100, 70], [0, 100], [60, 70], [52, 70]]) {
    await f.pass(cache(five, seven, NOW + 1000), NOW + 1000);
    expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeUndefined();
  }
  await f.pass(cache(12, 71, NOW + 2000), NOW + 2000);
  expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeDefined();
});

test('weekly exhaustion resumes only on a provider-confirmed weekly reset, even when about reserve is released', async () => {
  const f = managedFixture(); f.policy.aboutCompletion = { verifiedAt: new Date(NOW).toISOString(), evidence: 'About accepted after explicit verification' };
  await f.pass(cache(20, 100), NOW); f.alive(false);
  const nextFive = cache(0, 100, NOW + 3600_001, NOW + 5 * 3600_000);
  await f.pass(nextFive, nextFive.current.observedAt);
  const pause = (f.ledger().tasks[f.task.id] as CapacityTask).claudeCapacity!.pause!;
  expect(pauseCanResume(pause, nextFive)).toBe(false);
  const nextWeek = cache(0, 0, NOW + 86400_001, NOW + 90000_000, NOW + 8 * 86400_000);
  await f.pass(nextWeek, nextWeek.current.observedAt);
  expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeDefined();
});

test('explicit verified about completion can resume a reserve pause in the same window without inferring a reset', async () => {
  const f = managedFixture(); await f.pass(cache(60), NOW); f.alive(false);
  await f.pass(cache(60, 70, NOW + 1000), NOW + 1000);
  expect(f.ledger().tasks[f.task.id]!.waitingResume).toBeUndefined();
  f.policy.aboutCompletion = { verifiedAt: new Date(NOW + 2000).toISOString(), evidence: 'Accepted about outcomes and explicit owner verification' };
  await f.pass(cache(60, 70, NOW + 2000), NOW + 2000);
  expect(f.ledger().tasks[f.task.id]!.waitingResume?.reason).toBe('verified about completion released the reserve');
});

test('process ownership requires the recorded native attempt, start/boot identity and both task/worktree markers', () => {
  const f = managedFixture(), proc = temporary();
  mkdirSync(join(proc, 'sys/kernel/random'), { recursive: true });
  mkdirSync(join(proc, '1234'));
  writeFileSync(join(proc, 'sys/kernel/random/boot_id'), 'boot');
  writeFileSync(join(proc, '1234/stat'), `1234 (claude worker) S 1 1234 ${Array(16).fill('0').join(' ')} 123`);
  writeFileSync(join(proc, '1234/cgroup'), '');
  const envFile = join(proc, '1234/environ');
  writeFileSync(envFile, `GOAL_TASK_ID=${f.task.id}\0GOAL_WORKTREE=${f.task.worktree}\0`);
  expect(ownsClaudeProcess(f.task, proc)).toBe(true);
  writeFileSync(envFile, `GOAL_TASK_ID=${f.task.id}\0GOAL_WORKTREE=/separate/about\0`);
  expect(ownsClaudeProcess(f.task, proc)).toBe(false);
  writeFileSync(envFile, `GOAL_TASK_ID=${f.task.id}\0GOAL_WORKTREE=${f.task.worktree}\0`);
  f.task.claudeCapacity!.owner.start = '124'; expect(ownsClaudeProcess(f.task, proc)).toBe(false);
  f.task.claudeCapacity!.owner.start = '123'; f.task.claudeCapacity!.owner.boot = 'old-boot';
  expect(ownsClaudeProcess(f.task, proc)).toBe(false);
});

test('replacement waits for the exact recorded process generation independently of stopped ledger state', () => {
  const f = managedFixture(), owner = processIdentity(process.pid)!;
  f.task.state = 'stopped'; f.task.attempts[0]!.pid = owner.pid; f.task.claudeCapacity!.owner = { ...owner };
  expect(() => assertPreviousClaudeExited(f.task)).toThrow('previous Claude process');
  f.task.claudeCapacity!.owner.start += '0';
  expect(() => assertPreviousClaudeExited(f.task)).not.toThrow();
  f.task.claudeCapacity!.owner = { ...owner, boot: 'previous-boot' };
  expect(() => assertPreviousClaudeExited(f.task)).not.toThrow();
  f.task.claudeCapacity!.owner = owner; f.task.attempts[0]!.engine = 'codex-2';
  expect(() => assertPreviousClaudeExited(f.task)).not.toThrow();
});

test('capacity pause suppresses settlement and natural worker exit is not turned into a paused completion', async () => {
  const { settlementOwed } = await import('./settle.ts');
  const f = managedFixture(); await f.pass(cache(60), NOW);
  expect(settlementOwed(f.ledger().tasks[f.task.id]!)).toBe(false);
  const natural = managedFixture(); natural.alive(false); await natural.pass(cache(60), NOW);
  expect((natural.ledger().tasks[natural.task.id] as CapacityTask).claudeCapacity?.pause).toBeUndefined();
  expect(natural.signals).toEqual([]);
  const task = f.ledger().tasks[f.task.id] as CapacityTask;
  recordClaudeLaunch(task, { ...task.attempts[0]!, n: 2, engine: 'codex-2', effort: 'max' });
  expect(task.claudeCapacity).toBeDefined(); expect(task.claudeCapacity?.pause).toBeUndefined();
});

test('recorded jobs survive a quota wait beyond four hours and reconcile a capacity resume without a duplicate wake', async () => {
  const f = managedFixture();
  const store = new JobStore(jobDirectory(f.task.worktree));
  const mutate = async (work: (ledger: Ledger) => void) => { work(f.ledger()); };
  const reports: string[] = [], starts: string[] = [];
  const options = { mutate, report: (_: unknown, reason: string) => { reports.push(reason); }, admit: () => ({} as never),
    start: ((task: Task, effort: string, session: string) => {
      starts.push(session); return { ...task.attempts.at(-1)!, n: task.attempts.length + 1, effort, session };
    }) as NonNullable<Parameters<typeof wakeJobs>[1]>['start'] };
  try {
    store.put({ id: 'retained-job', task: f.task.id, attempt: 1, cwd: f.task.worktree, command: ['fixture'],
      phase: 'parked', created: NOW, code: 0, ended: NOW });
    await f.pass(cache(60), NOW); f.alive(false);
    await wakeJobs(store, { ...options, now: NOW + JOB_WAIT_MS + 1 });
    expect(store.get('retained-job')!.phase).toBe('parked');
    expect(reports).toEqual([]); expect(starts).toEqual([]);
    const resumedAt = NOW + 5 * 3600_000;
    await f.pass(cache(0, 70, resumedAt, resumedAt + 5 * 3600_000), resumedAt);
    const task = f.ledger().tasks[f.task.id] as CapacityTask;
    expect(task.waitingResume).toBeDefined();
    // The existing queue publishes the retained-session capacity turn, replacing the pause marker.
    task.attempts.push({ ...task.attempts[0]!, n: 2, pid: 999999, endedAt: undefined });
    task.state = 'running'; delete task.waitingResume; delete task.claudeCapacity;
    await wakeJobs(store, { ...options, now: resumedAt });
    expect(starts).toEqual([]); expect(reports).toEqual([]);
    expect(store.get('retained-job')!.attempt).toBe(2);
    expect(store.get('retained-job')!.capacityDelayMs).toBe(5 * 3600_000);
    // A restarted coordinator adopts the mid-step turn first, then wakes it exactly once with the result.
    task.state = 'exited';
    await wakeJobs(store, { ...options, now: resumedAt + 1 });
    await wakeJobs(store, { ...options, now: resumedAt + 2 });
    expect(starts).toEqual(['retained-native-session']); expect(reports).toEqual([]);
    expect(store.get('retained-job')).toMatchObject({ phase: 'woken', resumedAttempt: 3 });
  } finally { store.close(); }
});

test('Task command routing exposes sanitized local status and requires explicit verified completion evidence', () => {
  const directory = temporary(), settings = join(directory, '.goalctl'); mkdirSync(settings);
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: directory }).status).toBe(0);
  const module = join(import.meta.dir, 'commands/claude-capacity.ts');
  const run = (args: string[]) => spawnSync(process.execPath, ['-e',
    `import command from ${JSON.stringify(module)}; try { process.exitCode = await command(${JSON.stringify(args)}); } catch(error) { console.error(error.message); process.exitCode=1; }`],
  { cwd: directory, encoding: 'utf8', timeout: 10000, env: { ...process.env, GOAL_SETTINGS_DIRECTORY: settings } });
  expect(run(['status']).status).toBe(0);
  expect(run(['release', '--verified-completion', 'idle']).status).toBe(1);
  expect(run(['release', '--verified-completion', 'Verified acceptance checks and owner confirmation']).status).toBe(0);
  const file = join(settings, 'claude-capacity.user.json');
  expect(JSON.parse(readFileSync(file, 'utf8')).aboutCompletion.evidence).toContain('Verified acceptance');
  expect(run(['reserve']).status).toBe(0); expect(JSON.parse(readFileSync(file, 'utf8')).aboutCompletion).toBeUndefined();
  expect(run(['start', '--reviewed-sha', 'unreviewed', '--reviewed-by', 'codex-2/max']).status).toBe(1);
  expect(run(['stop']).status).toBe(0); expect(JSON.parse(readFileSync(file, 'utf8')).enabled).toBe(false);
});
