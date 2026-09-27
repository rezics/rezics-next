import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { acceptanceStatuses, parseJUnit, titleIds, type Case, type TestResult } from './acceptance.ts';
import { isolatedIntegrationFileList } from './isolated-integration-files.ts';

export type Tier = 'static' | 'unit' | 'integration' | 'model' | 'fault/recovery' | 'e2e' | 'load';
export const implementedTiers: Tier[] = ['static', 'unit', 'integration', 'model', 'fault/recovery', 'e2e', 'load'];
export const backendTiers: Tier[] = implementedTiers.filter(tier => tier !== 'e2e');
export const uncoveredTiers: Tier[] = [];
export function tierArtifactName(tier: Tier): string { return tier.replaceAll('/', '-'); }

export function parseArgs(args: string[]): { tier?: Tier; onlyFailed?: string; keep: boolean; record: boolean;
  files?: string[]; id?: string; backend?: boolean } {
  let tier: Tier | undefined;
  let onlyFailed: string | undefined;
  let keep = false;
  let record = false;
  let backend = false;
  const files: string[] = [];
  let id: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && implementedTiers.includes(args[i + 1] as Tier)) tier = args[++i] as Tier;
    else if (args[i] === '--only-failed' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(args[i + 1] ?? '')) onlyFailed = args[++i];
    else if (args[i] === '--file' && /\.(?:test|e2e)\.ts$/.test(args[i + 1] ?? '')) files.push(args[++i]!);
    else if (args[i] === '--id' && /^[A-Z][A-Z0-9]*\d{2,}$/.test(args[i + 1] ?? '')) id = args[++i];
    else if (args[i] === '--keep') keep = true;
    else if (args[i] === '--record') record = true;
    else if (args[i] === '--backend') backend = true;
    else throw new Error(`Unsupported QA option: ${args[i]}`);
  }
  if (record && (tier || onlyFailed || files.length || id)) throw new Error('--record requires a full run');
  if (backend && tier === 'e2e') throw new Error('The backend scope has no e2e tier');
  if (backend && onlyFailed) throw new Error('--backend --only-failed is unsupported');
  if (tier && onlyFailed) throw new Error('--tier and --only-failed cannot be combined');
  if ((files.length || id) && (!tier || onlyFailed || !['unit', 'integration', 'model', 'fault/recovery', 'e2e', 'load'].includes(tier))) {
    throw new Error('--file and --id require a unit, integration, model, fault/recovery, e2e or load tier');
  }
  return { tier, onlyFailed, keep, record,
    ...(backend ? { backend } : {}),
    ...(files.length ? { files } : {}), ...(id ? { id } : {}) };
}

// Bun shortens test output when it detects an agent. Tier logs must list every
// test, so a tier killed at its budget still shows how far it got.
const agentOutputVariables = ['AGENT', 'CLAUDECODE', 'REPL_ID'];
export function testLogEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !agentOutputVariables.includes(key)));
}

