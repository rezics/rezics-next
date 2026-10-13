import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, writeFileSync } from 'node:fs';
import * as filesystem from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hungTestFile, inputSelectedNativeTests, parseJUnit, UNEXECUTED_FILE_TEST, type TestResult } from '../qa/acceptance.ts';
import { forgetChildScope, noteChildScope, reapChildEnvironment, reapChildScope, settleReap } from '../qa/container-reaper.ts';
import { newRunId, type Tier } from '../qa/core.ts';
import { directoryLeaseHeld, tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import { defaultStopGraceMs, terminateProcessGroup } from '../qa/process/terminate.ts';
import { ownerTierBudgetMs } from '../qa/owner-tier-budget.ts';
import { admittedCommandBudgetEnv, BUILD_ADMISSION_GIB } from '../qa/host-admission.ts';
import { qaMemoryDeadline } from '../qa/memory-admission.ts';
import type { DeclaredTestTimeout } from './goalctl.ts';
import { physicalPath, POSTGRES_SOCKET_LIMIT, postgresSocketByteLength } from './postgres-socket.ts';
import { verticalJourneyFilter, type VerticalJourney } from '../qa/cases/vertical-journeys.ts';

export type RegressionTier = 'unit' | 'owner' | 'model' | 'integration' | 'fault/recovery' | 'e2e' | 'accounts:storybook' | 'jena:check';
export type Classification = 'infrastructure' | 'resource' | 'deadline' | 'order-dependent' | 'flaky' | 'deterministic';
type Outcome = 'pending' | 'passed' | 'failed' | 'missing' | 'void' | 'excluded' | 'deferred';
export interface MergeEvent { before: string; after: string; goal: string; taskIds: string[]; at: string }
export interface ExpectedFile { file: string; tier: RegressionTier | 'live' | 'load' | 'legacy' | 'external'; outcome: Outcome; reason?: string; tests?: string[] }
export interface Execution {
  code: number; outcomes: Record<string, 'passed' | 'failed' | 'missing'>; artifactPaths: string[];
  queueMs: number; testMs: number; totalMs: number; evidence?: string; classification?: Classification;
  failingTests?: string[];
  cause?: string;
  /** The file still running when this batch stopped on a timeout, and the tier log that shows it. */
  hang?: { file: string; log: string };
}
export interface Batch {
  id: string; tier: RegressionTier; files: string[]; state: 'pending' | 'running' | 'done'; attempts: Execution[];
  /** Per-file deadline, including the gate's margin for declared test timeouts. */
  budgetMs?: number;
  /** Exact titles for a singleton nightly journey file. */
  tests?: string[];
}
/** The diagnosis fields worth carrying from an earlier run, without its probe log. */
export interface RecordedDiagnosis {
  status: Diagnosis['status']; classification: Classification; before?: string; after: string;
  goal?: string; taskIds?: string[]; reason?: string;
}
export interface Diagnosis {
  file: string; status: 'attributed' | 'inherited' | 'unavailable' | 'inconclusive' | 'undiagnosed'; classification: Classification;
  before?: string; after: string; goal?: string; taskIds?: string[]; probes: { commit: string; outcome: string }[];
  artifactPaths: string[]; reason?: string;
  /** Finished run in which this file was already failing. */
  earlierRunId?: string;
  /** That run's diagnosis for this file, when it recorded one. */
  earlierDiagnosis?: RecordedDiagnosis;
}
/** Failures that are new, still failing, or fixed since the baseline run. */
export interface RegressionComparison {
  earlierRunId: string; new: string[]; inherited: string[]; fixed: string[];
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
  /** Wall-clock milliseconds already spent diagnosing this run. Resume continues from this total. */
  diagnosisSpentMs?: number;
  /** Closest finished baseline, chosen once so resume classifies against the same run. */
  baselineRunId?: string;
  /** New, inherited and fixed failures versus that baseline. */
  comparison?: RegressionComparison;
  /** Browser tiers are inventoried but excluded from routine runs; older manifests included them. */
  selection?: 'routine' | 'explicit' | 'nightly';
  verticalJourneys?: readonly VerticalJourney[];
}
export interface RegressionOptions {
  repo: string; stateDir: string; at?: string; resume?: string; only?: RegressionTier[]; integrationBatches?: number;
  shards?: number; slots?: number; runId?: string; checkoutRoot?: string; legacyRoot?: string;
  registry?: (checkout: string) => Promise<ExpectedFile[]>;
  nightly?: boolean;
  journeyRegistry?: (checkout: string) => Promise<readonly VerticalJourney[]>;
  prepare?: (checkout: string) => Promise<{ ok: boolean; artifactPaths: string[]; reason?: string }>;
  runner?: (checkout: string, batch: Batch, directory: string, shards: number, slotLimit: number, artifactRoot?: string) => Promise<Execution>;
  waitForTurn?: typeof waitForRegressionTurn;
  route?: (entry: InboxEntry) => Promise<void>;
  /** Clock for the diagnosis budget. Production uses `Date.now`. */
  now?: () => number;
  /** Overrides `GOAL_REGRESS_DIAGNOSIS_BUDGET_MS` for one run. */
  diagnosisBudgetMs?: number;
}
export interface RegressionTurnOptions {
  status?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadline?: number;
  announce?: (message: string) => void;
}

type RegressionGoalctl = Pick<typeof import('./goalctl.ts'), 'declaredTestTimeout' | 'planUnitGateShards' | 'heavyQaStatus'>;
let providedGoalctl: RegressionGoalctl | undefined;
/** goalctl is the command's entry module and awaits the regression at its top level. Importing it from here
 * while it runs never settles: the first real run after such an import spun for 45 minutes without a batch.
 * The entry hands its functions over instead; a caller that is not goalctl falls back to the import. */
export function provideGoalctl(module: RegressionGoalctl | undefined): void { providedGoalctl = module; }
const loadGoalctl = async (): Promise<RegressionGoalctl> => providedGoalctl ?? await import('./goalctl.ts');

/** Explicit maintenance barrier. Normal browser runs join the shared fair queue without waiting for it to drain. */
export async function waitForRegressionTurn(lockDir?: string, interrupted: () => boolean = () => false,
  options: RegressionTurnOptions = {}): Promise<void> {
  let status = options.status;
  if (!status) {
    const { heavyQaStatus } = await loadGoalctl();
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
/** Batches in flight. Two never starves worker QA and is the default; the program widens it from
 * `regress-lane-count` beside the run reports when the host has room. Each batch still takes QA slots
 * through the host's slot leases, so the slot count stays the bound on stacks. */
export function regressionLaneLimit(stateDir: string, fallback: number): number {
  const file = join(stateDir, 'regress-lane-count');
  const stored = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return /^[1-9]\d*$/.test(stored) && Number.isSafeInteger(Number(stored)) ? Number(stored) : fallback;
}
const tiers: RegressionTier[] = ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'e2e', 'accounts:storybook', 'jena:check'];
const browserTier = (tier: RegressionTier): boolean => tier === 'e2e' || tier === 'accounts:storybook';
const routineBrowserReason = 'Browser journeys and Storybook run in the nightly full regression';
const nightlyBrowserReason = 'Nightly regression runs only the named vertical journeys';
const batchSize = (tier: RegressionTier, files: number): number =>
  tier === 'integration' || tier === 'e2e' ? 5 : tier === 'unit' || tier === 'owner' || tier === 'fault/recovery' ? 15
    : tier === 'jena:check' ? 1 : files;
const jenaCliFile = 'scripts/qa/jena-cli.ts';
const nativeImageProofs = new Set<string>(inputSelectedNativeTests);
const jenaCheckDefaultBudgetMs = 75_000;
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

export function parseRegressArgs(args: string[]): Pick<RegressionOptions, 'at' | 'resume' | 'only' | 'integrationBatches' | 'nightly'> {
  const options: ReturnType<typeof parseRegressArgs> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--nightly') { options.nightly = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--at' && /^[A-Za-z0-9._/@^~-]+$/.test(value)) options.at = value;
    else if (flag === '--resume' && validId(value)) options.resume = value;
    else if (flag === '--only' && value.split(',').every(tier => tiers.includes(tier as RegressionTier))) {
      options.only = [...new Set(value.split(',') as RegressionTier[])];
    } else if (flag === '--integration-batches' && /^\d+$/.test(value)) options.integrationBatches = Number(value);
    else throw new Error(`Invalid regress option: ${flag} ${value}`);
  }
  if (options.resume && (options.only || options.nightly || options.integrationBatches !== undefined)) throw new Error('Resume keeps the original selection');
  if (options.nightly && (options.only || options.integrationBatches !== undefined)) throw new Error('--nightly runs all non-browser tiers and cannot restrict tiers or batches');
  return options;
}

export interface PruneCheckoutEntry { path: string; reason: string; bytes?: number }
export interface PruneCheckoutsReport {
  cacheRoot: string; apply: boolean;
  kept: PruneCheckoutEntry[]; removed: PruneCheckoutEntry[]; untouched: PruneCheckoutEntry[];
}
export interface PruneCheckoutsOptions {
  repo?: string; stateDir?: string; checkoutRoot?: string; apply?: boolean; measureBytes?: boolean;
}

