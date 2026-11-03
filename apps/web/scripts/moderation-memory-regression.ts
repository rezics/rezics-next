import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(import.meta.dir, '..');
const memoryLimitBytes = 1_700_000_000;
const caseDeadlineMs = 60_000;
const fileDeadlineMs = 120_000;
const combinedDeadlineMs = 480_000;
const overallDeadlineMs = 600_000;
const pollMs = 10;
const terminationGraceMs = 2_000;

const contentCases = [
  'Reports and Appeals compose complete, independently labelled case frames around real evidence and review controls',
  'report and appeal sparse, loading, denied, stale, unavailable and closed states disclose no case content',
  'loaded bulk reports keep the page bound, restore review and cancel focus, and retry only the exact uncertain item',
  'the default Reports visit hides its private case when the same account receives a replacement session',
];

const moderationFiles = [
  'tests/moderation-content-item.test.tsx',
  'tests/moderation-private-case-content-item.test.tsx',
  'tests/moderation-private-reader-lifetime.test.tsx',
  'tests/moderation-bulk-interface.test.tsx',
  'tests/moderation-queue-controls-interface.test.tsx',
  'tests/moderation-case-reference-interface.test.tsx',
  'tests/moderation-appeal-read-retry-focus.test.tsx',
  'tests/moderation-reports.test.tsx',
  'tests/moderation-appeals.test.tsx',
  'tests/moderation-appeals-pages.test.tsx',
  'tests/moderation-decision.test.tsx',
];

type TestCounts = { pass: number | null; fail: number | null; skip: number | null; failureLocation: string | null };
type ProcSample = { start: string; rss: number; highWater: number };
type ProcessPeak = { sampledRssBytes: number; highWaterBoundBytes: number; processCount: number };
type CgroupMetrics = { currentBytes: number; oomEvents: number };
type RunResult = {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  peakRssBytes: number | null;
  rssHighWaterBoundBytes: number | null;
  peakCgroupBytes: number | null;
  counts: TestCounts;
  failure?: string;
};

let activePid: number | undefined;
let receivedSignal: NodeJS.Signals | undefined;

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=,-]+$/u.test(value) ? value : JSON.stringify(value);
}

function commandLabel(command: readonly string[]): string {
  return command.map(quote).join(' ');
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForGroup(pid: number, deadline: number): Promise<boolean> {
  while (groupAlive(pid)) {
    if (performance.now() >= deadline) return false;
    await Bun.sleep(pollMs);
  }
  return true;
}

function readProcess(pid: number): ProcSample | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const vmRss = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu);
    const vmHwm = status.match(/^VmHWM:\s+(\d+)\s+kB$/mu);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const start = tail[19];
    if (!vmRss || !vmHwm || !start) return null;
    return { start, rss: Number(vmRss[1]) * 1024, highWater: Number(vmHwm[1]) * 1024 };
  } catch {
    return null;
  }
}

function readChildren(pid: number): number[] {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return children ? children.split(/\s+/u).map(Number).filter(Number.isSafeInteger) : [];
  } catch {
    return [];
  }
}

function createProcessSampler(rootPid: number): () => ProcessPeak | null {
  const known = new Map<number, ProcSample>();
  let peakSampledRssBytes = 0;
  let peakHighWaterBoundBytes = 0;
  let peakProcessCount = 0;
  return () => {
    const queue = [rootPid, ...known.keys()];
    const visited = new Set<number>();
    const current = new Map<number, ProcSample>();
    while (queue.length) {
      const pid = queue.pop()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const sample = readProcess(pid);
      if (!sample) continue;
      const previous = known.get(pid);
      if (previous && previous.start !== sample.start) known.delete(pid);
      known.set(pid, sample);
      current.set(pid, sample);
      queue.push(...readChildren(pid));
    }
    if (!current.has(rootPid) && known.size === 0) return null;
    const rssBytes = [...current.values()].reduce((sum, sample) => sum + sample.rss, 0);
    const highWaterBound = [...known.values()].reduce((sum, sample) => sum + sample.highWater, 0);
    peakSampledRssBytes = Math.max(peakSampledRssBytes, rssBytes);
    peakHighWaterBoundBytes = Math.max(peakHighWaterBoundBytes, highWaterBound);
    peakProcessCount = Math.max(peakProcessCount, current.size);
    return {
      sampledRssBytes: peakSampledRssBytes,
      highWaterBoundBytes: peakHighWaterBoundBytes,
      processCount: peakProcessCount,
    };
  };
}