export function command(root: string, name: string, args: string[], timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env): { ok: boolean; output: string; elapsedMs: number } {
  const start = Date.now();
  const result = spawnSync(name, args, { cwd: root,
    env: name === 'bun' && args[0] === 'test' ? testLogEnvironment(env) : env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  return { ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'),
    elapsedMs: Date.now() - start };
}

export function sourceIdentity(root: string): { head: string; fingerprint: string; clean: boolean } {
  const head = command(root, 'git', ['rev-parse', 'HEAD'], 5_000);
  const status = command(root, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], 5_000);
  const diff = command(root, 'git', ['diff', '--binary', 'HEAD'], 10_000);
  if (!head.ok || !status.ok || !diff.ok) throw new Error('Cannot identify source tree');
  const hash = createHash('sha256').update(head.output).update(diff.output);
  for (const line of status.output.split('\n').filter(Boolean)) {
    const path = line.slice(3);
    if (line.startsWith('??') && existsSync(join(root, path))) {
      hash.update(path).update(readFileSync(join(root, path)));
    }
  }
  return { head: head.output.trim(), fingerprint: hash.digest('hex'), clean: !status.output.trim() };
}

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${randomBytes(3).toString('hex')}`;
}

export const LOAD_FIXTURE_ID = 'fx-medium-c9f6e4fdcb52';
export const LOAD_PREPARATION_BUDGET_MS = 600_000;
export const loadFixtureFiles = {
  OPS05: 'tests/qa/load/ops-phase-d.test.ts',
  SEARCH18: 'tests/qa/load/search-phase-d.test.ts',
  REC02: 'tests/qa/load/recommendation-skew.test.ts',
} as const;
export type LoadFixtureCase = keyof typeof loadFixtureFiles;

/** Each selected case gets one fresh writable copy, independent of test order. */
export function loadFixturePlan(runId: string, files: readonly string[], id?: string):
  { caseId: LoadFixtureCase; runId: string }[] {
  const suffix = { OPS05: 'o', SEARCH18: 's', REC02: 'r' } as const;
  return (Object.keys(loadFixtureFiles) as LoadFixtureCase[])
    .filter(caseId => (files.includes(loadFixtureFiles[caseId])
      || caseId === 'SEARCH18' && files.includes('tests/qa/load/fixture-restore.test.ts'))
      && (!id || id === caseId))
    .map(caseId => ({ caseId, runId: `fixture-${runId.replace('-', '')}-${suffix[caseId]}` }));
}

export function expectedFusekiModuleVersion(compose: string): string {
  const versions = [...compose.matchAll(/^\s*image:\s*rezics\/fuseki:6\.2\.0-cmd(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?\s*$/gm)]
    .map(match => match[1]!);
  if (versions.length !== 1) throw new Error('Compose must pin one command-module Fuseki image');
  return versions[0]!;
}

export function acquireFullLock(root: string, runId: string): () => void {
  const path = join(root, '.temp', 'qa-full.lock');
  mkdirSync(join(root, '.temp'), { recursive: true });
  try { mkdirSync(path); } catch { throw new Error(`Another full QA run holds ${path}`); }
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, runId }));
  return () => rmSync(path, { recursive: true, force: true });
}

export function xmlForCommand(tier: Tier, ok: boolean, elapsedMs: number, output: string): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escape(tier)}" tests="1" failures="${ok ? 0 : 1}" time="${elapsedMs / 1000}"><testcase name="${escape(tier)}" time="${elapsedMs / 1000}">${ok ? '' : `<failure message="command failed">${escape(output.slice(-4000))}</failure>`}</testcase></testsuite>\n`;
}

function shardLines(tiers: { name: Tier; shards?: ShardRecord[] }[], isolation: IsolationRecord[]): string[] {
  const seconds = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;
  const lines = tiers.filter(tier => tier.shards?.length).flatMap(tier => [
    `- ${tier.name} projects: ${tier.shards!.map(shard => `${shard.project}${shard.isolation ? ' (isolated)' : ''} `
      + `${shard.files.length} files ${seconds(shard.elapsedMs)} ${shard.status}`
      + `${shard.stage === 'test' ? '' : ` at ${shard.stage}`}`).join('; ')}`]);
  for (const item of isolation) {
    lines.push(`- Isolation ${item.tier}: ${item.file} failed after ${item.afterFiles} other files in ${item.afterProject}; `
      + (item.status === 'order-dependent' ? `passed alone in ${item.project} (order-dependent: assumes a fresh database)`
        : item.status === 'infrastructure-dependent' ? `passed alone in ${item.project} after Docker network exhaustion`
        : item.status === 'failed-alone' ? `also failed alone in ${item.project}` : 'not rerun alone'));
  }
  return lines.length ? ['', ...lines] : [];
}

