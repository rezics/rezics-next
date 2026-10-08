import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as filesystem from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJUnit, UNEXECUTED_FILE_TEST, type TestResult } from '../qa/acceptance.ts';
import { newRunId, type Tier } from '../qa/core.ts';
import { physicalPath, POSTGRES_SOCKET_LIMIT, postgresSocketByteLength } from './postgres-socket.ts';

export type RegressionTier = 'unit' | 'owner' | 'model' | 'integration' | 'fault/recovery' | 'e2e' | 'accounts:storybook' | 'jena:check';
export type Classification = 'infrastructure' | 'resource' | 'deadline' | 'order-dependent' | 'flaky' | 'deterministic';
type Outcome = 'pending' | 'passed' | 'failed' | 'missing' | 'void' | 'excluded' | 'deferred';
export interface MergeEvent { before: string; after: string; goal: string; taskIds: string[]; at: string }
export interface ExpectedFile { file: string; tier: RegressionTier | 'live' | 'load' | 'legacy' | 'external'; outcome: Outcome; reason?: string }
export interface Execution {
  code: number; outcomes: Record<string, 'passed' | 'failed' | 'missing'>; artifactPaths: string[];
  queueMs: number; testMs: number; totalMs: number; evidence?: string; classification?: Classification;
  failingTests?: string[];
  cause?: string;
}
export interface Batch {
  id: string; tier: RegressionTier; files: string[]; state: 'pending' | 'running' | 'done'; attempts: Execution[];
}
export interface Diagnosis {
  file: string; status: 'attributed' | 'inherited' | 'unavailable' | 'inconclusive'; classification: Classification;
  before?: string; after: string; goal?: string; taskIds?: string[]; probes: { commit: string; outcome: string }[];
  artifactPaths: string[]; reason?: string;
}
export interface InboxEntry {
  runId: string; atCommit: string; failingTests: string[]; before?: string; after: string;
  goal: string; taskIds: string[]; status: Diagnosis['status']; classification: Classification; artifactPaths: string[];
  runEvent?: { batchId: string; tier: RegressionTier; fileCount: number; cause: string };
}
export interface Manifest {
  version: 1; runId: string; atCommit: string; checkout: string; startedAt: string; finishedAt?: string;
  shards: number; partial: boolean; status: 'running' | 'passed' | 'failed' | 'incomplete';
  files: ExpectedFile[]; batches: Batch[]; preflight: { commit: string; ok: boolean; artifactPaths: string[]; reason?: string };
  diagnoses: Diagnosis[];
  /** Reserved before starting a probe, including interrupted probes, so resume cannot reset the eight-probe bound. */
  probeCounts?: Record<string, number>;
  /** Browser tiers are inventoried but excluded from routine runs; older manifests included them. */
  selection?: 'routine' | 'explicit';
}
export interface RegressionOptions {
  repo: string; stateDir: string; at?: string; resume?: string; only?: RegressionTier[]; integrationBatches?: number;
  shards?: number; slots?: number; runId?: string; checkoutRoot?: string; legacyRoot?: string;
  registry?: (checkout: string) => Promise<ExpectedFile[]>;
  prepare?: (checkout: string) => Promise<{ ok: boolean; artifactPaths: string[]; reason?: string }>;
  runner?: (checkout: string, batch: Batch, directory: string, shards: number, slotLimit: number) => Promise<Execution>;
  waitForTurn?: typeof waitForRegressionTurn;
  route?: (entry: InboxEntry) => Promise<void>;
}
export interface RegressionTurnOptions {
  status?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadline?: number;
  announce?: (message: string) => void;
}