function cgroupDirectory(): string | null {
  try {
    const entry = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((line) => line.startsWith('0::'));
    if (!entry) return null;
    const path = entry.slice(3).replace(/^\/+|\/+$/gu, '');
    return resolve('/sys/fs/cgroup', path);
  } catch {
    return null;
  }
}

function readCgroupMetrics(): CgroupMetrics | null {
  const directory = cgroupDirectory();
  if (!directory) return null;
  try {
    const currentBytes = Number(readFileSync(`${directory}/memory.current`, 'utf8').trim());
    const events = readFileSync(`${directory}/memory.events`, 'utf8');
    const eventCount = (name: string) => Number(events.match(new RegExp(`^${name}\\s+(\\d+)$`, 'mu'))?.[1] ?? 0);
    const oomEvents = eventCount('oom') + eventCount('oom_kill') + eventCount('oom_group_kill');
    if (!Number.isSafeInteger(currentBytes) || currentBytes < 0 || !Number.isSafeInteger(oomEvents)) return null;
    return { currentBytes, oomEvents };
  } catch {
    return null;
  }
}

function counts(): TestCounts {
  return { pass: null, fail: null, skip: null, failureLocation: null };
}

function parseSummaryLine(line: string, result: TestCounts): void {
  const clean = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  const failureLocation = clean.match(/(tests\/[A-Za-z0-9_.-]+\.test\.tsx?):(\d+):\d+/u);
  if (failureLocation) result.failureLocation = `${failureLocation[1]}:${failureLocation[2]}`;
  for (const [key, pattern] of [
    ['pass', /\b(\d+)\s+pass(?:ed)?\b/iu],
    ['fail', /\b(\d+)\s+fail(?:ed)?\b/iu],
    ['skip', /\b(\d+)\s+skip(?:ped)?\b/iu],
  ] as const) {
    const match = clean.match(pattern);
    if (match) result[key] = Number(match[1]);
  }
}

async function drain(stream: ReadableStream<Uint8Array>, result: TestCounts): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = `${partial}${decoder.decode(value, { stream: true })}`.split('\n');
      partial = lines.pop()!.slice(-2048);
      for (const line of lines) parseSummaryLine(line, result);
    }
    const final = `${partial}${decoder.decode()}`;
    if (final) parseSummaryLine(final, result);
  } finally {
    reader.releaseLock();
  }
}

function printResult(result: RunResult): void {
  const fields = [
    `command=${JSON.stringify(commandLabel(result.command))}`,
    `exit=${result.exitCode === null ? 'not-started' : result.exitCode}`,
    `signal=${result.signal ?? 'none'}`,
    `duration_ms=${result.durationMs}`,
    `peak_rss_sampled_bytes=${result.peakRssBytes ?? 'unavailable'}`,
    `rss_high_water_bound_bytes=${result.rssHighWaterBoundBytes ?? 'unavailable'}`,
    `peak_cgroup_sampled_bytes=${result.peakCgroupBytes ?? 'unavailable'}`,
    `tests=${result.counts.pass === null ? 'unknown' : result.counts.pass}`,
    `failed=${result.counts.fail === null ? 'unknown' : result.counts.fail}`,
    `skipped=${result.counts.skip === null ? 'unknown' : result.counts.skip}`,
    ...(result.counts.failureLocation ? [`failure_at=${result.counts.failureLocation}`] : []),
    `result=${result.failure ? 'FAIL' : 'PASS'}`,
  ];
  console.log(`moderation-memory-regression: ${fields.join(' ')}`);
  if (result.failure) console.error(`moderation-memory-regression: ${result.failure}`);
}