/** A child of `root`, following a symlink only when the target stays inside `root`. */
function cacheChild(root: string, path: string): string | undefined {
  const candidate = resolve(path);
  if (!within(root, candidate) || candidate === root) return undefined;
  if (!existsSync(candidate)) return candidate;
  const physical = realpathSync(candidate);
  return within(root, physical) && physical !== root ? physical : undefined;
}

function gitResult(repo: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Listed path keyed by every spelling git or the checkout map may use. */
function registeredWorktrees(repo: string): Map<string, string> {
  const listed = new Map<string, string>();
  const result = gitResult(repo, ['worktree', 'list', '--porcelain']);
  if (!result.ok) throw new Error(`git worktree list --porcelain: ${result.stderr}`);
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = resolve(line.slice('worktree '.length).trim());
    listed.set(path, path);
    if (existsSync(path)) listed.set(realpathSync(path), path);
  }
  return listed;
}

function registeredPath(listed: Map<string, string>, checkout: string): string | undefined {
  const resolved = resolve(checkout);
  return listed.get(resolved) ?? (existsSync(resolved) ? listed.get(realpathSync(resolved)) : undefined);
}

function readCheckoutMap(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return {};
  try {
    const value = json<unknown>(path);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const map: Record<string, string> = {};
    for (const [key, checkout] of Object.entries(value)) {
      if (typeof checkout !== 'string' || !checkout) return undefined;
      map[key] = checkout;
    }
    return map;
  } catch { return undefined; }
}

interface RegressionRunView { id: string; live: boolean; map?: Record<string, string> }

/** Run directories live in `stateDir` when it is already `…/regress`; an orchestration root names that child. */
function regressionRunDirectory(stateDir: string): string {
  const directory = resolve(stateDir);
  return basename(directory) === 'regress' ? directory : join(directory, 'regress');
}

/** `<repo>/.temp/goal-orchestration/regress`, where each regression run has its own directory. */
export function regressionRunsRoot(repo: string): string {
  return join(repo, '.temp', 'goal-orchestration', 'regress');
}

/** QA evidence for every batch of one regression run. */
export function regressionQaDirectory(runDirectory: string): string {
  return join(runDirectory, 'qa');
}

/** Artifact root for one batch label. The label may contain slashes (`<batch>/attempt-1`, `probes/<id>`). */
export function regressionBatchQaDirectory(runDirectory: string, label: string): string {
  return join(regressionQaDirectory(runDirectory), label);
}

function regressionRuns(stateDir: string): RegressionRunView[] {
  const root = regressionRunDirectory(stateDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const directory = join(root, entry.name);
    return { id: entry.name, live: directoryLeaseHeld(join(directory, 'lock')),
      map: readCheckoutMap(join(directory, 'checkouts.json')) };
  });
}

function holdsOldEvidence(path: string): boolean {
  return existsSync(join(path, '.artifacts/qa')) || existsSync(join(path, '.temp/regress-preflight'));
}

/** A live lock protects its mapped checkouts and every unmapped cache worktree, which may still be mid-create. */
function checkoutDisposition(path: string, runs: RegressionRunView[], listed: Map<string, string>): { keep: boolean; reason: string } {
  const owners = runs.filter(run => run.map && Object.values(run.map).some(checkout =>
    registeredPath(listed, checkout) === path || resolve(checkout) === resolve(path)));
  const live = runs.filter(run => run.live);
  const names = (group: RegressionRunView[]) => group.map(run => run.id).sort().join(', ');
  const evidence = holdsOldEvidence(path) ? '; holds old evidence' : '';
  if (live.some(run => !run.map)) return { keep: true, reason: `live run ${names(live)} has an unreadable checkout map${evidence}` };
  const liveOwners = owners.filter(run => run.live);
  if (liveOwners.length) return { keep: true, reason: `live run ${names(liveOwners)}${evidence}` };
  const deadOwners = owners.filter(run => !run.live);
  if (live.length && !deadOwners.length) return { keep: true, reason: `unmapped while run ${names(live)} is live${evidence}` };
  const reason = deadOwners.length ? `non-live run ${names(deadOwners)}` : 'registered worktree with no checkout map';
  return { keep: false, reason: `${reason}${evidence}` };
}

function checkoutBytes(root: string): Map<string, number> | undefined {
  const result = spawnSync('du', ['-d', '1', '-B1', root], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const sizes = new Map<string, number>();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (!match) continue;
    const bytes = Number(match[1]);
    if (Number.isSafeInteger(bytes)) sizes.set(resolve(match[2]!), bytes);
  }
  return sizes;
}

function removeWorktree(repo: string, path: string): boolean {
  // Release staging under .temp/releases is made read-only; git cannot delete it until it is writable again.
  spawnSync('chmod', ['-R', 'u+w', path], { encoding: 'utf8' });
  const removed = gitResult(repo, ['worktree', 'remove', '--force', path]);
  if (removed.ok || !existsSync(path)) return true;
  console.error(`git worktree remove --force ${path}: ${removed.stderr.trim()}`);
  return false;
}

function pruneWorktreeMetadata(repo: string): void {
  const pruned = gitResult(repo, ['worktree', 'prune']);
  if (!pruned.ok) console.error(`git worktree prune: ${pruned.stderr.trim()}`);
}

/** Drop the checkouts this run mapped. Paths outside the cache and owned legacy root stay. */
function removeMappedCheckouts(repo: string, map: Record<string, string>, cacheRoot: string, legacyRoot: string,
  physicalLegacyRoot: string, legacyOwned: boolean): void {
  const listed = registeredWorktrees(repo);
  const repoPath = realpathSync(repo);
  let removed = false;
  for (const checkout of new Set(Object.values(map))) {
    const path = registeredPath(listed, checkout);
    if (!path || (existsSync(path) && realpathSync(path) === repoPath)) continue;
    const candidate = resolve(checkout);
    const physical = existsSync(candidate) ? realpathSync(candidate) : physicalPath(candidate);
    const legacyCandidate = legacyOwned && (within(legacyRoot, candidate) || within(physicalLegacyRoot, candidate));
    const legacyPhysical = legacyOwned && within(physicalLegacyRoot, physical);
    const allowed = (within(cacheRoot, candidate) || legacyCandidate) && (within(cacheRoot, physical) || legacyPhysical)
      && candidate !== cacheRoot && physical !== cacheRoot && candidate !== resolve(legacyRoot) && physical !== physicalLegacyRoot;
    if (!allowed) continue;
    if (removeWorktree(repo, path)) removed = true;
  }
  if (removed) pruneWorktreeMetadata(repo);
}

/** The main checkout, even when this process is inside a linked worktree. */
function regressionRepository(): string {
  const result = gitResult(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = result.stdout.trim();
  if (!result.ok || !common) throw new Error(`git rev-parse --git-common-dir: ${result.stderr.trim()}`);
  return dirname(common);
}

/**
 * Remove registered worktrees under the regression cache that no live run maps.
 * While any run is live, only a non-live run's mapped paths are removable: a checkout
 * is registered with git before it is written to the map. Dry-run unless `apply`.
 * `repo` defaults to the main checkout and `stateDir` to `<repo>/.temp/goal-orchestration/regress`.
 */
export function pruneRegressionCheckouts(options: PruneCheckoutsOptions = {}): PruneCheckoutsReport {
  const repo = options.repo ?? regressionRepository();
  const stateDir = options.stateDir ?? regressionRunsRoot(repo);
  const cacheRoot = regressionCheckoutRoot(repo, options.checkoutRoot);
  const listed = registeredWorktrees(repo);
  const runs = regressionRuns(stateDir);
  // A full `du` of every checkout does not change which paths are kept; ask for it explicitly.
  const sizes = options.measureBytes ? checkoutBytes(cacheRoot) : undefined;
  const bytesOf = (path: string): number | undefined => sizes?.get(resolve(path)) ?? (existsSync(path) ? sizes?.get(realpathSync(path)) : undefined);
  const kept: PruneCheckoutEntry[] = [];
  const removed: PruneCheckoutEntry[] = [];
  const untouched: PruneCheckoutEntry[] = [];
  const seen = new Set<string>();
  const candidates = [...new Set(listed.values())].filter(path => cacheChild(cacheRoot, path) !== undefined);
  for (const path of candidates) {
    seen.add(resolve(path));
    if (existsSync(path)) seen.add(realpathSync(path));
    const decision = checkoutDisposition(path, runs, listed);
    const bytes = bytesOf(path);
    (decision.keep ? kept : removed).push({ path, reason: decision.reason, ...(bytes !== undefined ? { bytes } : {}) });
  }
  if (options.apply) {
    const freshRuns = regressionRuns(stateDir);
    const freshListed = registeredWorktrees(repo);
    const deleted: PruneCheckoutEntry[] = [];
    for (const entry of removed) {
      const decision = checkoutDisposition(entry.path, freshRuns, freshListed);
      if (decision.keep) {
        kept.push({ path: entry.path, reason: decision.reason, ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}) });
        continue;
      }
      if (removeWorktree(repo, entry.path)) deleted.push(entry);
    }
    removed.splice(0, removed.length, ...deleted);
    if (deleted.length) pruneWorktreeMetadata(repo);
  }
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    const path = join(cacheRoot, entry.name);
    if (seen.has(resolve(path)) || (existsSync(path) && seen.has(realpathSync(path)))) continue;
    const physical = existsSync(path) ? realpathSync(path) : undefined;
    untouched.push({ path, reason: physical !== undefined && !within(cacheRoot, physical)
      ? 'escapes the cache root' : 'not a registered worktree' });
  }
  for (const run of runs) {
    for (const checkout of new Set(Object.values(run.map ?? {}))) {
      if (cacheChild(cacheRoot, checkout) !== undefined) continue;
      const evidence = existsSync(checkout) && holdsOldEvidence(checkout) ? '; holds old evidence' : '';
      untouched.push({ path: resolve(checkout), reason: `outside the cache root${evidence}` });
    }
  }
  const byPath = (left: PruneCheckoutEntry, right: PruneCheckoutEntry) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason);
  const unique = (entries: PruneCheckoutEntry[]) => entries.filter((entry, index) => entries.findIndex(other => other.path === entry.path && other.reason === entry.reason) === index);
  kept.splice(0, kept.length, ...unique(kept));
  removed.splice(0, removed.length, ...unique(removed));
  untouched.splice(0, untouched.length, ...unique(untouched));
  kept.sort(byPath); removed.sort(byPath); untouched.sort(byPath);
  return { cacheRoot, apply: options.apply === true, kept, removed, untouched };
}