/** Explicit maintenance barrier. Normal browser runs join the shared fair queue without waiting for it to drain. */
export async function waitForRegressionTurn(lockDir?: string, interrupted: () => boolean = () => false,
  options: RegressionTurnOptions = {}): Promise<void> {
  // goalctl imports this module; loading its status reader only at runtime avoids a static import cycle.
  let status = options.status;
  if (!status) {
    const { heavyQaStatus } = await import('./goalctl.ts');
    status = () => heavyQaStatus(lockDir);
  }
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + 6 * 3_600_000;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  let announced = false;
  for (;;) {
    if (interrupted()) throw new Error('Regression interrupted while yielding to heavy QA; use --resume');
    const current = status();
    // Wait through acquisition as well: a ticket disappears when its run takes the lock, before that run finishes.
    if (current === 'free; 0 waiting') return;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Regression timed out yielding to heavy QA: ${current}`);
    if (!announced) {
      (options.announce ?? console.error)(`Regression yielding to heavy QA: ${current}`);
      announced = true;
    }
    await sleep(Math.min(10_000, remaining));
  }
}
const tiers: RegressionTier[] = ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook', 'jena:check'];
const browserTier = (tier: RegressionTier): boolean => tier === 'e2e' || tier === 'accounts:storybook';
const routineBrowserReason = 'Browser journeys and Storybook run in the nightly full regression';
const batchSize = (tier: RegressionTier, files: number): number =>
  tier === 'integration' ? 5 : tier === 'unit' || tier === 'owner' || tier === 'fault/recovery' ? 15 : files;
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
function atomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const ancestor = (repo: string, before: string, after: string): boolean =>
  spawnSync('git', ['merge-base', '--is-ancestor', before, after], { cwd: repo }).status === 0;
const validId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,60}$/.test(id);
// Linux superblock magic values: /usr/include/linux/magic.h.
export function isRamBackedFileSystem(type: number | bigint): boolean {
  return [0x01021994, 0x858458f6, 0x958458f6].includes(Number(type) >>> 0);
}
type FileSystemType = (path: string) => number | bigint;
const fileSystemType: FileSystemType = path => filesystem.statfsSync(path).type;
function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}
function diskDirectory(path: string, purpose: string, probe: FileSystemType = fileSystemType): string {
  let parent = resolve(path);
  while (!existsSync(parent)) parent = dirname(parent);
  if (isRamBackedFileSystem(probe(realpathSync(parent)))) {
    throw new Error(`Regression ${purpose} is on a RAM-backed filesystem: ${path}; choose a disk path`);
  }
  mkdirSync(path, { recursive: true });
  const physical = realpathSync(path);
  if (isRamBackedFileSystem(probe(physical))) throw new Error(`Regression ${purpose} is on a RAM-backed filesystem: ${physical}; choose a disk path`);
  return physical;
}

export function regressionCheckoutRoot(repo: string, override?: string, probe: FileSystemType = fileSystemType): string {
  const key = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 12);
  const root = override ?? process.env.GOAL_REGRESS_CHECKOUT_ROOT ?? join(homedir(), '.cache', 'rezics-r', key);
  const physical = diskDirectory(root, 'checkout root', probe);
  checkoutNameLength(physical);
  return physical;
}

export function checkoutNameLength(checkoutRoot: string): number {
  // One byte remains for the slash between the checkout root and the short name.
  const length = Math.min(16, POSTGRES_SOCKET_LIMIT - postgresSocketByteLength(physicalPath(checkoutRoot)) - 1);
  if (length < 2) throw new Error('Regression checkout root is too deep for PostgreSQL sockets; set GOAL_REGRESS_CHECKOUT_ROOT to a shorter disk path');
  return length;
}

export function parseRegressArgs(args: string[]): Pick<RegressionOptions, 'at' | 'resume' | 'only' | 'integrationBatches'> {
  const options: ReturnType<typeof parseRegressArgs> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--at' && /^[A-Za-z0-9._/@^~-]+$/.test(value)) options.at = value;
    else if (flag === '--resume' && validId(value)) options.resume = value;
    else if (flag === '--only' && value.split(',').every(tier => tiers.includes(tier as RegressionTier))) {
      options.only = [...new Set(value.split(',') as RegressionTier[])];
    } else if (flag === '--integration-batches' && /^\d+$/.test(value)) options.integrationBatches = Number(value);
    else throw new Error(`Invalid regress option: ${flag} ${value}`);
  }
  if (options.resume && (options.only || options.integrationBatches !== undefined)) throw new Error('Resume keeps the original selection');
  return options;
}

/** Discover the pinned harness, rather than copying its ever-growing gate lists into another runner. */
export async function regressionRegistry(checkout: string): Promise<ExpectedFile[]> {
  const registry = await import(pathToFileURL(join(checkout, 'scripts/qa/acceptance.ts')).href) as typeof import('../qa/acceptance.ts');
  const core = await import(pathToFileURL(join(checkout, 'scripts/qa/core.ts')).href) as typeof import('../qa/core.ts');
  const files: ExpectedFile[] = [];
  files.push({ file: 'scripts/qa/jena-cli.ts', tier: 'jena:check', outcome: 'pending' });
  for (const tier of ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'load'] as const) {
    const paths = core.splitTestArgs(registry.testArgs(tier)).paths;
    if (tier === 'unit') paths.push(...registry.unitHarnessFiles);
    for (const file of core.expandTestPaths(checkout, paths)) files.push({ file, tier,
      outcome: tier === 'load' ? 'excluded' : 'pending', ...(tier === 'load' ? { reason: 'Opt-in load qualification' } : {}) });
  }
  const scan = (pattern: string, cwd = checkout) => [...new Bun.Glob(pattern).scanSync({ cwd })].sort();
  files.push(...scan('apps/web/tests/*.e2e.ts').map(file => ({ file, tier: 'e2e' as const, outcome: 'pending' as const })));
  for (const workspace of ['apps/web', 'apps/accounts']) {
    const config = readFileSync(join(checkout, workspace, '.storybook/main.ts'), 'utf8');
    const list = /stories:\s*\[([^\]]+)\]/.exec(config)?.[1];
    if (!list) throw new Error(`Cannot discover ${workspace} Storybook files`);
    const globs = [...list.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!.replace('@(ts|tsx)', '{ts,tsx}'));
    for (const pattern of globs) {
      const matches = scan(pattern, join(checkout, workspace, '.storybook'));
      if (!matches.length) throw new Error(`Zero-match Storybook glob: ${workspace}/${pattern}`);
      for (const path of matches) files.push({ file: relative(checkout, resolve(checkout, workspace, '.storybook', path)),
        tier: workspace === 'apps/web' ? 'e2e' : 'accounts:storybook', outcome: 'pending' });
    }
  }
  files.push(...scan('tests/live/**/*.test.ts').map(file => ({ file, tier: 'live' as const,
    outcome: 'excluded' as const, reason: 'Opt-in network/provider evidence' })),
  ...registry.legacyHostJenaGateFiles.map(file => ({ file, tier: 'legacy' as const,
    outcome: 'excluded' as const, reason: 'Legacy tests require host JVM/Jena; retained QA gates run instead' })));
  for (const exclusion of registry.testExclusions ?? []) {
    if (!files.some(item => item.file === exclusion.file)) files.push({ file: exclusion.file,
      tier: exclusion.category ?? (exclusion.file.startsWith('apps/about/') ? 'external' : 'live'), outcome: 'excluded', reason: exclusion.reason });
  }
  return files;
}

function batchesFor(files: ExpectedFile[], options: RegressionOptions): Batch[] {
  const batches: Batch[] = [];
  for (const tier of tiers) {
    const expected = files.filter(file => file.tier === tier && file.outcome !== 'excluded');
    if (!expected.length) throw new Error(`Zero-match regression tier: ${tier}`);
    if (!options.only && browserTier(tier)) {
      for (const file of expected) { file.outcome = 'excluded'; file.reason = routineBrowserReason; }
      continue;
    }
    const selected = options.only?.includes(tier) ?? true;
    // An integration batch cap adds that many batches even when --only selects cheap tiers.
    // The pinned-artifact check belongs to every cycle, including a restricted test selection.
    const run = tier === 'jena:check' || selected || (tier === 'integration' && options.integrationBatches !== undefined);
    const size = batchSize(tier, expected.length);
    for (let index = 0; index < expected.length; index += size) {
      const group = expected.slice(index, index + size);
      if (!run || (tier === 'integration' && options.integrationBatches !== undefined && index / size >= options.integrationBatches)) {
        for (const file of group) { file.outcome = 'deferred'; file.reason = 'Restricted regression selection'; }
      } else batches.push({ id: `${tier.replaceAll(/[:/]/g, '-')}-${index / size + 1}`, tier,
        files: group.map(file => file.file), state: 'pending', attempts: [] });
    }
  }
  return batches;
}

export function classify(evidence: string, code = 1): Classification {
  // Bun prints nearby source branches even when they did not execute; their error literals are not runtime evidence.
  const runtime = evidence.replace(/^\s*\d+\s*\|.*$/gm, '');
  if (/cannot connect to the docker daemon|failed to connect to (?:the )?docker (?:daemon|API)|docker.*ECONNREFUSED|ECONNREFUSED.*(?:docker|237[56])|(?:docker\.sock|dockerDesktopLinuxEngine)[^\n]*(?:connection refused|no such file|cannot find)|is the docker daemon running|mounts denied|is not shared from the host and is not known to Docker|all predefined address pools|no available.*address pool|could not find an available, non-overlapping.*address pool|network pool exhausted|oom-kill|Out of memory: Killed process/i.test(runtime)) return 'infrastructure';
  if (code === 137 || /heap out of memory|SIGKILL|resource exhausted|ENOMEM/.test(runtime)) return 'resource';
  if (/exceeded[^\n]*(?:budget|deadline)|timed out|ETIMEDOUT|deadline exceeded|admission deadline reached|reached its run deadline|heavy QA lock stayed held|No QA slot became free/i.test(runtime)) return 'deadline';
  return 'deterministic';
}

function assertionFiles(batch: Batch, result: Execution): string[] {
  const assertions = result.failingTests?.filter(test => !test.endsWith(`: ${UNEXECUTED_FILE_TEST}`)) ?? [];
  // Storybook outcomes come from completed suites; unlike missing suites, their failures are assertion evidence.
  return batch.files.filter(file => assertions.some(test => test.startsWith(`${file}:`))
    || (file.includes('.stories.') && result.outcomes[file] === 'failed'));
}

function batchRunFailure(batch: Batch, result: Execution): boolean {
  return Boolean(result.code) && (result.classification === 'infrastructure'
    || ((result.classification === 'deadline' || result.classification === 'resource')
      && (batch.files.some(file => !result.outcomes[file] || result.outcomes[file] === 'missing') || !assertionFiles(batch, result).length)));
}

async function command(checkout: string, args: string[], logPath: string, timeoutMs = 7 * 3_600_000,
  env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const temporary = diskDirectory(join(checkout, '.temp/tmp'), 'subprocess TMPDIR');
  diskDirectory(dirname(logPath), 'log directory');
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w', 0o600);
  try {
    const child = spawn(args[0]!, args.slice(1), { cwd: checkout, detached: true, stdio: ['ignore', log, log],
      env: { ...env, TMPDIR: temporary } });
    const forward = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; forward('SIGTERM'); }, timeoutMs);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    try { return await new Promise<number>((done, reject) => { child.once('error', reject); child.once('exit', code => {
      if (timedOut) appendFileSync(logPath, '\nCommand deadline exceeded\n');
      done(timedOut ? 124 : code ?? 1);
    }); }); }
    finally { clearTimeout(timer); process.off('SIGINT', forward); process.off('SIGTERM', forward); }
  } finally { closeSync(log); }
}

async function prepareCheckout(checkout: string) {
  const taskfile = ['Taskfile.yml', 'Taskfile.yaml'].map(file => join(checkout, file)).find(file => existsSync(file));
  // Task searches ancestors by default; an unsupported old snapshot must not run another checkout's tasks.
  if (!taskfile) return { ok: false, artifactPaths: [], reason: 'Pinned checkout has no Taskfile' };
  const directory = join(checkout, '.temp/regress-preflight');
  const installLog = join(directory, 'install.log');
  const generatedLog = join(directory, 'generated.log');
  const started = Date.now();
  const installed = await command(checkout, ['task', '--taskfile', taskfile, 'install'], installLog, 600_000) === 0;
  const checked = installed && await command(checkout, ['task', '--taskfile', taskfile, 'gen:check'], generatedLog, Math.max(1, 600_000 - (Date.now() - started))) === 0;
  return { ok: installed && checked, artifactPaths: [installLog, ...(installed ? [generatedLog] : [])],
    ...(!checked ? { reason: installed ? 'Generated artifacts are stale or the pinned build is unavailable' : 'Pinned dependency installation failed' } : {}) };
}

function normalizedFile(checkout: string, workspace: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(checkout, workspace, file.replace(/^\.\//, ''));
  return relative(checkout, absolute).replaceAll('\\', '/');
}

/** Missing/skipped files and zero-test suites are evidence gaps, even when the process exits successfully. */
export function executionOutcomes(checkout: string, batch: Batch, tests: TestResult[], storyXml = '', storyLog = '', commandCode?: number): Execution['outcomes'] {
  if (batch.tier === 'jena:check') return Object.fromEntries(batch.files.map(file =>
    [file, commandCode === undefined ? 'missing' : commandCode === 0 ? 'passed' : 'failed']));
  const outcomes: Execution['outcomes'] = {};
  const workspace = batch.tier === 'accounts:storybook' ? 'apps/accounts' : 'apps/web';
  const stories = new Map<string, 'passed' | 'failed' | 'missing'>();
  for (const match of storyXml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(match[1]!)?.[1];
    const name = attr('name');
    if (name) stories.set(normalizedFile(checkout, workspace, name),
      Number(attr('failures')) > 0 || Number(attr('errors')) > 0 ? 'failed'
        : Number(attr('tests')) > Number(attr('skipped') ?? 0) ? 'passed' : 'missing');
  }
  // The e2e harness runs Storybook after Playwright and saves its unabridged default reporter log.
  const plain = storyLog.replace(/\u001b\[[0-9;]*m/g, '');
  for (const match of plain.matchAll(/^\s*([✓✔❯×✗])[^\n]*?\s([^\s|]+\.stories\.[jt]sx?)\s+\((\d+) tests?([^)]*)\)/gm)) {
    stories.set(normalizedFile(checkout, workspace, match[2]!), match[1] === '✓' || match[1] === '✔'
      ? Number(match[3]) > 0 && !/skipped/.test(match[4]!) ? 'passed' : 'missing' : 'failed');
  }
  for (const file of batch.files) {
    const found = tests.filter(test => test.file.replace(/^\.\//, '') === file);
    outcomes[file] = file.includes('.stories.') ? stories.get(file) ?? 'missing'
      : found.some(test => test.name === UNEXECUTED_FILE_TEST) ? 'missing'
      : found.some(test => test.failed) ? 'failed'
      : found.some(test => !test.skipped) ? 'passed' : 'missing';
  }
  return outcomes;
}

export function regressionBatchCommand(batch: Batch, report: string, storyXmlPath: string): string[] {
  if (batch.tier === 'jena:check') return ['task', 'jena:check'];
  const standaloneStories = batch.files.every(file => file.includes('.stories.'));
  const args = standaloneStories ? [...batch.files, '--reporter=junit', `--outputFile=${storyXmlPath}`]
    : ['--tier', batch.tier, ...batch.files.filter(file => !file.includes('.stories.')).flatMap(file => ['--file', file]),
      ...(batch.tier === 'e2e' && batch.files.some(file => file.includes('.stories.')) ? ['--storybook'] : [])];
  return ['bun', join(import.meta.dir, 'goalctl.ts'), 'test', ...(browserTier(batch.tier) ? ['--heavy'] : []),
    '--result-file', report, ...args];
}

export function regressionBatchEnvironment(env: NodeJS.ProcessEnv, shards: number, slotLimit: number): NodeJS.ProcessEnv {
  return { ...env, REZICS_QA_SHARDS: String(shards), GOAL_QA_SLOTS: String(slotLimit) };
}

async function runBatch(checkout: string, batch: Batch, directory: string, shards: number, slotLimit: number): Promise<Execution> {
  mkdirSync(directory, { recursive: true });
  const report = join(directory, 'slot.json');
  const storyXmlPath = join(directory, 'storybook.xml');
  const started = Date.now();
  const code = await command(checkout, regressionBatchCommand(batch, report, storyXmlPath), join(directory, 'runner.log'),
    batch.tier === 'jena:check' ? 75_000 : undefined, regressionBatchEnvironment(process.env, shards, slotLimit));
  const metadata = existsSync(report) ? json<Execution>(report) : { queueMs: 0, testMs: Date.now() - started, totalMs: Date.now() - started, artifactPaths: [] };
  const tests: TestResult[] = [];
  let evidence = readFileSync(join(directory, 'runner.log'), 'utf8');
  let storyLog = '';
  const isolated: { file: string; status: string }[] = [];
  for (const path of metadata.artifactPaths) {
    const xml = join(path, `${batch.tier.replaceAll('/', '-')}.xml`);
    if (existsSync(xml)) tests.push(...parseJUnit(readFileSync(xml, 'utf8'), batch.tier as Tier));
    const acceptance = join(path, 'acceptance.json');
    if (existsSync(acceptance)) isolated.push(...json<{ isolation?: typeof isolated }>(acceptance).isolation ?? []);
    const logDir = join(path, 'logs');
    for (const name of existsSync(logDir) ? readdirSync(logDir) : []) {
      const log = readFileSync(join(logDir, name), 'utf8');
      evidence += `\n${log}`;
      if (name === 'e2e-storybook.log') storyLog += log;
    }
  }
  const kernel = spawnSync('journalctl', ['-k', '--since', new Date(started).toISOString(), '--no-pager', '-q'], { encoding: 'utf8', timeout: 5000 });
  if (kernel.status === 0) evidence += `\n${kernel.stdout}`;
  const storyXml = existsSync(storyXmlPath) ? readFileSync(storyXmlPath, 'utf8') : '';
  const outcomes = executionOutcomes(checkout, batch, tests, storyXml, storyLog, code);
  for (const entry of isolated.filter(entry => entry.status === 'order-dependent')) outcomes[entry.file] = 'failed';
  return { ...metadata, code, outcomes, evidence,
    classification: isolated.some(entry => entry.status === 'infrastructure-dependent') ? 'infrastructure' : code ? classify(evidence, code) : undefined,
    artifactPaths: [directory, ...metadata.artifactPaths], failingTests: tests.filter(test => test.failed && test.name !== UNEXECUTED_FILE_TEST)
      .map(test => `${test.file}: ${test.name}`) };
}

export function inboxEntries(stateDir: string, goal: string, ack?: number): (InboxEntry & { number: number; acknowledged: boolean })[] {
  if (!validId(goal)) throw new Error('Invalid inbox Goal');
  const path = join(stateDir, 'inbox', `${goal}.jsonl`);
  const entries = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as InboxEntry) : [];
  const ackPath = join(stateDir, 'inbox', `${goal}.ack.json`);
  const acknowledged = new Set(existsSync(ackPath) ? json<number[]>(ackPath) : []);
  if (ack !== undefined) {
    if (!Number.isSafeInteger(ack) || ack < 1 || ack > entries.length) throw new Error('Ack must name an existing inbox line');
    acknowledged.add(ack);
    atomic(ackPath, [...acknowledged].sort((a, b) => a - b));
  }
  return entries.map((entry, index) => ({ ...entry, number: index + 1, acknowledged: acknowledged.has(index + 1) }));
}

/** Called under the ledger lock. A resumed diagnosis cannot append the same routed failure twice. */
export function appendInbox(stateDir: string, entry: InboxEntry): void {
  if (entry.classification === 'infrastructure' && !entry.runEvent) return;
  if (inboxEntries(stateDir, entry.goal).some(prior => prior.runId === entry.runId && (entry.runEvent
    ? prior.runEvent?.batchId === entry.runEvent.batchId
    : !prior.runEvent && prior.failingTests.join('\0') === entry.failingTests.join('\0')))) return;
  mkdirSync(join(stateDir, 'inbox'), { recursive: true });
  appendFileSync(join(stateDir, 'inbox', `${entry.goal}.jsonl`), `${JSON.stringify(entry)}\n`);
}

/** Only verified, non-void file passes establish a base; partial runs can still prove an individual file. */
export function lastPassingCommit(repo: string, stateDir: string, file: string, pinned: string): string | undefined {
  const directory = join(stateDir, 'regress');
  const candidates: string[] = [];
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const path = join(directory, name, 'manifest.json');
    if (!existsSync(path)) continue;
    const manifest = json<Manifest>(path);
    if (manifest.preflight?.ok && manifest.atCommit !== pinned && ancestor(repo, manifest.atCommit, pinned)
      && manifest.files.some(entry => entry.file === file && entry.outcome === 'passed')) candidates.push(manifest.atCommit);
  }
  return candidates.reduce<string | undefined>((latest, candidate) => !latest || ancestor(repo, latest, candidate) ? candidate : latest, undefined);
}

export async function runRegression(options: RegressionOptions): Promise<Manifest> {
  const { repo, stateDir } = options;
  const configuredSlots = options.slots ?? Number(process.env.GOAL_QA_SLOTS ?? 3);
  if (!Number.isSafeInteger(configuredSlots) || configuredSlots < 1) throw new Error('GOAL_QA_SLOTS must be a positive integer');
  const slotLimit = Math.min(configuredSlots, 2);
  const runner = options.runner ?? runBatch;
  const prepare = options.prepare ?? prepareCheckout;
  const runId = options.resume ?? options.runId ?? newRunId();
  if (!validId(runId)) throw new Error('Invalid regression run ID');
  const directory = diskDirectory(join(stateDir, 'regress', runId), 'report directory');
  const lock = join(directory, 'lock');
  if (existsSync(lock)) {
    const pid = existsSync(join(lock, 'pid')) ? Number(readFileSync(join(lock, 'pid'), 'utf8')) : 0;
    let alive = !pid && Date.now() - statSync(lock).mtimeMs < 10_000;
    try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch { /* interrupted owner */ }
    if (alive) throw new Error(`Regression ${runId} is already running`);
    rmSync(lock, { recursive: true, force: true });
  }
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const path = join(directory, 'manifest.json');
    const pinned = options.resume ? json<Manifest>(path).atCommit : git(repo, ['rev-parse', '--verify', `${options.at ?? 'main'}^{commit}`]);
    if (options.resume && options.at && git(repo, ['rev-parse', `${options.at}^{commit}`]) !== pinned) throw new Error('Resume revision differs from the pinned commit');
    const worktrees = regressionCheckoutRoot(repo, options.checkoutRoot);
    const legacyRoot = resolve(options.legacyRoot ?? join(repo, '.temp/regress'));
    const physicalLegacyRoot = physicalPath(legacyRoot);
    const legacyOwned = within(realpathSync(repo), physicalLegacyRoot) || within(worktrees, physicalLegacyRoot);
    const treeMapPath = join(directory, 'checkouts.json');
    const treeMap = existsSync(treeMapPath) ? json<Record<string, string>>(treeMapPath) : {};
    const nameLength = checkoutNameLength(worktrees);
    const prepared = new Map<string, Manifest['preflight']>();
    const preparedCheckouts = new Map<string, Manifest['preflight']>();
    const checkoutAt = async (commit: string, probe?: string, install = true) => {
      const key = `${commit}:${probe ?? 'pinned'}`;
      let checkout: string | undefined = treeMap[key];
      if (checkout) {
        const candidate = resolve(checkout);
        const physical = physicalPath(candidate);
        const legacyCandidate = legacyOwned && (within(legacyRoot, candidate) || within(physicalLegacyRoot, candidate));
        if ((!within(worktrees, candidate) && !legacyCandidate)
          || (!within(worktrees, physical) && !(legacyOwned && within(physicalLegacyRoot, physical)))) {
          throw new Error('Regression checkout map points outside its cache or legacy repository directory');
        }
        let existing = candidate;
        while (!existsSync(existing)) existing = dirname(existing);
        if (isRamBackedFileSystem(fileSystemType(realpathSync(existing)))
          || postgresSocketByteLength(physical) > POSTGRES_SOCKET_LIMIT) {
          checkout = undefined;
        } else {
          checkout = physical; treeMap[key] = checkout;
        }
      }
      if (!checkout) {
        const space = 16n ** BigInt(nameLength);
        const seed = BigInt(`0x${createHash('sha256').update(`${runId}:${key}`).digest('hex')}`);
        for (let offset = 0n; offset < space; offset++) {
          const candidate = join(worktrees, ((seed + offset) % space).toString(16).padStart(nameLength, '0'));
          if (existsSync(candidate)) continue;
          diskDirectory(worktrees, 'checkout root');
          git(repo, ['worktree', 'add', '--force', '--detach', candidate, commit]);
          checkout = candidate; treeMap[key] = checkout; atomic(treeMapPath, treeMap);
          break;
        }
        if (!checkout) throw new Error('No short regression worktree path is free; remove completed regression checkouts');
      }
      if (!existsSync(checkout)) {
        diskDirectory(dirname(checkout), 'checkout root');
        git(repo, ['worktree', 'add', '--force', '--detach', checkout, commit]);
      }
      diskDirectory(checkout, 'pinned checkout');
      if (git(checkout, ['rev-parse', 'HEAD']) !== commit || git(checkout, ['status', '--porcelain'])) {
        throw new Error(`Pinned checkout changed: ${checkout}`);
      }
      if (install && (probe || !prepared.has(commit))) {
        const preflight = { commit, ...await prepare(checkout) };
        prepared.set(commit, preflight); preparedCheckouts.set(checkout, preflight);
      }
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      return checkout;
    };
    const checkout = await checkoutAt(pinned, undefined, false);
    let manifest: Manifest;
    if (options.resume) {
      manifest = json<Manifest>(path);
      for (const batch of manifest.batches) if (batch.state === 'running') batch.state = 'pending';
      // Older runs nested the full run ID and SHA, which prevented owner gates from binding PostgreSQL sockets.
      // Preserve verified passes and void only batches that actually failed to start pg_ctl under that long path.
      if (manifest.checkout !== checkout && postgresSocketByteLength(manifest.checkout) > POSTGRES_SOCKET_LIMIT) {
        for (const batch of manifest.batches) {
          const result = batch.attempts.at(-1);
          if (batch.state !== 'done' || !result?.code || !/pg_ctl[\s\S]*pg-sock/.test(result.evidence ?? '')) continue;
          result.classification = 'infrastructure'; batch.state = 'pending';
          for (const file of manifest.files.filter(file => file.tier === batch.tier && batch.files.includes(file.file))) file.outcome = 'void';
          manifest.diagnoses = manifest.diagnoses.filter(diagnosis => !batch.files.includes(diagnosis.file));
        }
      }
      manifest.checkout = checkout;
      // Validate the persisted plan against the same pinned registry; a deleted row cannot turn an incomplete run green.
      const expected = await (options.registry ?? regressionRegistry)(checkout);
      const identities = (files: ExpectedFile[]) => files.map(file => `${file.tier}:${file.file}`).sort().join('\n');
      if (identities(expected) !== identities(manifest.files)) throw new Error('Incomplete or changed regression manifest');
      const exclusions = new Map(expected.filter(file => file.outcome === 'excluded').map(file => [`${file.tier}:${file.file}`, file.reason]));
      if (manifest.selection === 'routine') for (const file of expected) {
        if (file.outcome !== 'excluded' && tiers.includes(file.tier as RegressionTier) && browserTier(file.tier as RegressionTier)) {
          exclusions.set(`${file.tier}:${file.file}`, routineBrowserReason);
        }
      }
      if (manifest.files.some(file => (file.outcome === 'excluded') !== exclusions.has(`${file.tier}:${file.file}`)
        || (file.outcome === 'excluded' && file.reason !== exclusions.get(`${file.tier}:${file.file}`)))) {
        throw new Error('Incomplete or changed regression exclusions');
      }
      const planned = manifest.batches.flatMap(batch => batch.files.map(file => `${batch.tier}:${file}`)).sort();
      const required = manifest.files.filter(file => file.outcome !== 'excluded' && file.outcome !== 'deferred')
        .map(file => `${file.tier}:${file.file}`).sort();
      // Older runs used fifteen-file integration batches; resume preserves their original plan.
      if (planned.join('\n') !== required.join('\n') || new Set(planned).size !== planned.length
        || manifest.batches.some(batch => !batch.files.length || (batch.tier === 'integration' && batch.files.length > 15))) {
        throw new Error('Incomplete regression batch plan');
      }
    } else {
      if (existsSync(path)) throw new Error(`Regression ${runId} already exists; use --resume`);
      const files = await (options.registry ?? regressionRegistry)(checkout);
      if (new Set(files.map(file => `${file.tier}:${file.file}`)).size !== files.length) throw new Error('Duplicate regression manifest files');
      const batches = batchesFor(files, options);
      const shards = options.shards ?? Number(process.env.REZICS_QA_SHARDS ?? 1);
      if (!Number.isSafeInteger(shards) || shards < 1) throw new Error('REZICS_QA_SHARDS must be a positive integer');
      manifest = { version: 1, runId, atCommit: pinned, checkout, startedAt: new Date().toISOString(), shards,
        selection: options.only ? 'explicit' : 'routine',
        partial: files.some(file => file.outcome === 'deferred'), status: 'running', files, batches,
        preflight: { commit: pinned, ok: false, artifactPaths: [], reason: 'Pinned preflight pending' }, diagnoses: [] };
    }
    const save = () => atomic(path, manifest);
    manifest.probeCounts ??= {};
    save();
    // Persist the SHA and selection before installation, so a stop during preparation can resume that exact revision.
    await checkoutAt(pinned);
    manifest.preflight = prepared.get(pinned)!; save();
    const execute = async (commit: string, batch: Batch, label: string, probeTree?: string): Promise<Execution> => {
      const tree = probeTree ?? await checkoutAt(commit);
      // Reports may use GOAL_REGRESS_STATE_DIR, but admission always observes goalctl's shared host lock.
      if (browserTier(batch.tier) && options.waitForTurn) await options.waitForTurn(undefined, () => interrupted);
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      const result = await runner(tree, batch, join(directory, label), manifest.shards, slotLimit);
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      result.classification ??= result.code ? classify(result.evidence ?? '', result.code) : undefined;
      if (result.code && result.classification) {
        // Keep the runtime cause when checkpoints discard the unabridged log evidence.
        result.cause ??= (result.evidence ?? '').replace(/^\s*\d+\s*\|.*$/gm, '').split('\n').reverse()
          .find(line => line.trim() && classify(line) === result.classification && result.classification !== 'deterministic')?.trim()
          .slice(0, 500) ?? `Batch runner ended with ${result.classification} (exit ${result.code})`;
      }
      if (git(tree, ['rev-parse', 'HEAD']) !== commit || git(tree, ['status', '--porcelain'])) throw new Error(`Source changed during regression: ${tree}`);
      return result;
    };
    const runInitialBatch = async (batch: Batch, tree?: string): Promise<void> => {
      if (batch.state === 'done') return;
      batch.state = 'running'; save();
      // A dead engine gets one fresh queue entry, then leaves a resumable pending batch rather than a busy loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await execute(pinned, batch, `${batch.id}/attempt-${batch.attempts.length + 1}`, tree);
        // Logs already live at artifactPaths; keep checkpoints bounded instead of copying every stack log into them.
        batch.attempts.push({ ...result, evidence: undefined });
        const voided = result.classification === 'infrastructure';
        // Verified recovery replaces unavailable file diagnoses; the historical inbox event remains.
        if (!voided) manifest.diagnoses = manifest.diagnoses.filter(diagnosis => !(diagnosis.status === 'unavailable'
          && batch.files.includes(diagnosis.file) && ['passed', 'failed'].includes(result.outcomes[diagnosis.file] ?? 'missing')));
        for (const file of manifest.files.filter(file => file.tier === batch.tier && batch.files.includes(file.file))) {
          file.outcome = voided ? 'void' : result.outcomes[file.file] ?? 'missing';
        }
        batch.state = voided ? 'pending' : 'done'; save();
        if (!voided) break;
      }
    };
    // Unit batches fit the harness's three-minute budget and run serially; stack and owner batches use measured memory admission.
    for (const batch of manifest.batches.filter(batch => batch.tier === 'unit' || batch.tier === 'model' || batch.tier === 'jena:check')) {
      await runInitialBatch(batch);
    }
    const pending = manifest.batches.filter(batch => batch.state !== 'done' && !browserTier(batch.tier)
      && batch.tier !== 'unit' && batch.tier !== 'model' && batch.tier !== 'jena:check');
    let next = 0;
    let failure: unknown;
    const workers = Array.from({ length: Math.min(slotLimit, pending.length) }, async (_, index) => {
      let tree: string | undefined;
      try {
        // Each lane has its own sockets and artifact root, reused only after its previous batch finishes.
        tree = await checkoutAt(pinned, `lane-${index}`);
        if (!preparedCheckouts.get(tree)?.ok) {
          manifest.preflight = preparedCheckouts.get(tree)!; save(); return;
        }
        while (!failure && next < pending.length) await runInitialBatch(pending[next++]!, tree);
      } catch (error) { failure ??= error; }
    });
    // Keep the manifest lock until all admitted children settle, even when another lane fails.
    await Promise.all(workers);
    if (failure) throw failure;
    for (const batch of manifest.batches.filter(batch => browserTier(batch.tier))) await runInitialBatch(batch);
    const eventPath = join(stateDir, 'merges.jsonl');
    const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as MergeEvent) : [];
    const route = options.route ?? (async entry => appendInbox(stateDir, entry));
    const routeBatchFailure = async (batch: Batch, result: Execution, fallback?: string) => {
      const cause = result.cause ?? fallback ?? `Batch runner ended with ${result.classification ?? 'deterministic'} (exit ${result.code})`;
      const diagnosis: Diagnosis = { file: `batch:${batch.id}`, status: 'unavailable', classification: result.classification ?? 'deterministic',
        after: pinned, probes: [], artifactPaths: result.artifactPaths, reason: `${batch.id}: ${batch.files.length} files; ${cause}` };
      if (manifest.diagnoses.some(item => item.file === diagnosis.file)) return;
      await route({ runId, atCommit: pinned, failingTests: [diagnosis.file], after: pinned, goal: 'program', taskIds: [],
        status: diagnosis.status, classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths,
        runEvent: { batchId: batch.id, tier: batch.tier, fileCount: batch.files.length, cause } });
      manifest.diagnoses.push(diagnosis); save();
    };
    const routeFileFailure = async (file: string, initial: Execution, diagnosis: Diagnosis) => {
      diagnosis.artifactPaths = [...new Set(diagnosis.artifactPaths)];
      const failingTests = initial.failingTests?.filter(test => test.startsWith(`${file}:`) && !test.endsWith(`: ${UNEXECUTED_FILE_TEST}`)) ?? [];
      // Route before checkpointing; append is idempotent if interruption falls between the writes.
      await route({ runId, atCommit: pinned, failingTests: failingTests.length ? failingTests : [file], before: diagnosis.before,
      after: diagnosis.after, goal: diagnosis.goal ?? 'program', taskIds: diagnosis.taskIds ?? [], status: diagnosis.status,
      classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths });
      manifest.diagnoses.push(diagnosis); save();
    };
    const retainUnavailableAssertions = async (batch: Batch, initial: Execution, artifactPaths: string[], reason: string) => {
      for (const file of assertionFiles(batch, initial)) {
        if (manifest.diagnoses.some(item => item.file === file)) continue;
        await routeFileFailure(file, initial, { file, status: 'unavailable',
          classification: initial.classification === 'infrastructure' ? 'deterministic' : initial.classification ?? 'deterministic',
          after: pinned, probes: [], artifactPaths: [...initial.artifactPaths, ...artifactPaths], reason });
      }
    };
    for (const batch of manifest.batches.filter(batch => batch.attempts.length > 0)) {
      const initial = batch.attempts.at(-1)!;
      let failing = batch.files.filter(file => initial.outcomes[file] !== 'passed');
      if (batchRunFailure(batch, initial)) {
        await routeBatchFailure(batch, initial);
      }
      if (manifest.diagnoses.some(item => item.file === `batch:${batch.id}`)) {
        // Missing execution is a batch problem. Probe only files with actual assertion evidence.
        failing = assertionFiles(batch, initial);
      }
      if (batch.state !== 'done') {
        // A later engine failure cannot erase assertions completed in an earlier attempt.
        const evidence = { ...initial, outcomes: { ...initial.outcomes },
          failingTests: [...new Set(batch.attempts.flatMap(result => result.failingTests ?? []))],
          artifactPaths: batch.attempts.flatMap(result => result.artifactPaths) };
        for (const result of batch.attempts) for (const file of assertionFiles(batch, result)) evidence.outcomes[file] = 'failed';
        await retainUnavailableAssertions(batch, evidence, [], 'Batch execution unavailable');
        continue;
      }
      if (!failing.length && initial.code) {
        await routeBatchFailure(batch, initial, 'Batch runner failed despite passing file evidence');
      }
      let repeatBatch: Execution | undefined;
      for (const file of failing) {
        if (manifest.diagnoses.some(item => item.file === file)) continue;
        const diagnosis: Diagnosis = { file, status: 'inconclusive', classification: initial.classification ?? 'deterministic',
          after: pinned, probes: [], artifactPaths: [...initial.artifactPaths] };
        repeatBatch ??= await execute(pinned, batch, `${batch.id}/confirm`);
        const repeat = repeatBatch;
        diagnosis.artifactPaths.push(...repeat.artifactPaths);
        if (batchRunFailure(batch, repeat)) {
          await routeBatchFailure(batch, repeat);
          // Retain every initial assertion before infrastructure recovery leaves this batch pending.
          await retainUnavailableAssertions(batch, initial, repeat.artifactPaths, 'Batch confirmation unavailable');
          if (repeat.classification === 'infrastructure') {
            batch.state = 'pending';
            for (const expected of manifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
            save(); break;
          }
          break;
        }
        const alone: Batch = { ...batch, files: [file], tier: file.includes('.stories.') && batch.tier === 'e2e' ? 'e2e' : batch.tier };
        const isolated = await execute(pinned, alone, `${batch.id}/alone-${batch.files.indexOf(file)}`);
        diagnosis.artifactPaths.push(...isolated.artifactPaths);
        if ([repeat, isolated].some(result => result.classification === 'infrastructure')) {
          await routeBatchFailure(batch, [repeat, isolated].find(result => result.classification === 'infrastructure')!);
          await retainUnavailableAssertions(batch, initial, [...repeat.artifactPaths, ...isolated.artifactPaths], 'Isolated execution unavailable');
          batch.state = 'pending';
          for (const expected of manifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
          save(); break;
        }
        if (initial.outcomes[file] === 'missing' || repeat.outcomes[file] === 'missing' || isolated.outcomes[file] === 'missing') {
          diagnosis.status = 'unavailable'; diagnosis.reason = 'Missing file execution evidence';
        } else if (repeat.outcomes[file] === 'passed') {
          diagnosis.classification = 'flaky'; diagnosis.reason = 'Same SHA and batch changed result';
        } else if (isolated.outcomes[file] === 'passed') {
          diagnosis.classification = 'order-dependent'; diagnosis.reason = 'Confirmed batch failure passes alone on a fresh project';
        } else if ([initial, repeat, isolated].some(result => result.classification === 'resource' || result.classification === 'deadline')) {
          diagnosis.classification = [initial, repeat, isolated].find(result => result.classification === 'resource' || result.classification === 'deadline')!.classification!;
        } else {
          const takeProbe = () => {
            const count = manifest.probeCounts![file] ?? 0;
            if (count >= 8) return undefined;
            manifest.probeCounts![file] = count + 1; save();
            return count + 1;
          };
          await bisectFailure(repo, stateDir, pinned, file, alone, events, diagnosis, checkoutAt, prepared, execute, takeProbe);
        }
        if (diagnosis.classification === 'infrastructure') {
          await routeBatchFailure(batch, { ...initial, classification: 'infrastructure', cause: diagnosis.reason,
            artifactPaths: diagnosis.artifactPaths });
          await retainUnavailableAssertions(batch, initial, diagnosis.artifactPaths, 'Regression probe unavailable');
          batch.state = 'pending';
          for (const expected of manifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
          save(); break;
        }
        await routeFileFailure(file, initial, diagnosis);
      }
    }
    if (!manifest.preflight.ok && !manifest.diagnoses.some(item => item.file === 'preflight')) {
      const diagnosis: Diagnosis = { file: 'preflight', status: 'unavailable', classification: 'deterministic', after: pinned,
        probes: [], artifactPaths: manifest.preflight.artifactPaths, reason: manifest.preflight.reason };
      await route({ runId, atCommit: pinned, failingTests: [manifest.preflight.reason ?? 'Pinned preflight failed'], after: pinned,
        goal: 'program', taskIds: [], status: diagnosis.status, classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths });
      manifest.diagnoses.push(diagnosis);
    }
    const complete = !manifest.partial && manifest.batches.every(batch => batch.state === 'done' && batch.attempts.length > 0)
      && manifest.files.every(file => file.outcome === 'passed' || file.outcome === 'excluded');
    manifest.status = complete && manifest.preflight.ok && !manifest.batches.some(batch => batch.attempts.at(-1)?.code)
      ? 'passed' : manifest.files.some(file => file.outcome === 'failed') || !manifest.preflight.ok ? 'failed' : 'incomplete';
    manifest.finishedAt = new Date().toISOString(); save();
    writeFileSync(join(directory, 'summary.md'), [`# Regression ${runId}`, '', `Commit: ${pinned}`,
      `Result: ${manifest.status}; complete execution: ${complete}; shards: ${manifest.shards}`,
      `Preflight: ${manifest.preflight.ok ? 'passed' : manifest.preflight.reason}`, '',
      ...manifest.batches.map(batch => `${batch.id}: ${batch.state}; ${batch.files.length} files; `
        + batch.attempts.map(result => `queue ${result.queueMs}ms, test ${result.testMs}ms, total ${result.totalMs}ms (${result.classification ?? 'passed'})`).join('; ')), '',
      ...manifest.diagnoses.map(item => `${item.file}: ${item.status}, ${item.classification}; ${item.before ?? '?'}..${item.after}; `
        + `${item.goal ?? 'program'} ${item.taskIds?.join(', ') ?? ''}; ${item.reason ?? ''}`), '',
    ].join('\n'));
    return manifest;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    rmSync(lock, { recursive: true, force: true });
  }
}