async function stopGroup(pid: number, exited: Promise<number>): Promise<void> {
  if (!groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  const ended = await Promise.race([
    exited.then(() => true),
    Bun.sleep(terminationGraceMs).then(() => false),
  ]);
  if (!ended || groupAlive(pid)) signalGroup(pid, 'SIGKILL');
  if (!(await waitForGroup(pid, performance.now() + terminationGraceMs)))
    throw new Error(`child process group ${pid} remained alive after SIGKILL`);
}

async function runCommand(
  command: string[],
  perCommandDeadlineMs: number,
  overallDeadline: number,
  mode: 'isolated-case' | 'complete-suite',
): Promise<boolean> {
  const started = performance.now();
  const testCounts = counts();
  const initialCgroup = readCgroupMetrics();
  const result: RunResult = {
    command,
    exitCode: null,
    signal: null,
    durationMs: 0,
    peakRssBytes: null,
    rssHighWaterBoundBytes: null,
    peakCgroupBytes: initialCgroup?.currentBytes ?? null,
    counts: testCounts,
  };
  if (receivedSignal) result.failure = `interrupted by ${receivedSignal}`;
  else if (performance.now() >= overallDeadline) result.failure = 'overall deadline expired before command start';
  else if (initialCgroup && initialCgroup.currentBytes >= memoryLimitBytes)
    result.failure = `cgroup usage before command reached ${memoryLimitBytes} bytes`;
  if (result.failure) {
    result.durationMs = Math.round(performance.now() - started);
    printResult(result);
    return false;
  }

  const child = Bun.spawn(command, {
    cwd: app,
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pid = child.pid;
  if (!pid) {
    result.failure = 'runtime did not expose the child pid for resource measurement';
    result.durationMs = Math.round(performance.now() - started);
    printResult(result);
    return false;
  }
  activePid = pid;
  const sampleTree = createProcessSampler(pid);
  let exitCode: number | undefined;
  const exited = child.exited.then((code) => {
    exitCode = code;
    return code;
  });
  const output = Promise.all([drain(child.stdout, testCounts), drain(child.stderr, testCounts)]);
  const deadline = Math.min(performance.now() + perCommandDeadlineMs, overallDeadline);
  let peakRssBytes: number | null = null;
  let rssHighWaterBoundBytes: number | null = null;
  let peakCgroupBytes = initialCgroup?.currentBytes ?? null;
  let failure: string | undefined;

  while (exitCode === undefined) {
    const sampled = sampleTree();
    if (sampled) {
      peakRssBytes = Math.max(peakRssBytes ?? 0, sampled.sampledRssBytes);
      rssHighWaterBoundBytes = Math.max(rssHighWaterBoundBytes ?? 0, sampled.highWaterBoundBytes);
    }
    const cgroup = readCgroupMetrics();
    if (cgroup) {
      peakCgroupBytes = Math.max(peakCgroupBytes ?? 0, cgroup.currentBytes);
      if (initialCgroup && cgroup.oomEvents > initialCgroup.oomEvents) failure = 'cgroup recorded an OOM event';
    }
    if (!peakRssBytes && !cgroup) failure = 'physical RSS measurement is unavailable';
    if (
      (peakRssBytes ?? 0) >= memoryLimitBytes ||
      (rssHighWaterBoundBytes ?? 0) >= memoryLimitBytes
    )
      failure = `process-tree RSS reached ${memoryLimitBytes} bytes`;
    if ((peakCgroupBytes ?? 0) >= memoryLimitBytes)
      failure = `sampled cgroup usage reached ${memoryLimitBytes} bytes`;
    if (receivedSignal) failure = `interrupted by ${receivedSignal}`;
    if (performance.now() >= deadline) failure = 'command deadline expired';
    if (failure) {
      signalGroup(pid, 'SIGTERM');
      break;
    }
    await Promise.race([exited.then(() => undefined), Bun.sleep(pollMs)]);
  }

  if (failure) {
    await stopGroup(pid, exited);
  }
  result.exitCode = await exited;
  await output;
  if (!failure && !(await waitForGroup(pid, performance.now() + terminationGraceMs))) {
    failure = 'child process group remained alive after the test command';
    await stopGroup(pid, exited);
  }
  activePid = undefined;
  result.signal = child.signalCode == null ? null : String(child.signalCode);
  const finalTree = sampleTree();
  if (finalTree) {
    peakRssBytes = Math.max(peakRssBytes ?? 0, finalTree.sampledRssBytes);
    rssHighWaterBoundBytes = Math.max(rssHighWaterBoundBytes ?? 0, finalTree.highWaterBoundBytes);
  }
  const finalCgroup = readCgroupMetrics();
  if (finalCgroup) peakCgroupBytes = Math.max(peakCgroupBytes ?? 0, finalCgroup.currentBytes);
  result.peakRssBytes = peakRssBytes;
  result.rssHighWaterBoundBytes = rssHighWaterBoundBytes;
  result.peakCgroupBytes = peakCgroupBytes;
  result.durationMs = Math.round(performance.now() - started);
  if (failure) result.failure = failure;
  else if (result.signal) result.failure = `child terminated by ${result.signal}`;
  else if (result.exitCode !== 0) result.failure = `child exited with ${result.exitCode}`;
  else if (peakRssBytes === null) result.failure = 'physical RSS measurement is unavailable';
  else if (mode === 'complete-suite' && (testCounts.pass === null || testCounts.fail === null || testCounts.skip === null))
    result.failure = 'test summary was missing; skipped-test status cannot be established';
  else if (mode === 'complete-suite' && testCounts.fail !== 0) result.failure = 'one or more tests failed';
  else if (mode === 'complete-suite' && testCounts.skip !== 0) result.failure = 'one or more tests were skipped';
  else if (testCounts.pass === 0) result.failure = 'no test passed; the test name may have been skipped or unmatched';
  else if (mode === 'isolated-case' && testCounts.pass !== 1)
    result.failure = `expected one selected test to pass, received ${testCounts.pass}`;
  else if (
    (peakRssBytes ?? 0) >= memoryLimitBytes ||
    (rssHighWaterBoundBytes ?? 0) >= memoryLimitBytes ||
    (peakCgroupBytes ?? 0) >= memoryLimitBytes
  )
    result.failure = `resource peak reached ${memoryLimitBytes} bytes`;
  printResult(result);
  return !result.failure;
}

function installSignalHandlers(): () => void {
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = () => {
      receivedSignal ??= signal;
      if (activePid) signalGroup(activePid, signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--cases-only')) {
    console.error('Usage: bun scripts/moderation-memory-regression.ts [--cases-only]');
    return 2;
  }
  if (process.platform !== 'linux') {
    console.error('moderation-memory-regression: Linux /proc RSS measurement is required');
    return 1;
  }
  const removeSignalHandlers = installSignalHandlers();
  const overallDeadline = performance.now() + overallDeadlineMs;
  try {
    for (const name of contentCases) {
      const command = ['bun', 'test', '--test-name-pattern', name, 'tests/moderation-content-item.test.tsx'];
      if (!(await runCommand(command, caseDeadlineMs, overallDeadline, 'isolated-case'))) return 1;
    }
    if (args[0] === '--cases-only') return 0;
    if (
      !(await runCommand(
        ['bun', 'test', 'tests/moderation-content-item.test.tsx'],
        fileDeadlineMs,
        overallDeadline,
        'complete-suite',
      ))
    )
      return 1;
    if (
      !(await runCommand(['bun', 'test', ...moderationFiles], combinedDeadlineMs, overallDeadline, 'complete-suite'))
    )
      return 1;
    return receivedSignal ? 128 : 0;
  } finally {
    removeSignalHandlers();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`moderation-memory-regression: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