export function formatPruneReport(report: PruneCheckoutsReport): string {
  const lines = (label: string, entries: PruneCheckoutEntry[]) => {
    const groups = new Map<string, { count: number; bytes: number; measured: boolean }>();
    for (const entry of entries) {
      const group = groups.get(entry.reason) ?? { count: 0, bytes: 0, measured: true };
      group.count++;
      if (entry.bytes === undefined) group.measured = false;
      else group.bytes += entry.bytes;
      groups.set(entry.reason, group);
    }
    return [`${label}: ${entries.length}`, ...[...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))
      .map(([reason, group]) => `  ${group.count}  ${group.measured ? group.bytes : 'unmeasured'}  ${reason}`)];
  };
  return [`cache: ${report.cacheRoot}`, `mode: ${report.apply ? 'apply' : 'dry-run'}`,
    ...lines('kept', report.kept), ...lines('removed', report.removed), ...lines('untouched', report.untouched)].join('\n');
}

/** Discover the pinned harness, rather than copying its ever-growing gate lists into another runner. */
export async function regressionRegistry(checkout: string): Promise<ExpectedFile[]> {
  const registry = await import(pathToFileURL(join(checkout, 'scripts/qa/acceptance.ts')).href) as typeof import('../qa/acceptance.ts');
  const core = await import(pathToFileURL(join(checkout, 'scripts/qa/core.ts')).href) as typeof import('../qa/core.ts');
  const nativeFiles = new Set<string>(registry.inputSelectedNativeTests ?? []);
  const files: ExpectedFile[] = [];
  files.push({ file: jenaCliFile, tier: 'jena:check', outcome: 'pending' });
  for (const tier of ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'load'] as const) {
    const discovered = core.splitTestArgs(registry.testArgs(tier, undefined, undefined, checkout)).paths;
    const paths = tier === 'unit' || tier === 'owner'
      ? discovered.filter(file => !nativeFiles.has(file)) : discovered;
    if (tier === 'unit') paths.push(...registry.unitHarnessFiles);
    for (const file of core.expandTestPaths(checkout, paths)) files.push({ file, tier,
      outcome: tier === 'load' ? 'excluded' : 'pending', ...(tier === 'load' ? { reason: 'Opt-in load qualification' } : {}) });
  }
  files.push(...[...nativeFiles].map(file => ({ file, tier: 'jena:check' as const, outcome: 'pending' as const })));
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

async function ownerFileBudgets(checkout: string, files: readonly string[], defaultBudgetMs: number): Promise<Map<string, number>> {
  const { declaredTestTimeout, planUnitGateShards } = await loadGoalctl();
  return new Map(files.map(file => {
    let timeout: DeclaredTestTimeout = { unparseable: false };
    try {
      const path = join(checkout, file);
      if (existsSync(path)) timeout = declaredTestTimeout(readFileSync(path, 'utf8'));
    } catch { timeout = { unparseable: true }; }
    // Singleton planning reuses the gate's deadline decision without changing ordinary regression batch sizes.
    const planned = planUnitGateShards([{ file, timeout }], 1, defaultBudgetMs);
    if (planned.unparseable.length) console.log(`Regression: ${file} declared a timeout that could not be parsed; using the default per-file deadline`);
    return [file, planned.shards[0]!.budgetMs];
  }));
}

async function nightlySelection(checkout: string, files: ExpectedFile[], options: RegressionOptions): Promise<readonly VerticalJourney[]> {
  const journeys = await (options.journeyRegistry ?? (async tree =>
    (await import(pathToFileURL(join(tree, 'scripts/qa/cases/vertical-journeys.ts')).href)).verticalJourneys as readonly VerticalJourney[]))(checkout);
  for (const journey of journeys) if ('file' in journey
    && !files.some(file => file.tier === 'e2e' && file.file === journey.file && file.outcome !== 'excluded')) {
    throw new Error(`Nightly journey is absent from the runnable registry: ${journey.kind}: ${journey.file}`);
  }
  for (const file of files) {
    if (!tiers.includes(file.tier as RegressionTier) || !browserTier(file.tier as RegressionTier) || file.outcome === 'excluded') continue;
    const titles = journeys.flatMap(journey => 'file' in journey && journey.file === file.file ? [journey.test] : []);
    if (file.tier === 'e2e' && titles.length) file.tests = titles;
    else { file.outcome = 'excluded'; file.reason = nightlyBrowserReason; }
  }
  return journeys;
}

async function batchesFor(checkout: string, files: ExpectedFile[], options: RegressionOptions): Promise<Batch[]> {
  const batches: Batch[] = [];
  for (const tier of tiers) {
    const expected = files.filter(file => file.tier === tier && file.outcome !== 'excluded');
    if (!expected.length && options.nightly && browserTier(tier)) continue;
    if (!expected.length) throw new Error(`Zero-match regression tier: ${tier}`);
    if (!options.only && !options.nightly && browserTier(tier)) {
      for (const file of expected) { file.outcome = 'excluded'; file.reason = routineBrowserReason; }
      continue;
    }
    const selected = options.only?.includes(tier) ?? true;
    // An integration batch cap adds that many batches even when --only selects cheap tiers.
    // The pinned-artifact check belongs to every cycle, including a restricted test selection.
    const run = tier === 'jena:check' || selected || (tier === 'integration' && options.integrationBatches !== undefined);
    const size = batchSize(tier, expected.length);
    const defaultBudgetMs = tier === 'owner' && run ? ownerTierBudgetMs() : undefined;
    const budgets = defaultBudgetMs === undefined ? new Map<string, number>()
      : await ownerFileBudgets(checkout, expected.map(file => file.file), defaultBudgetMs);
    const nativeBudgets = tier === 'jena:check' && run
      ? await ownerFileBudgets(checkout, expected.filter(file => nativeImageProofs.has(file.file)).map(file => file.file), ownerTierBudgetMs())
      : new Map<string, number>();
    const long = expected.filter(file => (budgets.get(file.file) ?? 0) > (defaultBudgetMs ?? Infinity));
    const rest = expected.filter(file => (budgets.get(file.file) ?? 0) <= (defaultBudgetMs ?? Infinity));
    const singleton = tier === 'jena:check' || (options.nightly && tier === 'e2e');
    const groups = singleton ? expected.map(file => [file]) : long.map(file => [file]);
    if (!singleton)
      for (let index = 0; index < rest.length; index += size) groups.push(rest.slice(index, index + size));
    for (const [index, group] of groups.entries()) {
      const deferredNativeProof = tier === 'jena:check' && group.some(file => nativeImageProofs.has(file.file))
        && options.only !== undefined && !options.only.includes('jena:check');
      if (!run || deferredNativeProof
        || (tier === 'integration' && options.integrationBatches !== undefined && index >= options.integrationBatches)) {
        for (const file of group) { file.outcome = 'deferred'; file.reason = 'Restricted regression selection'; }
      } else {
        const budgetMs = tier === 'owner' && defaultBudgetMs !== undefined
          ? Math.max(defaultBudgetMs, ...group.map(file => budgets.get(file.file) ?? defaultBudgetMs))
          : group.length === 1 ? nativeBudgets.get(group[0]!.file) : undefined;
        batches.push({ id: `${tier.replaceAll(/[:/]/g, '-')}-${index + 1}`, tier,
          files: group.map(file => file.file), state: 'pending', attempts: [],
          ...(group[0]?.tests ? { tests: group[0].tests } : {}),
          ...(budgetMs === undefined ? {} : { budgetMs }) });
      }
    }
  }
  return batches;
}