async function bisectFailure(repo: string, stateDir: string, pinned: string, file: string, batch: Batch, events: MergeEvent[],
  diagnosis: Diagnosis, checkoutAt: (commit: string, probe?: string) => Promise<string>, prepared: Map<string, Manifest['preflight']>,
  execute: (commit: string, batch: Batch, label: string, probeTree?: string) => Promise<Execution>,
  takeProbe: () => number | undefined): Promise<void> {
  const passing = lastPassingCommit(repo, stateDir, file, pinned);
  const base = passing ?? git(repo, ['rev-list', '--first-parent', '--max-parents=0', pinned]).split('\n')[0]!;
  const commits = [base, ...git(repo, ['rev-list', '--first-parent', '--reverse', `${base}..${pinned}`]).split('\n').filter(Boolean)];
  const positions = new Map(commits.map((commit, index) => [commit, index]));
  const relevant = events.filter(event => event.before !== event.after && positions.has(event.before) && positions.has(event.after));
  const boundaries = [...new Set([base, ...relevant.flatMap(event => [event.before, event.after]), pinned])]
    .sort((a, b) => positions.get(a)! - positions.get(b)!);
  const seen = new Map<string, 'passed' | 'failed'>();
  const probe = async (commit: string): Promise<'passed' | 'failed' | undefined> => {
    const number = takeProbe();
    if (number === undefined) { diagnosis.reason = 'Eight-probe budget exhausted'; return; }
    const label = `${createHash('sha256').update(file).digest('hex')}-${number}`;
    const checkout = await checkoutAt(commit, label);
    let outcome: string = 'unavailable';
    if (existsSync(join(checkout, file)) && prepared.get(commit)?.ok) {
      const result = await execute(commit, batch, `probes/${label}`, checkout);
      diagnosis.artifactPaths.push(...result.artifactPaths);
      if (result.classification === 'infrastructure') { diagnosis.classification = 'infrastructure'; outcome = 'void'; }
      else if (result.classification === 'resource' || result.classification === 'deadline') { diagnosis.classification = result.classification; outcome = 'unavailable'; }
      else outcome = result.outcomes[file] === 'passed' && result.code === 0 ? 'passed' : result.outcomes[file] === 'failed' ? 'failed' : 'unavailable';
    } else diagnosis.artifactPaths.push(...prepared.get(commit)?.artifactPaths ?? []);
    diagnosis.probes.push({ commit, outcome });
    if (outcome !== 'passed' && outcome !== 'failed') {
      diagnosis.status = outcome === 'void' ? 'inconclusive' : 'unavailable'; diagnosis.reason = 'Probe file or pinned build unavailable'; return;
    }
    if ((seen.has(commit) && seen.get(commit) !== outcome)
      || [...seen].some(([other, result]) => result !== outcome && (result === 'failed'
        ? positions.get(other)! < positions.get(commit)! : positions.get(other)! > positions.get(commit)!))) {
      diagnosis.status = 'inconclusive'; diagnosis.reason = 'Conflicting or non-monotonic probes'; return;
    }
    seen.set(commit, outcome);
    return outcome;
  };
  diagnosis.before = base;
  const baseResult = await probe(base);
  if (!baseResult) return;
  if (baseResult === 'failed') { diagnosis.status = passing ? 'inconclusive' : 'inherited'; diagnosis.reason = passing ? 'Previously passing base now fails' : 'Failure present at the base'; return; }
  let low = 0; let high = boundaries.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const result = await probe(boundaries[middle]!);
    if (!result) return;
    if (result === 'passed') low = middle; else high = middle;
    diagnosis.before = boundaries[low]; diagnosis.after = boundaries[high]!;
  }
  diagnosis.before = boundaries[low]; diagnosis.after = boundaries[high]!;
  // Independently verify both ends. A previous pass and a binary-search assumption are insufficient attribution.
  if (await probe(diagnosis.before!) !== 'passed' || await probe(diagnosis.after) !== 'failed') return;
  const event = relevant.find(event => event.before === diagnosis.before && event.after === diagnosis.after);
  if (event) { diagnosis.status = 'attributed'; diagnosis.goal = event.goal; diagnosis.taskIds = event.taskIds; }
  else diagnosis.reason = 'Suspect range contains unrecorded manager or maintainer commits';
}