export function writeSummary(directory: string, report: {
  runId: string; sourceBefore: ReturnType<typeof sourceIdentity>; sourceAfter: ReturnType<typeof sourceIdentity>;
  tiers: { name: Tier; status: 'passed' | 'failed' | 'uncovered'; elapsedMs?: number; shards?: ShardRecord[] }[];
  isolation?: IsolationRecord[];
  partial: boolean; errors: string[]; cases: Case[]; tests: TestResult[]; diagnosticOf?: string;
  retiredTests?: TestResult[];
  caseCoverage?: ReadonlyMap<string, readonly string[]>;
  scope?: 'all' | 'backend';
  excludedCases?: { id: string; page: string; reason: string }[];
  inventoryFingerprint?: string;
}): void {
  mkdirSync(directory, { recursive: true });
  const sourceStable = report.sourceBefore.fingerprint === report.sourceAfter.fingerprint;
  const passed = report.errors.length === 0 && sourceStable && report.tiers.every(t => t.status !== 'failed');
  const scope = report.scope ?? 'all';
  const requiredTiers = [...(scope === 'backend' ? backendTiers : implementedTiers), ...uncoveredTiers];
  const allTiersPassed = !report.partial && report.tiers.length === requiredTiers.length
    && requiredTiers.every(name => report.tiers.filter(tier => tier.name === name && tier.status === 'passed').length === 1);
  const ids = acceptanceStatuses(report.cases, report.tests, passed && allTiersPassed,
    report.caseCoverage);
  const counts = { uncovered: 0, 'partial-pass': 0, passed: 0, failed: 0 };
  for (const item of Object.values(ids)) counts[item.status]++;
  const certifiesFull = report.sourceBefore.clean && passed && allTiersPassed
    && counts.passed === report.cases.length;
  writeFileSync(join(directory, 'acceptance.json'), JSON.stringify({
    runId: report.runId, host: hostname(), source: report.sourceBefore, sourceStable,
    runKind: report.diagnosticOf ? 'failed-diagnostic' : report.partial ? 'selected-tier' : 'full',
    scope, inventoryFingerprint: report.inventoryFingerprint,
    excludedCases: report.excludedCases ?? [],
    partial: report.partial,
    diagnosticOf: report.diagnosticOf, certifiesFull, counts, ids,
    retiredPriorFailures: report.retiredTests?.map(test => `${test.tier}:${test.file}:${test.name}`) ?? [],
    declaredCaseCoverage: Object.fromEntries(report.caseCoverage ?? []),
    tests: report.tests.map(test => ({ ...test, ids: titleIds(test.name),
      status: test.failed ? 'failed' : test.skipped ? 'skipped' : 'passed' })),
    unmappedTests: report.tests.filter(test => titleIds(test.name).some(id => !ids[id]))
      .map(test => `${test.tier}:${test.file}:${test.name}`),
    tiers: report.tiers,
    isolation: report.isolation ?? [],
  }, null, 2) + '\n');
  writeFileSync(join(directory, 'summary.md'), [
    `# QA ${report.runId}`, '',
    `- Source: ${report.sourceBefore.head} (${report.sourceBefore.fingerprint.slice(0, 12)})`,
    `- Source stable: ${sourceStable ? 'yes' : 'no'}`,
    `- Result: ${passed ? 'pass' : 'fail'}; full qualification: ${certifiesFull ? 'yes' : 'no'}`,
    `- Scope: ${scope}${report.diagnosticOf ? `; failed tests from ${report.diagnosticOf}` : report.partial ? '; selected tier' : '; full command; acceptance coverage is reported by ID'}`,
    `- Excluded frontend-only IDs: ${(report.excludedCases ?? []).map(item => item.id).join(', ') || 'none'}`,
    `- Acceptance IDs: ${counts.passed} passed, ${counts['partial-pass']} partial pass, ${counts.failed} failed, ${counts.uncovered} uncovered`, '',
    '| Tier | Status | Time |', '| --- | --- | ---: |',
    ...report.tiers.map(t => `| ${t.name} | ${t.status} | ${t.elapsedMs === undefined ? '—' : `${(t.elapsedMs / 1000).toFixed(1)} s`} |`),
    ...shardLines(report.tiers, report.isolation ?? []),
    '', 'Partial passes indicate only the named cases exercised in this run; they do not certify an entire acceptance ID.',
    ...(report.retiredTests?.length ? ['Prior failures for host-Jena tests retired from QA are not rerun:',
      ...report.retiredTests.map(test => `- ${test.tier}:${test.file}:${test.name}`)] : []),
    ...report.errors.map(error => `- Error: ${error}`), '',
  ].join('\n'));
}

// Stack tiers run their files in parallel QA projects ("shards"). Each shard
// owns one disposable project; results merge into the tier's single JUnit file.
export interface ShardRecord { project: string; files: string[]; status: 'passed' | 'failed';
  stage: 'stack' | 'bootstrap' | 'test'; elapsedMs?: number; isolation?: boolean }
export interface IsolationRecord { tier: Tier; file: string; afterProject: string; afterFiles: number;
  project?: string; shardFailures: string[];
  status: 'order-dependent' | 'infrastructure-dependent' | 'failed-alone' | 'not-run' }