function runtimeLines(evidence: string): string[] {
  // Bun prints nearby source branches even when they did not execute; their error literals are not runtime evidence.
  // Nor is a test's title: a passing case named "classifies ECONNREFUSED as Docker failure" voided its whole
  // batch as an infrastructure failure in every run from 2026-10-09 to 2026-10-12.
  return evidence.split('\n').filter(line => line.trim() && !/^\s*\d+\s*\||^\((?:pass|fail|skip|todo)\) |\bkernel:|\bclocksource:/i.test(line));
}

const timeoutLine = (line: string): boolean => !/failed or exceeded/i.test(line)
  && /exceeded[^\n]*(?:budget|deadline)|timed out|ETIMEDOUT|deadline exceeded|admission deadline reached|reached its run deadline|heavy QA lock stayed held|No QA slot became free/i.test(line);

export function regressionFailureCause(evidence: string, code = 1): string {
  const lines = runtimeLines(evidence);
  return (lines.find(timeoutLine)
    ?? lines.find(line => /\b(?:\w*Error|error):|Error response from daemon:/i.test(line) && !/failed or exceeded/i.test(line))
    ?? lines[0] ?? `Batch runner exited ${code}`).trim().slice(0, 500);
}

export function classify(evidence: string, code = 1): Classification {
  const lines = runtimeLines(evidence);
  if (lines.some(timeoutLine)) return 'deadline';
  const runtime = regressionFailureCause(evidence, code);
  if (/cannot connect to the docker daemon|failed to connect to (?:the )?docker (?:daemon|API)|docker.*ECONNREFUSED|ECONNREFUSED.*(?:docker|237[56])|(?:docker\.sock|dockerDesktopLinuxEngine)[^\n]*(?:connection refused|no such file|cannot find)|is the docker daemon running|mounts denied|is not shared from the host and is not known to Docker|all predefined address pools|no available.*address pool|could not find an available, non-overlapping.*address pool|network pool exhausted|oom-kill|Out of memory: Killed process/i.test(runtime)) return 'infrastructure';
  if (code === 137 || /heap out of memory|SIGKILL|resource exhausted|ENOMEM/.test(runtime)) return 'resource';
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

const hangReason = (log: string) => `Hung until the tier deadline; ${log}`;

function continuationId(batches: readonly Batch[], parent: string): string {
  const used = new Set(batches.map(batch => batch.id));
  let id = `${parent}-rest`;
  let n = 2;
  while (used.has(id)) id = `${parent}-rest-${n++}`;
  return id;
}

function tierDeadlineLog(batch: Batch, result: Execution): { text: string; path: string } | undefined {
  if (result.classification !== 'deadline') return undefined;
  const name = `${batch.tier.replaceAll('/', '-')}.log`;
  for (const root of result.artifactPaths) {
    for (const path of [join(root, 'logs', name), join(root, name)]) {
      if (existsSync(path)) return { text: readFileSync(path, 'utf8'), path };
    }
  }
  return undefined;
}

/** Keep results the tier log already printed, fail the file that was still running,
 * and return the files that never started so they can run without it. */
function attributeDeadlineHang(batch: Batch, result: Execution): string[] {
  const log = tierDeadlineLog(batch, result);
  if (!log) return [];
  const hung = hungTestFile(log.text, batch.files);
  if (!hung.file) return [];
  for (const [file, outcome] of Object.entries(hung.completed)) {
    if (outcome === 'failed' || result.outcomes[file] !== 'failed') result.outcomes[file] = outcome;
  }
  result.outcomes[hung.file] = 'failed';
  result.hang = { file: hung.file, log: log.path };
  const later = new Set(hung.after);
  for (const file of hung.after) delete result.outcomes[file];
  const moved = batch.files.filter(file => later.has(file));
  batch.files = batch.files.filter(file => !later.has(file));
  return moved;
}

async function command(checkout: string, args: string[], logPath: string, timeoutMs = 7 * 3_600_000,
  env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const temporary = diskDirectory(join(checkout, '.temp/tmp'), 'subprocess TMPDIR');
  diskDirectory(dirname(logPath), 'log directory');
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w', 0o600);
  // A direct test run, also when it is wrapped in the slot and memory admission: the reaper preload is
  // what marks it, and its containers must carry this batch's scope.
  const bunTest = args.some((arg, index) => arg === 'test' && args[index - 1] === 'bun'
    && args.slice(index + 1).some(option => option.startsWith('--preload=') && option.endsWith('container-reaper.ts')));
  const commandEnvironment = bunTest
    ? reapChildEnvironment({ ...env, REZICS_REAP_PRELOAD: '1' })
    : env;
  const scope = bunTest ? commandEnvironment.REZICS_REAP_SCOPE : undefined;
  noteChildScope(scope);
  try {
    const child = spawn(args[0]!, args.slice(1), { cwd: checkout, detached: true, stdio: ['ignore', log, log],
      env: { ...commandEnvironment, TMPDIR: temporary } });
    const exited = new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', code => done(code ?? 1));
    });
    let stopping: Promise<void> | undefined;
    const stopChild = () => {
      if (!child.pid) return;
      stopping ??= terminateProcessGroup(child.pid, { graceMs: defaultStopGraceMs });
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
    const forward = () => { stopChild(); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    try {
      const code = await exited;
      if (stopping) await stopping;
      if (timedOut) appendFileSync(logPath, '\nCommand deadline exceeded\n');
      return timedOut ? 124 : code;
    }
    finally { clearTimeout(timer); process.off('SIGINT', forward); process.off('SIGTERM', forward); }
  } finally {
    if (scope) {
      try { reapChildScope(commandEnvironment); } catch { /* command status still stands */ }
      settleReap();
      try { reapChildScope(commandEnvironment); } catch { /* command status still stands */ }
    }
    forgetChildScope(scope);
    closeSync(log);
  }
}

async function prepareCheckout(checkout: string, logs: string) {
  const taskfile = ['Taskfile.yml', 'Taskfile.yaml'].map(file => join(checkout, file)).find(file => existsSync(file));
  // Task searches ancestors by default; an unsupported old snapshot must not run another checkout's tasks.
  if (!taskfile) return { ok: false, artifactPaths: [], reason: 'Pinned checkout has no Taskfile' };
  const installLog = join(logs, 'install.log');
  const generatedLog = join(logs, 'generated.log');
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
  const testOutcome = (file: string): 'passed' | 'failed' | 'missing' => {
    const found = tests.filter(test => test.file.replace(/^\.\//, '') === file);
    if (batch.tests) {
      const named = batch.tests.map(title => found.filter(test => test.name === title || test.name.endsWith(` › ${title}`)));
      if (named.some(results => results.some(test => test.failed))) return 'failed';
      return found.length === batch.tests.length && named.every(results => results.length === 1 && !results[0]!.skipped) ? 'passed' : 'missing';
    }
    return found.some(test => test.name === UNEXECUTED_FILE_TEST) ? 'missing'
      : found.some(test => test.failed) ? 'failed'
      : found.some(test => !test.skipped) ? 'passed' : 'missing';
  };
  if (batch.tier === 'jena:check') return Object.fromEntries(batch.files.map(file => [file,
    file === jenaCliFile ? commandCode === undefined ? 'missing' : commandCode === 0 ? 'passed' : 'failed'
      : commandCode !== undefined && commandCode !== 0 ? 'failed' : testOutcome(file)]));
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
    outcomes[file] = file.includes('.stories.') ? stories.get(file) ?? 'missing'
      : testOutcome(file);
  }
  return outcomes;
}

export function regressionBatchCommand(batch: Batch, report: string, junitXmlPath: string): string[] {
  if (batch.tier === 'jena:check') return batch.files.some(file => nativeImageProofs.has(file))
    // Native proofs build an image and run Maven. They take a QA slot and host memory like any other
    // heavy command, so they wait when the host is full instead of starting beside it.
    ? ['bun', join(import.meta.dir, 'goalctl.ts'), 'slot', '--',
      'bun', join(import.meta.dir, '../qa/host-admission.ts'), '--gib', String(BUILD_ADMISSION_GIB), '--',
      'bun', 'test', `--preload=${join(import.meta.dir, '../qa/container-reaper.ts')}`,
      '--reporter=junit', `--reporter-outfile=${junitXmlPath}`, ...batch.files]
    : ['task', 'jena:check'];
  const standaloneStories = batch.files.every(file => file.includes('.stories.'));
  const args = standaloneStories ? [...batch.files, '--reporter=junit', `--outputFile=${junitXmlPath}`]
    : ['--tier', batch.tier, ...batch.files.filter(file => !file.includes('.stories.')).flatMap(file => ['--file', file]),
      ...(batch.tier === 'e2e' && batch.files.some(file => file.includes('.stories.')) ? ['--storybook'] : [])];
  return ['bun', join(import.meta.dir, 'goalctl.ts'), 'test', ...(browserTier(batch.tier) ? ['--heavy'] : []),
    '--result-file', report, ...args];
}

export function regressionBatchEnvironment(env: NodeJS.ProcessEnv, shards: number, slotLimit: number, artifactRoot?: string, ownerBudgetMs?: number,
  tests?: readonly string[]): NodeJS.ProcessEnv {
  return { ...env, REZICS_QA_SHARDS: String(shards), GOAL_QA_SLOTS: String(slotLimit),
    ...(tests ? { REZICS_E2E_GREP: verticalJourneyFilter(tests), REZICS_E2E_PROJECTS: 'desktop-chrome',
      // Several verticals share a file and its seed; the ordinary file allowance cannot cover all their journeys.
      REZICS_E2E_PLAYWRIGHT_BUDGET_MS: String(Math.max(Number(env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS ?? 300_000),
        Math.min(1_800_000, tests.length * 300_000))) } : {}),
    ...(ownerBudgetMs === undefined ? {} : { REZICS_QA_OWNER_BUDGET_MS: String(ownerBudgetMs) }),
    ...(artifactRoot ? { REZICS_QA_ARTIFACT_ROOT: artifactRoot } : {}) };
}

function moveDirectory(from: string, to: string): void {
  try { renameSync(from, to); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') throw error;
    filesystem.cpSync(from, to, { recursive: true });
    filesystem.rmSync(from, { recursive: true });
  }
}

/** Paths slot.json reported: those already under this batch's artifact root, or directories it reported elsewhere after they move there.
 * Older checkouts ignore the artifact-root override and write `<checkout>/.artifacts/qa/<id>`. An empty report stays empty, so a rerun does not read a stale run left in the root. */
export function regressionBatchArtifactPaths(reported: readonly string[], artifactRoot?: string): string[] {
  if (!artifactRoot) return [...reported];
  const root = resolve(artifactRoot);
  const inside = (path: string) => { const resolved = resolve(path); return resolved === root || resolved.startsWith(`${root}/`); };
  const named = reported.filter(inside);
  if (named.length) return named;
  const moved: string[] = [];
  for (const path of reported) {
    if (!existsSync(path) || !filesystem.lstatSync(path).isDirectory() || inside(path)) continue;
    mkdirSync(root, { recursive: true });
    let destination = join(root, basename(path));
    for (let suffix = 2; existsSync(destination); suffix++) destination = join(root, `${basename(path)}-${suffix}`);
    moveDirectory(path, destination);
    moved.push(destination);
  }
  return moved;
}

/** A shorter deadline cap lets the harness prove timeout cleanup without extending tier budgets. */
export interface RegressionBatchOptions { deadlineCapMs?: number }

export async function runBatch(checkout: string, batch: Batch, directory: string, shards: number, slotLimit: number,
  artifactRoot?: string, options: RegressionBatchOptions = {}): Promise<Execution> {
  mkdirSync(directory, { recursive: true });
  const report = join(directory, 'slot.json');
  const junitXmlPath = join(directory, 'batch.xml');
  const started = Date.now();
  const nativeProof = batch.tier === 'jena:check' && batch.files.some(file => nativeImageProofs.has(file));
  // Older resumed manifests have no budget; derive it from their pinned files while preserving their plan.
  const budgetMs = batch.tier === 'owner' ? batch.budgetMs
    ?? Math.max(ownerTierBudgetMs(), ...(await ownerFileBudgets(checkout, batch.files, ownerTierBudgetMs())).values())
    : nativeProof ? batch.budgetMs
      ?? Math.max(ownerTierBudgetMs(), ...(await ownerFileBudgets(checkout, batch.files, ownerTierBudgetMs())).values())
      : undefined;
  const deadlineMs = batch.tier === 'jena:check' ? Math.max(jenaCheckDefaultBudgetMs, budgetMs ?? 0)
    : Math.max(7 * 3_600_000, budgetMs ?? 0);
  if (options.deadlineCapMs !== undefined && (!Number.isSafeInteger(options.deadlineCapMs) || options.deadlineCapMs < 1)) {
    throw new Error('Regression batch deadline cap must be a positive integer');
  }
  const effectiveDeadlineMs = options.deadlineCapMs === undefined
    ? deadlineMs : Math.min(deadlineMs, options.deadlineCapMs);
  // Slot acquisition has one hour; memory admission has its own bounded wait. Neither is proof time.
  const outerDeadlineMs = nativeProof ? effectiveDeadlineMs + 3_600_000
    + Math.max(0, qaMemoryDeadline(process.env) - started) + defaultStopGraceMs : effectiveDeadlineMs;
  const env = regressionBatchEnvironment(process.env, shards, slotLimit, artifactRoot, budgetMs, batch.tests);
  if (nativeProof) env[admittedCommandBudgetEnv] = String(effectiveDeadlineMs);
  const code = await command(checkout, regressionBatchCommand(batch, report, junitXmlPath), join(directory, 'runner.log'),
    outerDeadlineMs, env);
  const metadata = existsSync(report) ? json<Execution>(report) : { queueMs: 0, testMs: Date.now() - started, totalMs: Date.now() - started, artifactPaths: [] };
  const artifactPaths = regressionBatchArtifactPaths(metadata.artifactPaths, artifactRoot);
  const tests: TestResult[] = [];
  let evidence = readFileSync(join(directory, 'runner.log'), 'utf8');
  let storyLog = '';
  const isolated: { file: string; status: string }[] = [];
  for (const path of artifactPaths) {
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
  if (batch.tier === 'jena:check' && batch.files.some(file => nativeImageProofs.has(file)) && existsSync(junitXmlPath)) {
    tests.push(...parseJUnit(readFileSync(junitXmlPath, 'utf8'), 'owner', { root: checkout }));
  }
  const storyXml = batch.tier !== 'jena:check' && existsSync(junitXmlPath) ? readFileSync(junitXmlPath, 'utf8') : '';
  const outcomes = executionOutcomes(checkout, batch, tests, storyXml, storyLog, code);
  for (const entry of isolated.filter(entry => entry.status === 'order-dependent')) outcomes[entry.file] = 'failed';
  return { ...metadata, code, outcomes, evidence,
    classification: isolated.some(entry => entry.status === 'infrastructure-dependent') ? 'infrastructure' : code ? classify(evidence, code) : undefined,
    artifactPaths: [directory, ...artifactPaths], failingTests: tests.filter(test => test.failed && test.name !== UNEXECUTED_FILE_TEST)
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

/** Diagnosis wall clock for one regression run. An empty value keeps the two-hour default. */
export function regressionDiagnosisBudgetMs(configured: string | undefined = process.env.GOAL_REGRESS_DIAGNOSIS_BUDGET_MS): number {
  if (configured === undefined || configured === '') return 2 * 3_600_000;
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(Number(configured))) {
    throw new Error('GOAL_REGRESS_DIAGNOSIS_BUDGET_MS must be a non-negative integer');
  }
  return Number(configured);
}

function regressionManifestPath(stateDir: string, runId: string): string {
  return join(stateDir, 'regress', runId, 'manifest.json');
}

function readRegressionManifest(stateDir: string, runId: string): Manifest | undefined {
  const path = regressionManifestPath(stateDir, runId);
  return existsSync(path) ? json<Manifest>(path) : undefined;
}

function fileOutcomes(manifest: Manifest): { failed: Set<string>; passed: Set<string> } {
  const failed = new Set(manifest.files.filter(file => file.outcome === 'failed').map(file => file.file));
  const passed = new Set(manifest.files.filter(file => file.outcome === 'passed' && !failed.has(file.file)).map(file => file.file));
  return { failed, passed };
}

function sortedFiles(files: Iterable<string>): string[] {
  return [...files].sort((left, right) => left.localeCompare(right));
}

function compareWithEarlierRun(current: Manifest, earlier: Manifest): RegressionComparison {
  const previous = fileOutcomes(earlier);
  const present = fileOutcomes(current);
  return {
    earlierRunId: earlier.runId,
    new: sortedFiles([...present.failed].filter(file => !previous.failed.has(file))),
    inherited: sortedFiles([...present.failed].filter(file => previous.failed.has(file))),
    fixed: sortedFiles([...previous.failed].filter(file => present.passed.has(file))),
  };
}

export function comparisonReport(comparison: RegressionComparison): string[] {
  return [
    `Since ${comparison.earlierRunId}: ${comparison.new.length} new, ${comparison.inherited.length} inherited, ${comparison.fixed.length} fixed`,
    ...comparison.new.map(file => `new: ${file}`),
    ...comparison.inherited.map(file => `inherited: ${file}`),
    ...comparison.fixed.map(file => `fixed: ${file}`),
  ];
}

/** Closest finished run on `pinned`'s first-parent history whose build succeeded.
 * A later execution of an older commit stays behind that nearer result, so known failures are not bisected back across it. */
function earlierRegressionRun(repo: string, stateDir: string, pinned: string, currentRunId: string): Manifest | undefined {
  const directory = join(stateDir, 'regress');
  if (!existsSync(directory)) return undefined;
  const runs: Manifest[] = [];
  for (const name of readdirSync(directory)) {
    if (name === currentRunId) continue;
    const manifest = readRegressionManifest(stateDir, name);
    if (!manifest?.finishedAt || manifest.status === 'running' || !manifest.preflight?.ok || !manifest.atCommit) continue;
    if (!ancestor(repo, manifest.atCommit, pinned)) continue;
    runs.push(manifest);
  }
  if (!runs.length) return undefined;
  const index = new Map(git(repo, ['rev-list', '--first-parent', pinned]).split('\n').filter(Boolean)
    .map((commit, position) => [commit, position]));
  return runs.reduce((best, candidate) => closerRegressionRun(repo, index, best, candidate));
}

function closerRegressionRun(repo: string, index: Map<string, number>, best: Manifest, candidate: Manifest): Manifest {
  const bestIndex = index.get(best.atCommit);
  const candidateIndex = index.get(candidate.atCommit);
  if (bestIndex !== undefined && candidateIndex !== undefined) {
    if (bestIndex !== candidateIndex) return candidateIndex < bestIndex ? candidate : best;
    return candidate.startedAt > best.startedAt ? candidate : best;
  }
  if (candidateIndex !== undefined) return candidate;
  if (bestIndex !== undefined) return best;
  if (best.atCommit !== candidate.atCommit) {
    if (ancestor(repo, best.atCommit, candidate.atCommit)) return candidate;
    if (ancestor(repo, candidate.atCommit, best.atCommit)) return best;
  }
  return candidate.startedAt > best.startedAt ? candidate : best;
}

function recordedDiagnosis(diagnosis: Diagnosis): RecordedDiagnosis {
  const recorded: RecordedDiagnosis = { status: diagnosis.status, classification: diagnosis.classification, after: diagnosis.after };
  if (diagnosis.before) recorded.before = diagnosis.before;
  if (diagnosis.goal) recorded.goal = diagnosis.goal;
  if (diagnosis.taskIds) recorded.taskIds = diagnosis.taskIds;
  if (diagnosis.reason) recorded.reason = diagnosis.reason;
  return recorded;
}

function inheritedFailure(file: string, earlier: Manifest, initial: Execution, pinned: string, artifactPaths: string[]): Diagnosis {
  const prior = earlier.diagnoses.find(item => item.file === file);
  const diagnosis: Diagnosis = {
    file, status: 'inherited', classification: prior?.classification ?? initial.classification ?? 'deterministic',
    before: prior?.before, after: prior?.after ?? pinned, goal: prior?.goal, taskIds: prior?.taskIds, probes: [],
    artifactPaths: [...artifactPaths], reason: prior?.reason ?? `Failed in ${earlier.runId}`, earlierRunId: earlier.runId,
  };
  if (prior) diagnosis.earlierDiagnosis = recordedDiagnosis(prior);
  return diagnosis;
}

function undiagnosedFailure(file: string, initial: Execution, pinned: string, artifactPaths: string[]): Diagnosis {
  return {
    file, status: 'undiagnosed', classification: initial.classification ?? 'deterministic', after: pinned, probes: [],
    artifactPaths: [...artifactPaths], reason: 'budget',
  };
}

function diagnosisReport(item: Diagnosis): string {
  const status = item.status === 'undiagnosed' ? `undiagnosed: ${item.reason ?? 'budget'}` : `${item.status}, ${item.classification}`;
  const reason = item.status === 'undiagnosed' ? '' : item.reason ?? '';
  const earlier = item.earlierRunId ? ` earlier run ${item.earlierRunId}` : '';
  return `${item.file}: ${status}; ${item.before ?? '?'}..${item.after}; ${item.goal ?? 'program'} ${item.taskIds?.join(', ') ?? ''}; ${reason}${earlier}`;
}

export async function runRegression(options: RegressionOptions): Promise<Manifest> {
  const { repo, stateDir } = options;
  const configuredSlots = options.slots ?? Number(process.env.GOAL_QA_SLOTS ?? 3);
  if (!Number.isSafeInteger(configuredSlots) || configuredSlots < 1) throw new Error('GOAL_QA_SLOTS must be a positive integer');
  const diagnosisBudget = options.diagnosisBudgetMs !== undefined
    ? regressionDiagnosisBudgetMs(String(options.diagnosisBudgetMs)) : regressionDiagnosisBudgetMs();
  const slotLimit = Math.min(configuredSlots, 2);
  const laneLimit = regressionLaneLimit(stateDir, slotLimit);
  // A batch leases only the host slots numbered below the count it is given. With six lanes and a count of
  // two, four lanes waited for the same two slots.
  const batchSlots = Math.max(slotLimit, laneLimit);
  const runner = options.runner ?? runBatch;
  const runId = options.resume ?? options.runId ?? newRunId();
  if (!validId(runId)) throw new Error('Invalid regression run ID');
  const directory = diskDirectory(join(stateDir, 'regress', runId), 'report directory');
  const prepare = options.prepare ?? ((checkout: string) => prepareCheckout(checkout, join(directory, 'preflight', basename(checkout))));
  const lock = join(directory, 'lock');
  const acquired = tryAcquireDirectoryLease(lock);
  if (acquired === 'held') throw new Error(`Regression ${runId} is already running`);
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let manifest: Manifest | undefined;
  let treeMapPath: string | undefined;
  let worktrees = '';
  let legacyRoot = '';
  let physicalLegacyRoot = '';
  let legacyOwned = false;
  const rejectResume = (message: string): never => { throw new Error(message); };
  try {
    const path = join(directory, 'manifest.json');
    const pinned = options.resume ? json<Manifest>(path).atCommit : git(repo, ['rev-parse', '--verify', `${options.at ?? 'main'}^{commit}`]);
    if (options.resume && options.at && git(repo, ['rev-parse', `${options.at}^{commit}`]) !== pinned) throw new Error('Resume revision differs from the pinned commit');
    worktrees = regressionCheckoutRoot(repo, options.checkoutRoot);
    legacyRoot = resolve(options.legacyRoot ?? join(repo, '.temp/regress'));
    physicalLegacyRoot = physicalPath(legacyRoot);
    legacyOwned = within(realpathSync(repo), physicalLegacyRoot) || within(worktrees, physicalLegacyRoot);
    treeMapPath = join(directory, 'checkouts.json');
    const checkoutMapPath = treeMapPath;
    const treeMap = existsSync(checkoutMapPath) ? json<Record<string, string>>(checkoutMapPath) : {};
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
          checkout = candidate; treeMap[key] = checkout; atomic(checkoutMapPath, treeMap);
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
      if (manifest.selection === 'nightly') {
        const journeys = await nightlySelection(checkout, expected, options);
        if (JSON.stringify(journeys) !== JSON.stringify(manifest.verticalJourneys)
          || manifest.files.some(file => JSON.stringify(file.tests) !== JSON.stringify(expected.find(item => item.tier === file.tier && item.file === file.file)?.tests))
          || manifest.batches.some(batch => batch.tier === 'e2e' && (batch.files.length !== 1
            || JSON.stringify(batch.tests) !== JSON.stringify(expected.find(file => file.tier === 'e2e' && file.file === batch.files[0])?.tests)))) {
          rejectResume('Incomplete or changed nightly journey selection');
        }
      }
      const identities = (files: ExpectedFile[]) => files.map(file => `${file.tier}:${file.file}`).sort().join('\n');
      if (identities(expected) !== identities(manifest.files)) rejectResume('Incomplete or changed regression manifest');
      const exclusions = new Map(expected.filter(file => file.outcome === 'excluded').map(file => [`${file.tier}:${file.file}`, file.reason]));
      if (manifest.selection === 'routine') for (const file of expected) {
        if (file.outcome !== 'excluded' && tiers.includes(file.tier as RegressionTier) && browserTier(file.tier as RegressionTier)) {
          exclusions.set(`${file.tier}:${file.file}`, routineBrowserReason);
        }
      }
      if (manifest.files.some(file => (file.outcome === 'excluded') !== exclusions.has(`${file.tier}:${file.file}`)
        || (file.outcome === 'excluded' && file.reason !== exclusions.get(`${file.tier}:${file.file}`)))) {
        rejectResume('Incomplete or changed regression exclusions');
      }
      const planned = manifest.batches.flatMap(batch => batch.files.map(file => `${batch.tier}:${file}`)).sort();
      const required = manifest.files.filter(file => file.outcome !== 'excluded' && file.outcome !== 'deferred')
        .map(file => `${file.tier}:${file.file}`).sort();
      // Older runs used fifteen-file integration batches; resume preserves their original plan.
      if (planned.join('\n') !== required.join('\n') || new Set(planned).size !== planned.length
        || manifest.batches.some(batch => !batch.files.length || (batch.tier === 'integration' && batch.files.length > 15))) {
        rejectResume('Incomplete regression batch plan');
      }
    } else {
      if (existsSync(path)) throw new Error(`Regression ${runId} already exists; use --resume`);
      const files = await (options.registry ?? regressionRegistry)(checkout);
      const journeys = options.nightly ? await nightlySelection(checkout, files, options) : undefined;
      if (new Set(files.map(file => `${file.tier}:${file.file}`)).size !== files.length) throw new Error('Duplicate regression manifest files');
      const batches = await batchesFor(checkout, files, options);
      const shards = options.shards ?? Number(process.env.REZICS_QA_SHARDS ?? 1);
      if (!Number.isSafeInteger(shards) || shards < 1) throw new Error('REZICS_QA_SHARDS must be a positive integer');
      manifest = { version: 1, runId, atCommit: pinned, checkout, startedAt: new Date().toISOString(), shards,
        selection: options.nightly ? 'nightly' : options.only ? 'explicit' : 'routine',
        ...(journeys ? { verticalJourneys: journeys } : {}),
        partial: files.some(file => file.outcome === 'deferred'), status: 'running', files, batches,
        preflight: { commit: pinned, ok: false, artifactPaths: [], reason: 'Pinned preflight pending' }, diagnoses: [] };
    }
    if (!manifest) throw new Error('Regression manifest was not recorded');
    const runManifest = manifest;
    const save = () => atomic(path, runManifest);
    runManifest.probeCounts ??= {};
    runManifest.diagnosisSpentMs ??= 0;
    save();
    // Persist the SHA and selection before installation, so a stop during preparation can resume that exact revision.
    await checkoutAt(pinned);
    runManifest.preflight = prepared.get(pinned)!; save();
    const execute = async (commit: string, batch: Batch, label: string, probeTree?: string): Promise<Execution> => {
      const tree = probeTree ?? await checkoutAt(commit);
      // Reports may use GOAL_REGRESS_STATE_DIR, but admission always observes goalctl's shared host lock.
      if (browserTier(batch.tier) && options.waitForTurn) await options.waitForTurn(undefined, () => interrupted);
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      const result = await runner(tree, batch, join(directory, label), runManifest.shards, batchSlots, regressionBatchQaDirectory(directory, label));
      if (interrupted) throw new Error(`Regression ${runId} interrupted; use --resume`);
      result.classification ??= result.code ? classify(result.evidence ?? '', result.code) : undefined;
      if (result.code && result.classification) {
        // Keep the runtime cause when checkpoints discard the unabridged log evidence.
        result.cause ??= regressionFailureCause(result.evidence ?? '', result.code);
      }
      if (git(tree, ['rev-parse', 'HEAD']) !== commit || git(tree, ['status', '--porcelain'])) throw new Error(`Source changed during regression: ${tree}`);
      return result;
    };
    let lane: Batch[] | undefined;
    const continueAfterHang = (parent: Batch, files: string[]) => {
      if (!files.length) return;
      const continuation: Batch = { id: continuationId(runManifest.batches, parent.id), tier: parent.tier, files,
        state: 'pending', attempts: [], ...(parent.budgetMs === undefined ? {} : { budgetMs: parent.budgetMs }) };
      runManifest.batches.splice(runManifest.batches.indexOf(parent) + 1, 0, continuation);
      lane?.push(continuation);
    };
    const runInitialBatch = async (batch: Batch, tree?: string): Promise<void> => {
      if (batch.state === 'done') return;
      batch.state = 'running'; save();
      // A dead engine gets one fresh queue entry, then leaves a resumable pending batch rather than a busy loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await execute(pinned, batch, `${batch.id}/attempt-${batch.attempts.length + 1}`, tree);
        const moved = attributeDeadlineHang(batch, result);
        // Logs already live at artifactPaths; keep checkpoints bounded instead of copying every stack log into them.
        batch.attempts.push({ ...result, evidence: undefined });
        const voided = result.classification === 'infrastructure';
        // Verified recovery replaces unavailable file diagnoses; the historical inbox event remains.
        if (!voided) runManifest.diagnoses = runManifest.diagnoses.filter(diagnosis => !(diagnosis.status === 'unavailable'
          && batch.files.includes(diagnosis.file) && ['passed', 'failed'].includes(result.outcomes[diagnosis.file] ?? 'missing')));
        for (const file of runManifest.files.filter(file => file.tier === batch.tier && batch.files.includes(file.file))) {
          file.outcome = voided ? 'void' : result.outcomes[file.file] ?? 'missing';
          if (!voided && result.hang?.file === file.file) file.reason = hangReason(result.hang.log);
        }
        batch.state = voided ? 'pending' : 'done';
        if (!voided && moved.length) continueAfterHang(batch, moved);
        save();
        if (!voided) break;
      }
    };
    const serialTier = (tier: RegressionTier) => tier === 'unit' || tier === 'model' || tier === 'jena:check';
    // Unit batches fit the harness's three-minute budget and run serially; stack and owner batches use measured memory admission.
    // A hang splices its remainder in front of the following batches, so the index walks that new batch too.
    for (let index = 0; index < runManifest.batches.length; index++) {
      const batch = runManifest.batches[index]!;
      if (serialTier(batch.tier)) await runInitialBatch(batch);
    }
    const pending = runManifest.batches.filter(batch => batch.state !== 'done' && !browserTier(batch.tier) && !serialTier(batch.tier));
    lane = pending;
    let next = 0;
    let failure: unknown;
    const workers = Array.from({ length: Math.min(laneLimit, pending.length) }, async (_, index) => {
      let tree: string | undefined;
      try {
        // Each lane has its own sockets and artifact root, reused only after its previous batch finishes.
        tree = await checkoutAt(pinned, `lane-${index}`);
        if (!preparedCheckouts.get(tree)?.ok) {
          runManifest.preflight = preparedCheckouts.get(tree)!; save(); return;
        }
        while (!failure && next < pending.length) await runInitialBatch(pending[next++]!, tree);
      } catch (error) { failure ??= error; }
    });
    // Keep the runManifest lock until all admitted children settle, even when another lane fails.
    await Promise.all(workers);
    if (failure) throw failure;
    lane = undefined;
    for (let index = 0; index < runManifest.batches.length; index++) {
      const batch = runManifest.batches[index]!;
      if (browserTier(batch.tier)) await runInitialBatch(batch);
    }
    const eventPath = join(stateDir, 'merges.jsonl');
    const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as MergeEvent) : [];
    const route = options.route ?? (async entry => appendInbox(stateDir, entry));
    const routeBatchFailure = async (batch: Batch, result: Execution, fallback?: string) => {
      const cause = result.cause ?? fallback ?? `Batch runner ended with ${result.classification ?? 'deterministic'} (exit ${result.code})`;
      const diagnosis: Diagnosis = { file: `batch:${batch.id}`, status: 'unavailable', classification: result.classification ?? 'deterministic',
        after: pinned, probes: [], artifactPaths: result.artifactPaths, reason: `${batch.id}: ${batch.files.length} files; ${cause}` };
      if (runManifest.diagnoses.some(item => item.file === diagnosis.file)) return;
      await route({ runId, atCommit: pinned, failingTests: [diagnosis.file], after: pinned, goal: 'program', taskIds: [],
        status: diagnosis.status, classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths,
        runEvent: { batchId: batch.id, tier: batch.tier, fileCount: batch.files.length, cause } });
      runManifest.diagnoses.push(diagnosis); save();
    };
    const routeFileFailure = async (file: string, initial: Execution, diagnosis: Diagnosis) => {
      diagnosis.artifactPaths = [...new Set(diagnosis.artifactPaths)];
      const failingTests = initial.failingTests?.filter(test => test.startsWith(`${file}:`) && !test.endsWith(`: ${UNEXECUTED_FILE_TEST}`)) ?? [];
      // Route before checkpointing; append is idempotent if interruption falls between the writes.
      await route({ runId, atCommit: pinned, failingTests: failingTests.length ? failingTests : [file], before: diagnosis.before,
      after: diagnosis.after, goal: diagnosis.goal ?? 'program', taskIds: diagnosis.taskIds ?? [], status: diagnosis.status,
      classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths });
      runManifest.diagnoses.push(diagnosis); save();
    };
    // The budget starts when diagnosis starts. The preceding execution is not part of it.
    const clock = options.now ?? Date.now;
    let diagnosisMark = clock();
    const chargeDiagnosis = () => {
      const current = clock();
      runManifest.diagnosisSpentMs = (runManifest.diagnosisSpentMs ?? 0) + Math.max(0, current - diagnosisMark);
      diagnosisMark = current;
    };
    if (!runManifest.baselineRunId) {
      const selected = earlierRegressionRun(repo, stateDir, pinned, runId);
      if (selected) { runManifest.baselineRunId = selected.runId; save(); }
    }
    const earlierRun = runManifest.baselineRunId ? readRegressionManifest(stateDir, runManifest.baselineRunId) : undefined;
    const earlierOutcomes = earlierRun ? fileOutcomes(earlierRun) : undefined;
    const failedNow = (batch: Batch, file: string) => runManifest.files.some(item =>
      item.tier === batch.tier && item.file === file && item.outcome === 'failed');
    const retainUnavailableAssertions = async (batch: Batch, initial: Execution, artifactPaths: string[], reason: string) => {
      for (const file of assertionFiles(batch, initial)) {
        if (runManifest.diagnoses.some(item => item.file === file)) continue;
        await routeFileFailure(file, initial, { file, status: 'unavailable',
          classification: initial.classification === 'infrastructure' ? 'deterministic' : initial.classification ?? 'deterministic',
          after: pinned, probes: [], artifactPaths: [...initial.artifactPaths, ...artifactPaths], reason });
      }
    };
    for (const batch of runManifest.batches.filter(batch => batch.attempts.length > 0)) {
      const initial = batch.attempts.at(-1)!;
      const hang = initial.hang;
      // A timeout that names the file still running is that file's failure. Startup and
      // admission, which print no file header, stay a deadline for the whole batch.
      if (hang && !runManifest.diagnoses.some(item => item.file === hang.file)) {
        await routeFileFailure(hang.file, initial, { file: hang.file, status: 'unavailable', classification: 'deadline',
          after: pinned, probes: [], artifactPaths: [...new Set([...initial.artifactPaths, hang.log])],
          reason: hangReason(hang.log) });
      }
      let failing = batch.files.filter(file => initial.outcomes[file] !== 'passed' && file !== hang?.file);
      if (batchRunFailure(batch, initial) && !hang) {
        await routeBatchFailure(batch, initial);
      }
      if (runManifest.diagnoses.some(item => item.file === `batch:${batch.id}`)) {
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
      if (!failing.length && initial.code && !hang) {
        await routeBatchFailure(batch, initial, 'Batch runner failed despite passing file evidence');
      }
      let repeatBatch: Execution | undefined;
      const runnable = hang ? { ...batch, files: batch.files.filter(file => file !== hang.file) } : batch;
      for (const file of failing) {
        if (runManifest.diagnoses.some(item => item.file === file)) continue;
        chargeDiagnosis();
        // A failure already present in the baseline needs no confirmation, isolation or bisect,
        // and no second inbox entry: its owner has it from the run that first saw it.
        if (earlierRun && earlierOutcomes?.failed.has(file) && failedNow(batch, file)) {
          runManifest.diagnoses.push(inheritedFailure(file, earlierRun, initial, pinned, [...new Set(initial.artifactPaths)])); save();
          continue;
        }
        if ((runManifest.diagnosisSpentMs ?? 0) >= diagnosisBudget) {
          await routeFileFailure(file, initial, undiagnosedFailure(file, initial, pinned, [...initial.artifactPaths]));
          continue;
        }
        const diagnosis: Diagnosis = { file, status: 'inconclusive', classification: initial.classification ?? 'deterministic',
          after: pinned, probes: [], artifactPaths: [...initial.artifactPaths] };
        repeatBatch ??= await execute(pinned, runnable, `${batch.id}/confirm`);
        const repeat = repeatBatch;
        diagnosis.artifactPaths.push(...repeat.artifactPaths);
        if (batchRunFailure(batch, repeat)) {
          await routeBatchFailure(batch, repeat);
          // Retain every initial assertion before infrastructure recovery leaves this batch pending.
          await retainUnavailableAssertions(batch, initial, repeat.artifactPaths, 'Batch confirmation unavailable');
          if (repeat.classification === 'infrastructure') {
            batch.state = 'pending';
            for (const expected of runManifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
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
          for (const expected of runManifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
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
            const count = runManifest.probeCounts![file] ?? 0;
            if (count >= 8) return undefined;
            runManifest.probeCounts![file] = count + 1; save();
            return count + 1;
          };
          // The baseline already passed this file at the pinned commit, so older history cannot explain it.
          if (earlierRun && earlierOutcomes?.passed.has(file) && earlierRun.atCommit === pinned) {
            diagnosis.status = 'inconclusive';
            diagnosis.reason = `Passed in ${earlierRun.runId} at this commit`;
            diagnosis.earlierRunId = earlierRun.runId;
          } else {
            const lowerBound = earlierRun && earlierOutcomes?.passed.has(file) ? earlierRun.atCommit : undefined;
            await bisectFailure(repo, stateDir, pinned, file, alone, events, diagnosis, checkoutAt, prepared, execute, takeProbe, lowerBound);
          }
        }
        if (diagnosis.classification === 'infrastructure') {
          await routeBatchFailure(batch, { ...initial, classification: 'infrastructure', cause: diagnosis.reason,
            artifactPaths: diagnosis.artifactPaths });
          await retainUnavailableAssertions(batch, initial, diagnosis.artifactPaths, 'Regression probe unavailable');
          batch.state = 'pending';
          for (const expected of runManifest.files.filter(item => item.tier === batch.tier && batch.files.includes(item.file))) expected.outcome = 'void';
          save(); break;
        }
        await routeFileFailure(file, initial, diagnosis);
      }
    }
    if (!runManifest.preflight.ok && !runManifest.diagnoses.some(item => item.file === 'preflight')) {
      const diagnosis: Diagnosis = { file: 'preflight', status: 'unavailable', classification: 'deterministic', after: pinned,
        probes: [], artifactPaths: runManifest.preflight.artifactPaths, reason: runManifest.preflight.reason };
      await route({ runId, atCommit: pinned, failingTests: [runManifest.preflight.reason ?? 'Pinned preflight failed'], after: pinned,
        goal: 'program', taskIds: [], status: diagnosis.status, classification: diagnosis.classification, artifactPaths: diagnosis.artifactPaths });
      runManifest.diagnoses.push(diagnosis);
    }
    chargeDiagnosis();
    if (earlierRun) runManifest.comparison = compareWithEarlierRun(runManifest, earlierRun);
    const comparisonText = runManifest.comparison ? comparisonReport(runManifest.comparison) : [];
    const complete = !runManifest.partial && !runManifest.verticalJourneys?.some(journey => 'missing' in journey)
      && runManifest.batches.every(batch => batch.state === 'done' && batch.attempts.length > 0)
      && runManifest.files.every(file => file.outcome === 'passed' || file.outcome === 'excluded');
    runManifest.status = complete && runManifest.preflight.ok && !runManifest.batches.some(batch => batch.attempts.at(-1)?.code)
      ? 'passed' : runManifest.files.some(file => file.outcome === 'failed') || !runManifest.preflight.ok ? 'failed' : 'incomplete';
    runManifest.finishedAt = new Date().toISOString(); save();
    writeFileSync(join(directory, 'summary.md'), [`# Regression ${runId}`, '', `Commit: ${pinned}`,
      `Result: ${runManifest.status}; complete execution: ${complete}; shards: ${runManifest.shards}`,
      `Preflight: ${runManifest.preflight.ok ? 'passed' : runManifest.preflight.reason}`, '',
      ...comparisonText, ...(comparisonText.length ? [''] : []),
      ...runManifest.verticalJourneys?.map(journey => `${journey.kind}: ${'missing' in journey ? `missing; ${journey.missing}` : `${journey.file}: ${journey.test}`}`) ?? [],
      ...runManifest.batches.map(batch => `${batch.id}: ${batch.state}; ${batch.files.length} files; `
        + batch.attempts.map(result => `queue ${result.queueMs}ms, test ${result.testMs}ms, total ${result.totalMs}ms (${result.classification ?? 'passed'})`
          + (result.hang ? `; hung ${result.hang.file}; ${result.hang.log}` : '')).join('; ')), '',
      ...runManifest.diagnoses.map(diagnosisReport), '',
    ].join('\n'));
    if (comparisonText.length) console.log(comparisonText.join('\n'));
    return runManifest;
  } finally {
    // Resume recreates a missing checkout, so the process can drop its trees when it releases the lock.
    if (treeMapPath) {
      try {
        const map = readCheckoutMap(treeMapPath);
        if (map) removeMappedCheckouts(repo, map, worktrees, legacyRoot, physicalLegacyRoot, legacyOwned);
      } catch (error) { console.error(error instanceof Error ? error.message : error); }
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    acquired.release();
  }
}

async function bisectFailure(repo: string, stateDir: string, pinned: string, file: string, batch: Batch, events: MergeEvent[],
  diagnosis: Diagnosis, checkoutAt: (commit: string, probe?: string) => Promise<string>, prepared: Map<string, Manifest['preflight']>,
  execute: (commit: string, batch: Batch, label: string, probeTree?: string) => Promise<Execution>,
  takeProbe: () => number | undefined, lowerBound?: string): Promise<void> {
  const passing = lowerBound ?? lastPassingCommit(repo, stateDir, file, pinned);
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
