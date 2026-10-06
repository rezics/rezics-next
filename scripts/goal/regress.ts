import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJUnit, UNEXECUTED_FILE_TEST, type TestResult } from '../qa/acceptance.ts';
import { newRunId, type Tier } from '../qa/core.ts';

export type RegressionTier = 'unit' | 'model' | 'integration' | 'fault/recovery' | 'e2e' | 'accounts:storybook';
export type Classification = 'infrastructure' | 'resource' | 'deadline' | 'order-dependent' | 'flaky' | 'deterministic';
type Outcome = 'pending' | 'passed' | 'failed' | 'missing' | 'void' | 'excluded' | 'deferred';
export interface MergeEvent { before: string; after: string; goal: string; taskIds: string[]; at: string }
export interface ExpectedFile { file: string; tier: RegressionTier | 'live' | 'load' | 'legacy'; outcome: Outcome; reason?: string }
export interface Execution {
  code: number; outcomes: Record<string, 'passed' | 'failed' | 'missing'>; artifactPaths: string[];
  queueMs: number; testMs: number; totalMs: number; evidence?: string; classification?: Classification;
  failingTests?: string[];
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
}
export interface Manifest {
  version: 1; runId: string; atCommit: string; checkout: string; startedAt: string; finishedAt?: string;
  shards: number; partial: boolean; status: 'running' | 'passed' | 'failed' | 'incomplete';
  files: ExpectedFile[]; batches: Batch[]; preflight: { commit: string; ok: boolean; artifactPaths: string[]; reason?: string };
  diagnoses: Diagnosis[];
  /** Reserved before starting a probe, including interrupted probes, so resume cannot reset the eight-probe bound. */
  probeCounts?: Record<string, number>;
}
export interface RegressionOptions {
  repo: string; stateDir: string; at?: string; resume?: string; only?: RegressionTier[]; integrationBatches?: number;
  shards?: number; runId?: string;
  registry?: (checkout: string) => Promise<ExpectedFile[]>;
  prepare?: (checkout: string) => Promise<{ ok: boolean; artifactPaths: string[]; reason?: string }>;
  runner?: (checkout: string, batch: Batch, directory: string, shards: number) => Promise<Execution>;
  route?: (entry: InboxEntry) => Promise<void>;
}
const tiers: RegressionTier[] = ['unit', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook'];
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
  for (const tier of ['unit', 'model', 'integration', 'fault/recovery', 'load'] as const) {
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
  return files;
}

function batchesFor(files: ExpectedFile[], options: RegressionOptions): Batch[] {
  const batches: Batch[] = [];
  for (const tier of tiers) {
    const expected = files.filter(file => file.tier === tier && file.outcome !== 'excluded');
    if (!expected.length) throw new Error(`Zero-match regression tier: ${tier}`);
    const selected = options.only?.includes(tier) ?? true;
    // An integration batch cap adds that many batches even when --only selects cheap tiers.
    const run = selected || (tier === 'integration' && options.integrationBatches !== undefined);
    const size = tier === 'integration' ? 15 : expected.length;
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
  if (/cannot connect to the docker daemon|failed to connect to (?:the )?docker (?:daemon|API)|docker.*ECONNREFUSED|ECONNREFUSED.*(?:docker|237[56])|(?:docker\.sock|dockerDesktopLinuxEngine)[^\n]*(?:connection refused|no such file|cannot find)|is the docker daemon running|all predefined address pools|no available.*address pool|could not find an available, non-overlapping.*address pool|network pool exhausted|oom-kill|Out of memory: Killed process/i.test(evidence)) return 'infrastructure';
  if (code === 137 || /heap out of memory|SIGKILL|resource exhausted|ENOMEM/.test(evidence)) return 'resource';
  if (/exceeded[^\n]*(?:budget|deadline)|timed out|ETIMEDOUT|deadline exceeded/i.test(evidence)) return 'deadline';
  return 'deterministic';
}

async function command(checkout: string, args: string[], logPath: string, timeoutMs = 7 * 3_600_000): Promise<number> {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w', 0o600);
  try {
    const child = spawn(args[0]!, args.slice(1), { cwd: checkout, detached: true, stdio: ['ignore', log, log], env: process.env });
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
  const directory = join(checkout, '.temp/regress-preflight');
  const installLog = join(directory, 'install.log');
  const generatedLog = join(directory, 'generated.log');
  const started = Date.now();
  const installed = await command(checkout, ['task', 'install'], installLog, 600_000) === 0;
  const checked = installed && await command(checkout, ['task', 'gen:check'], generatedLog, Math.max(1, 600_000 - (Date.now() - started))) === 0;
  return { ok: installed && checked, artifactPaths: [installLog, ...(installed ? [generatedLog] : [])],
    ...(!checked ? { reason: installed ? 'Generated artifacts are stale or the pinned build is unavailable' : 'Pinned dependency installation failed' } : {}) };
}

function normalizedFile(checkout: string, workspace: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(checkout, workspace, file.replace(/^\.\//, ''));
  return relative(checkout, absolute).replaceAll('\\', '/');
}

/** Missing/skipped files and zero-test suites are evidence gaps, even when the process exits successfully. */
export function executionOutcomes(checkout: string, batch: Batch, tests: TestResult[], storyXml = '', storyLog = ''): Execution['outcomes'] {
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

async function runBatch(checkout: string, batch: Batch, directory: string, shards: number): Promise<Execution> {
  mkdirSync(directory, { recursive: true });
  const report = join(directory, 'slot.json');
  const storyXmlPath = join(directory, 'storybook.xml');
  const standaloneStories = batch.files.every(file => file.includes('.stories.'));
  const args = standaloneStories ? [...batch.files, '--reporter=junit', `--outputFile=${storyXmlPath}`]
    : ['--tier', batch.tier, ...batch.files.filter(file => !file.includes('.stories.')).flatMap(file => ['--file', file])];
  const started = Date.now();
  const previousShards = process.env.REZICS_QA_SHARDS;
  process.env.REZICS_QA_SHARDS = String(shards);
  let code: number;
  try { code = await command(checkout, ['bun', join(import.meta.dir, 'goalctl.ts'), 'test', '--heavy', '--result-file', report, ...args], join(directory, 'runner.log')); }
  finally {
    if (previousShards === undefined) delete process.env.REZICS_QA_SHARDS;
    else process.env.REZICS_QA_SHARDS = previousShards;
  }
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
  const outcomes = executionOutcomes(checkout, batch, tests, storyXml, storyLog);
  for (const entry of isolated.filter(entry => entry.status === 'order-dependent')) outcomes[entry.file] = 'failed';
  return { ...metadata, code, outcomes, evidence,
    classification: isolated.some(entry => entry.status === 'infrastructure-dependent') ? 'infrastructure' : code ? classify(evidence, code) : undefined,
    artifactPaths: [directory, ...metadata.artifactPaths], failingTests: tests.filter(test => test.failed).map(test => `${test.file}: ${test.name}`) };
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
  if (entry.classification === 'infrastructure') return;
  if (inboxEntries(stateDir, entry.goal).some(prior => prior.runId === entry.runId && prior.failingTests.join('\0') === entry.failingTests.join('\0'))) return;
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
  const runner = options.runner ?? runBatch;
  const prepare = options.prepare ?? prepareCheckout;
  const runId = options.resume ?? options.runId ?? newRunId();
  if (!validId(runId)) throw new Error('Invalid regression run ID');
  const directory = join(stateDir, 'regress', runId);
  mkdirSync(directory, { recursive: true });
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
    const worktrees = join(repo, '.temp/regress', runId);
    const prepared = new Map<string, Manifest['preflight']>();
    const checkoutAt = async (commit: string, probe?: string, install = true) => {
      const checkout = probe ? join(worktrees, 'probes', probe, commit) : join(worktrees, commit);
      if (!existsSync(checkout)) git(repo, ['worktree', 'add', '--detach', checkout, commit]);
      if (git(checkout, ['rev-parse', 'HEAD']) !== commit || git(checkout, ['status', '--porcelain'])) {
        throw new Error(`Pinned checkout changed: ${checkout}`);
      }
      if (install && (probe || !prepared.has(commit))) prepared.set(commit, { commit, ...await prepare(checkout) });
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      return checkout;
    };
    const checkout = await checkoutAt(pinned, undefined, false);
    let manifest: Manifest;
    if (options.resume) {
      manifest = json<Manifest>(path);
      // Validate the persisted plan against the same pinned registry; a deleted row cannot turn an incomplete run green.
      const expected = await (options.registry ?? regressionRegistry)(checkout);
      const identities = (files: ExpectedFile[]) => files.map(file => `${file.tier}:${file.file}`).sort().join('\n');
      if (identities(expected) !== identities(manifest.files)) throw new Error('Incomplete or changed regression manifest');
      const planned = manifest.batches.flatMap(batch => batch.files.map(file => `${batch.tier}:${file}`)).sort();
      const required = manifest.files.filter(file => file.outcome !== 'excluded' && file.outcome !== 'deferred')
        .map(file => `${file.tier}:${file.file}`).sort();
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
      const result = await runner(tree, batch, join(directory, label), manifest.shards);
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      result.classification ??= result.code ? classify(result.evidence ?? '', result.code) : undefined;
      if (git(tree, ['rev-parse', 'HEAD']) !== commit || git(tree, ['status', '--porcelain'])) throw new Error(`Source changed during regression: ${tree}`);
      return result;
    };
    for (const batch of manifest.batches) {
      if (batch.state === 'done') continue;
      batch.state = 'running'; save();
      // A dead engine gets one fresh queue entry, then leaves a resumable pending batch rather than a busy loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await execute(pinned, batch, `${batch.id}/attempt-${batch.attempts.length + 1}`);
        // Logs already live at artifactPaths; keep checkpoints bounded instead of copying every stack log into them.
        batch.attempts.push({ ...result, evidence: undefined });
        const voided = result.classification === 'infrastructure';
        for (const file of manifest.files.filter(file => file.tier === batch.tier && batch.files.includes(file.file))) {
          file.outcome = voided ? 'void' : result.outcomes[file.file] ?? 'missing';
        }
        batch.state = voided ? 'pending' : 'done'; save();
        if (!voided) break;
      }
    }
    const eventPath = join(stateDir, 'merges.jsonl');
    const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as MergeEvent) : [];
    const route = options.route ?? (async entry => appendInbox(stateDir, entry));
    for (const batch of manifest.batches.filter(batch => batch.state === 'done')) {
      const initial = batch.attempts.at(-1)!;
      const failing = batch.files.filter(file => initial.outcomes[file] !== 'passed');
      if (!failing.length && initial.code) {
        const diagnosis: Diagnosis = { file: `batch:${batch.id}`, status: 'unavailable', classification: initial.classification ?? 'deterministic',
          after: pinned, probes: [], artifactPaths: initial.artifactPaths, reason: 'Batch runner failed despite passing file evidence' };
        if (!manifest.diagnoses.some(item => item.file === diagnosis.file)) {
          await route({ runId, atCommit: pinned, failingTests: [diagnosis.file], after: pinned, goal: 'program',
            taskIds: [], status: diagnosis.status, classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths });
          manifest.diagnoses.push(diagnosis); save();
        }
      }
      let repeatBatch: Execution | undefined;
      for (const file of failing) {
        if (manifest.diagnoses.some(item => item.file === file)) continue;
        const diagnosis: Diagnosis = { file, status: 'inconclusive', classification: initial.classification ?? 'deterministic',
          after: pinned, probes: [], artifactPaths: [...initial.artifactPaths] };
        repeatBatch ??= await execute(pinned, batch, `${batch.id}/confirm`);
        const repeat = repeatBatch;
        diagnosis.artifactPaths.push(...repeat.artifactPaths);
        const alone: Batch = { ...batch, files: [file], tier: file.includes('.stories.') && batch.tier === 'e2e' ? 'e2e' : batch.tier };
        const isolated = await execute(pinned, alone, `${batch.id}/alone-${batch.files.indexOf(file)}`);
        diagnosis.artifactPaths.push(...isolated.artifactPaths);
        if ([repeat, isolated].some(result => result.classification === 'infrastructure')) {
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
          batch.state = 'pending';
          for (const expected of manifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
          save(); break;
        }
        diagnosis.artifactPaths = [...new Set(diagnosis.artifactPaths)];
        // Route before checkpointing the diagnosis; append is idempotent if interruption falls between the two writes.
        await route({ runId, atCommit: pinned, failingTests: initial.failingTests?.filter(test => test.startsWith(`${file}:`)).length
          ? initial.failingTests.filter(test => test.startsWith(`${file}:`)) : [file], before: diagnosis.before,
        after: diagnosis.after, goal: diagnosis.goal ?? 'program', taskIds: diagnosis.taskIds ?? [], status: diagnosis.status,
        classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths });
        manifest.diagnoses.push(diagnosis); save();
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