export async function commandAsync(root: string, name: string, args: string[], timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; output: string; elapsedMs: number;
  timedOut: boolean }> {
  const start = Date.now();
  const child = Bun.spawn([name, ...args], { cwd: root,
    env: name === 'bun' && args[0] === 'test' ? testLogEnvironment(env) : env,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGTERM' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),
    new Response(child.stderr).text(), child.exited]);
  const elapsedMs = Date.now() - start;
  const timedOut = child.signalCode !== null && elapsedMs >= timeoutMs;
  return { ok: code === 0 && !timedOut, elapsedMs, timedOut,
    output: [stdout, stderr, timedOut ? `${name} timed out after ${timeoutMs} ms` : ''].filter(Boolean).join('\n') };
}

/** Keep a burst of disposable stack starts below the Docker daemon's setup capacity. */
export function concurrencyGate(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be positive');
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const bunTestFile = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/;

// Bun treats a directory argument as a path filter; sharding needs the files.
export function expandTestPaths(root: string, paths: string[]): string[] {
  const found = new Set<string>();
  const walk = (local: string) => {
    for (const entry of readdirSync(join(root, local), { withFileTypes: true })) {
      const child = `${local}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(child);
      else if (entry.isFile() && bunTestFile.test(entry.name)) found.add(child);
    }
  };
  for (const path of paths) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) throw new Error(`Selected test path is missing: ${path}`);
    if (statSync(absolute).isDirectory()) walk(path.replace(/\/+$/, ''));
    else found.add(path);
  }
  return [...found].sort();
}

// Test arguments from `testArgs` are paths followed by Bun flags such as `-t`.
export function splitTestArgs(args: string[]): { paths: string[]; flags: string[] } {
  const first = args.findIndex(arg => arg.startsWith('-'));
  return first < 0 ? { paths: args, flags: [] } : { paths: args.slice(0, first), flags: args.slice(first) };
}

function logResults(text: string): { durations: Map<string, number>; failedFiles: Set<string> } {
  const durations = new Map<string, number>();
  const failedFiles = new Set<string>();
  let file: string | undefined;
  for (const line of text.split('\n')) {
    const header = line.match(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/);
    if (header) { file = header[1]!; continue; }
    const result = line.match(/^\((pass|fail|skip|todo)\) .* \[(\d+(?:\.\d+)?)(ms|s)\]$/);
    if (file && result) {
      const ms = Number(result[2]) * (result[3] === 's' ? 1000 : 1);
      durations.set(file, (durations.get(file) ?? 0) + ms);
      if (result[1] === 'fail') failedFiles.add(file);
    }
  }
  return { durations, failedFiles };
}

function stackUnavailable(runPath: string, tier: Tier): boolean {
  if (!['integration', 'model', 'fault/recovery', 'e2e', 'load'].includes(tier)) return false;
  const artifact = tierArtifactName(tier);
  const acceptance = join(runPath, 'acceptance.json');
  if (existsSync(acceptance)) {
    try {
      const report = JSON.parse(readFileSync(acceptance, 'utf8')) as {
        tiers?: { name?: string; shards?: { stage?: string }[] }[] };
      const record = report.tiers?.find(item => item.name === tier);
      if (record?.shards?.some(shard => shard.stage === 'stack' || shard.stage === 'bootstrap')) return true;
    } catch {
      // Older or interrupted reports may not have usable shard metadata; logs
      // below still identify a recorded startup or bootstrap failure.
    }
  }
  const logs = join(runPath, 'logs');
  if (!existsSync(logs)) return false;
  const names = readdirSync(logs);
  if (names.some(name => new RegExp(`^${artifact}-.+-(?:startup|bootstrap)\\.log$`).test(name))) return true;
  if (tier === 'integration' || tier === 'fault/recovery') return false;
  const setupFailed = [`${artifact}-stack.log`, `${artifact}-bootstrap.log`, `${artifact}-web-auth-bootstrap.log`]
    .some(name => names.includes(name));
  return setupFailed && !names.includes(`${artifact}.log`);
}

// Recorded per-file time for a tier: the largest of the last three observations
// across the given artifact roots, from merged JUnit or, for killed runs, logs.
export function recordedFileDurations(artifactRoots: string[], tier: Tier, maxRuns = 60,
  observations = 3): Map<string, number> {
  const artifact = tierArtifactName(tier);
  const logName = new RegExp(`^${artifact}(?:-f?r?\\d+)?\\.log$`);
  const runs = artifactRoots.filter(existsSync).flatMap(dir => readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{8}t\d{6}-[0-9a-f]{6}$/.test(entry.name))
    .map(entry => ({ name: entry.name, path: join(dir, entry.name) })))
    .filter(run => existsSync(join(run.path, `${artifact}.xml`))
      || (existsSync(join(run.path, 'logs')) && readdirSync(join(run.path, 'logs')).some(name => logName.test(name))))
    .sort((a, b) => b.name.localeCompare(a.name)).slice(0, maxRuns);
  const observed = new Map<string, number[]>();
  for (const run of runs) {
    // Stack startup/bootstrap failures can make every case finish quickly
    // without measuring test work. Do not let any such run affect history.
    if (stackUnavailable(run.path, tier)) continue;
    const perRun = new Map<string, number>();
    const failedFiles = new Set<string>();
    const junitFileFailures = new Map<string, boolean>();
    const xml = join(run.path, `${artifact}.xml`);
    if (existsSync(xml)) {
      for (const test of parseJUnit(readFileSync(xml, 'utf8'), tier)) {
        junitFileFailures.set(test.file, (junitFileFailures.get(test.file) ?? false) || test.failed);
        if (test.durationMs !== undefined) perRun.set(test.file, (perRun.get(test.file) ?? 0) + test.durationMs);
      }
    }
    // A timed-out shard may leave a partial JUnit file. Its log still records
    // completed files that never reached the reporter, so inspect both.
    if (existsSync(join(run.path, 'logs'))) {
      for (const name of readdirSync(join(run.path, 'logs'))) {
        if (!logName.test(name)) continue;
        // An isolated rerun repeats a shard's file; keep the longer observation.
        const log = logResults(readFileSync(join(run.path, 'logs', name), 'utf8'));
        for (const file of log.failedFiles) failedFiles.add(file);
        for (const [file, ms] of log.durations) {
          perRun.set(file, Math.max(perRun.get(file) ?? 0, ms));
        }
      }
    }
    // The merged JUnit is authoritative when a failed shared-project case was
    // recovered by its isolated rerun. A log-only failure remains disqualifying.
    for (const [file, failed] of junitFileFailures) {
      if (failed) failedFiles.add(file);
      else failedFiles.delete(file);
    }
    // Logs only contain result lines for files that started; failed files are
    // discarded as a whole even if some tests in them passed first.
    for (const file of failedFiles) perRun.delete(file);
    for (const [file, ms] of perRun) {
      const list = observed.get(file) ?? [];
      if (list.length < observations) observed.set(file, [...list, ms]);
    }
  }
  return new Map([...observed].map(([file, list]) => [file, Math.round(Math.max(...list))]));
}

export function estimatedDurations(files: string[], recorded: ReadonlyMap<string, number>): Map<string, number> {
  const known = files.map(file => recorded.get(file)).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 30_000;
  return new Map(files.map(file => [file, recorded.get(file) ?? fallback]));
}

// G-137's complete fault run was retained outside this checkout and its worktree
// has since been removed. Use these observations until this worktree measures
// the same files with its current test code.
export const faultRecoveryBaselineDurations = new Map([
  ['tests/qa/fault-recovery/second-host-format-upgrade.test.ts', 177_000],
  ['tests/qa/fault-recovery/content-projection-crash.test.ts', 146_000],
  ['tests/qa/fault-recovery/content-rebuild-positive.test.ts', 143_000],
  ['tests/qa/fault-recovery/search-ops-cold-rebuild.test.ts', 122_000],
  ['tests/qa/fault-recovery/search-ops-generation.test.ts', 121_000],
  ['tests/qa/fault-recovery/search-raw-import.test.ts', 120_000],
  ['tests/qa/fault-recovery/tdb2-compact-history.test.ts', 98_000],
]);

// Enough shards to keep each at half its budget (parallel projects slow each
// other), never more than the files or the allowed maximum.
export function shardCount(estimates: ReadonlyMap<string, number>, budgetMs: number, maximum: number): number {
  const total = [...estimates.values()].reduce((sum, ms) => sum + ms, 0);
  const minimum = estimates.size >= 8 ? 2 : 1;
  return Math.max(1, Math.min(maximum, estimates.size,
    Math.max(minimum, Math.ceil(total / (budgetMs / 2)))));
}

// Longest-processing-time assignment: deterministic and within 4/3 of optimal.
export function planShards(estimates: ReadonlyMap<string, number>, count: number): string[][] {
  const shards = Array.from({ length: Math.max(1, Math.min(count, estimates.size)) }, () => ({ files: [] as string[], ms: 0 }));
  const ordered = [...estimates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [file, ms] of ordered) {
    const target = shards.reduce((best, shard) => shard.ms < best.ms ? shard : best);
    target.files.push(file);
    target.ms += ms;
  }
  return shards.filter(shard => shard.files.length).map(shard => shard.files.sort());
}

// These tests clear or temporarily remove state in the shared product graph,
// replay its outbox from sequence zero, or need a fresh graph for bounded
// writes. Run each against its own bootstrapped QA project.
export const isolatedIntegrationFiles: ReadonlySet<string> = new Set(isolatedIntegrationFileList);

export const isolatedFaultFiles = new Set([
  'tests/qa/fault-recovery/partition-relocation.test.ts',
  'tests/qa/fault-recovery/rights-restriction-replay.test.ts',
  'tests/qa/fault-recovery/semantic-lost-response.test.ts',
  'tests/qa/fault-recovery/source-author-credit.test.ts',
]);

// These files create and reset their own named QA projects (or one standalone
// Fuseki container). They need a run ID and artifact directory, not a second
// bootstrapped project held open by the shard harness.
export const selfManagedFaultFiles = new Set([
  'services/account/tests/account-pitr.integration.test.ts',
  'services/account/tests/account-access-recovery.integration.test.ts',
  'services/main/tests/access-pitr.integration.test.ts',
  'services/main/tests/content-recovery.integration.test.ts',
  'tests/qa/fault-recovery/account-erasure-frontier.test.ts',
  'tests/qa/fault-recovery/content-projection-crash.test.ts',
  'tests/qa/fault-recovery/content-publication-recovery.test.ts',
  'tests/qa/fault-recovery/content-rebuild-positive.test.ts',
  'tests/qa/fault-recovery/content-rebuild.test.ts',
  'tests/qa/fault-recovery/coordinated-owner-cut.test.ts',
  'tests/qa/fault-recovery/erasure-graph-purge.test.ts',
  'tests/qa/fault-recovery/erasure-restore.test.ts',
  'tests/qa/fault-recovery/erasure-search-command.test.ts',
  'tests/qa/fault-recovery/erasure-search-rebuild.test.ts',
  'tests/qa/fault-recovery/fixed-release-recovery.test.ts',
  'tests/qa/fault-recovery/organization-publication-recovery.test.ts',
  'tests/qa/fault-recovery/protection-restore.test.ts',
  'tests/qa/fault-recovery/rating-daily.test.ts',
  'tests/qa/fault-recovery/recovery-coverage-discovery.test.ts',
  'tests/qa/fault-recovery/rights-restriction-replay.test.ts',
  'tests/qa/fault-recovery/search-candidate-overflow.test.ts',
  'tests/qa/fault-recovery/search-ops-cold-rebuild.test.ts',
  'tests/qa/fault-recovery/search-ops-generation.test.ts',
  'tests/qa/fault-recovery/search-ops-lock.test.ts',
  'tests/qa/fault-recovery/search-ops-quickstart.test.ts',
  'tests/qa/fault-recovery/search-raw-import.test.ts',
  'tests/qa/fault-recovery/second-host-format-upgrade.test.ts',
  'tests/qa/fault-recovery/source-author-credit.test.ts',
  'tests/qa/fault-recovery/source-field-child.test.ts',
  'tests/qa/fault-recovery/source-projection-recovery.test.ts',
  'tests/qa/fault-recovery/tdb2-compact-history.test.ts',
  'tests/qa/fault-recovery/translated-work-recovery.test.ts',
  'tests/qa/fault-recovery/work-derivation-recovery.test.ts',
  'tests/qa/fault-recovery/work-scalar-recovery.test.ts',
  'tests/qa/fault-recovery/work-title-control.test.ts',
]);

export function planStackProjects(estimates: ReadonlyMap<string, number>, count: number,
  tier: 'integration' | 'fault/recovery'): string[][] {
  const ownProjects = tier === 'integration' ? isolatedIntegrationFiles : isolatedFaultFiles;
  const isolated = [...estimates.keys()].filter(file => ownProjects.has(file)).sort();
  const shared = new Map([...estimates].filter(([file]) => !ownProjects.has(file)));
  if (tier === 'fault/recovery') {
    const selfManaged = new Map([...shared].filter(([file]) => selfManagedFaultFiles.has(file)));
    const harnessManaged = new Map([...shared].filter(([file]) => !selfManagedFaultFiles.has(file)));
    const selfSlots = Math.max(1, count - Number(harnessManaged.size > 0));
    const selfPlans = selfManaged.size ? planShards(selfManaged, selfSlots) : [];
    const harnessPlans = harnessManaged.size ? planShards(harnessManaged, selfManaged.size ? 1 : count) : [];
    // Keep the harness-managed files running beside the long drills; queuing
    // their full stack until a long drill ends would extend the tier wall time.
    return [...selfPlans, ...harnessPlans, ...isolated.map(file => [file])];
  }
  const sharedSlots = Math.max(1, count - Number(isolated.length > 0 && shared.size > 0));
  return [...(shared.size ? planShards(shared, sharedSlots) : []), ...isolated.map(file => [file])];
}

function scheduledPlanDurationMs(projects: string[][], estimates: ReadonlyMap<string, number>, workers: number): number {
  const finishTimes = Array.from({ length: Math.max(1, workers) }, () => 0);
  for (const project of projects) {
    const duration = project.reduce((sum, file) => sum + (estimates.get(file) ?? 0), 0);
    let worker = 0;
    for (let index = 1; index < finishTimes.length; index++) {
      if (finishTimes[index]! < finishTimes[worker]!) worker = index;
    }
    finishTimes[worker] += duration;
  }
  return Math.max(...finishTimes);
}

/** Explain when the current bounded plan is estimated to exceed its tier budget. */
export function stackPlanBudgetWarning(estimates: ReadonlyMap<string, number>, budgetMs: number,
  shards: number, maximum: number, tier: 'integration' | 'fault/recovery'): string | undefined {
  if (!estimates.size) return undefined;
  const workers = Math.max(1, Math.min(shards, estimates.size));
  const estimatedMs = scheduledPlanDurationMs(planStackProjects(estimates, workers, tier), estimates, workers);
  if (estimatedMs <= budgetMs) return undefined;

  let fittingShards: number | undefined;
  for (let count = 1; count <= estimates.size; count++) {
    const duration = scheduledPlanDurationMs(planStackProjects(estimates, count, tier), estimates, count);
    if (duration <= budgetMs) { fittingShards = count; break; }
  }
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const fit = fittingShards === undefined ? 'no shard count up to the file count is estimated to fit'
    : `${fittingShards} shards are estimated to fit`;
  return `Warning: ${tier} is estimated at ${seconds(estimatedMs)} with ${workers} available shard(s), `
    + `over its ${seconds(budgetMs)} budget; ${fit}. REZICS_QA_SHARDS cap: ${maximum}.`;
}

export function maximumShards(env: NodeJS.ProcessEnv, tier: 'integration' | 'fault/recovery'): number {
  const value = env.REZICS_QA_SHARDS;
  if (value === undefined) return tier === 'integration' ? 6 : 8;
  if (!/^[1-8]$/.test(value)) throw new Error('REZICS_QA_SHARDS must be an integer from 1 to 8');
  return Number(value);
}

// Top-level <testsuite> blocks with their file attribute; Bun writes one per file.
export function junitSuites(xml: string): { file?: string; xml: string }[] {
  const suites: { file?: string; xml: string }[] = [];
  let depth = 0;
  let start = 0;
  for (const match of xml.matchAll(/<testsuite\b[^>]*?\/>|<testsuite\b[^>]*>|<\/testsuite>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      depth--;
      if (depth === 0) {
        const block = xml.slice(start, match.index + tag.length);
        suites.push({ file: block.match(/^<testsuite\b[^>]*?\sfile="([^"]*)"/)?.[1], xml: block });
      }
    } else if (tag.endsWith('/>')) {
      if (depth === 0) suites.push({ file: tag.match(/\sfile="([^"]*)"/)?.[1], xml: tag });
    } else {
      if (depth === 0) start = match.index;
      depth++;
    }
  }
  return suites;
}

export function mergeJUnit(suites: string[], elapsedMs: number): string {
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  for (const suite of suites) {
    for (const match of suite.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      tests++;
      if (/<(?:failure|error)\b/.test(match[1] ?? '')) failures++;
      else if (/<skipped\b/.test(match[1] ?? '')) skipped++;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${elapsedMs / 1000}">\n${suites.map(suite => `  ${suite}`).join('\n')}\n</testsuites>\n`;
}

// A few failed files can be checked on fresh projects. A larger failure wave
// usually means the shared stack failed; individual reruns cannot establish
// which file caused it. The preceding count follows JUnit execution order.
export function isolationCandidates(xml: string, tier: Tier, maxFailedFiles = 5):
  { file: string; names: string[]; afterFiles: number; infrastructure: boolean }[] {
  const suites = junitSuites(xml);
  const order = new Map<string, number>();
  for (const suite of suites) if (suite.file && !order.has(suite.file)) order.set(suite.file, order.size);
  const failed = new Map<string, string[]>();
  for (const test of parseJUnit(xml, tier)) if (test.failed) {
    failed.set(test.file, [...failed.get(test.file) ?? [], test.name]);
  }
  if (failed.size > maxFailedFiles) return [];
  return [...failed].filter(([file]) => order.has(file))
    .map(([file, names]) => ({ file, names, afterFiles: order.get(file)!,
      infrastructure: suites.some(suite => suite.file === file
        && /all predefined address pools have been fully subnetted/.test(suite.xml)) }));
}

export function shardResolved(ok: boolean, stage: ShardRecord['stage'], timedOut: boolean,
  failedFiles: ReadonlySet<string>, isolatedFiles: ReadonlySet<string>): boolean {
  return ok || (stage === 'test' && !timedOut && failedFiles.size > 0
    && [...failedFiles].every(file => isolatedFiles.has(file)));
}

// Bun exits 1 when `-t` matches nothing in a shard; other shards may hold the match.
export function matchedNoTests(output: string): boolean {
  return /^error: regex .* matched 0 tests\b/m.test(output);
}

function ancestors(pid: number): Set<number> {
  const found = new Set<number>();
  for (let current = pid; current > 1 && !found.has(current);) {
    found.add(current);
    try {
      const stat = readFileSync(`/proc/${current}/stat`, 'utf8');
      current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return found;
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The main checkout that owns this worktree's repository.
function mainCheckout(root: string): string | undefined {
  const common = command(root, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5_000);
  return common.ok ? dirname(common.output.trim()) : undefined;
}

// Prior QA artifacts of this checkout, the main checkout and its Goal worktrees.
export function artifactRoots(root: string): string[] {
  const roots = new Set([join(root, '.artifacts', 'qa')]);
  const main = mainCheckout(root);
  if (main) {
    roots.add(join(main, '.artifacts', 'qa'));
    const worktrees = join(main, '.temp', 'worktrees');
    if (existsSync(worktrees)) for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.add(join(worktrees, entry.name, '.artifacts', 'qa'));
    }
  }
  return [...roots];
}

export function goalSlotDirectory(root: string): string | undefined {
  const main = mainCheckout(root);
  const directory = main && join(main, '.temp', 'goal-orchestration', 'qa-slots');
  return directory && existsSync(directory) ? directory : undefined;
}

// Shares the Goal's QA slots (`goalctl slot`, GOAL_QA_SLOTS): a run started under
// a slot keeps it and takes free slots for extra shards without waiting.
export function acquireQaSlots(directory: string | undefined, wanted: number,
  env: NodeJS.ProcessEnv = process.env, pid = process.pid): { count: number; release: () => void } {
  if (!directory) return { count: wanted, release: () => {} };
  const total = /^[1-9]\d*$/.test(env.GOAL_QA_SLOTS ?? '') ? Number(env.GOAL_QA_SLOTS) : 8;
  const lineage = ancestors(pid);
  const owner = (path: string) => existsSync(join(path, 'pid')) ? Number(readFileSync(join(path, 'pid'), 'utf8')) : 0;
  const held = Array.from({ length: total }, (_, k) => join(directory, String(k)))
    .some(path => existsSync(path) && lineage.has(owner(path))) ? 1 : 0;
  const acquired: string[] = [];
  for (let k = 0; k < total && held + acquired.length < wanted; k++) {
    const path = join(directory, String(k));
    if (existsSync(path) && !pidAlive(owner(path)) && Date.now() - statSync(path).mtimeMs >= 10_000) {
      rmSync(path, { recursive: true, force: true });
    }
    try { mkdirSync(path); } catch { continue; }
    writeFileSync(join(path, 'pid'), String(pid));
    acquired.push(path);
  }
  return { count: Math.max(1, held + acquired.length),
    release: () => { for (const path of acquired) rmSync(path, { recursive: true, force: true }); } };
}
