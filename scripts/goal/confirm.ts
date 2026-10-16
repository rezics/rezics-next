import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { loadSettings } from './config.ts';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath, isQaOwnerPath, UNEXECUTED_FILE_TEST } from '../qa/acceptance.ts';
import { newRunId } from '../qa/core.ts';
import { preflightRetainedSources, retainedPreflightSummary, type RetainedPreflight } from '../qa/retained-preflight.ts';
import { directoryLeaseHeld, readDirectoryLease, releaseDirectoryLease, transferDirectoryLease, tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import type { RowOutcomes } from '../qa/cases/outcome-cells.ts';
import { batchTestResults, cellReadings, confirmationCounts, confirmationRecord, confirmationSummary, latestConfirmation, recordConfirmation } from './confirmed.ts';
import { createPinnedCheckout, prepareCheckout, regressionBatchQaDirectory, regressionCheckoutRoot, runBatch,
  type Batch, type Execution, type Manifest, type RegressionOptions, type RegressionTier } from './regress.ts';

export interface ConfirmationOptions {
  repo: string;
  stateDir: string;
  checkoutRoot?: string;
  runId?: string;
  at?: string;
  lanes?: number;
  slots?: number;
  record?: string;
  outcomeRegistry?: RegressionOptions['outcomeRegistry'];
  prepare?: RegressionOptions['prepare'];
  runner?: typeof runBatch;
  retainedPreflight?: typeof preflightRetainedSources;
  /** The pump transfers its reservation to the detached child before the child starts. */
  leaseToken?: string;
  signal?: AbortSignal;
}

export const confirmationUsage = 'Usage: goalctl confirm [--at <rev>] [--lanes <n>] [--record <directory under .temp/>] | confirm --status [--run <id>]';

export function parseConfirmationArgs(args: string[]): { at?: string; lanes?: number; record?: string; status?: boolean; run?: string } {
  const options: ReturnType<typeof parseConfirmationArgs> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--status' && !options.status) { options.status = true; continue; }
    if (flag !== '--at' && flag !== '--lanes' && flag !== '--run' && flag !== '--record') throw new Error(confirmationUsage);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(confirmationUsage);
    if (flag === '--at' && options.at === undefined) options.at = value;
    else if (flag === '--run' && options.run === undefined) options.run = value;
    else if (flag === '--record' && options.record === undefined) options.record = value;
    else if (flag === '--lanes' && options.lanes === undefined && /^[1-9]\d*$/.test(value)
      && Number.isSafeInteger(Number(value))) options.lanes = Number(value);
    else throw new Error(confirmationUsage);
  }
  if ((options.run && !options.status) || (options.status && (options.at !== undefined || options.lanes !== undefined || options.record !== undefined)))
    throw new Error(confirmationUsage);
  if (options.run) validateRunId(options.run);
  return options;
}

interface RecordedAnswer {
  record: string;
  file: string;
  status: 'passed' | 'failed';
  attempt: string;
}

export interface ConfirmationManifest extends Manifest {
  records?: RecordedAnswer[];
  retainedSources?: RetainedPreflight;
  stopped?: ConfirmationStop;
}

type ConfirmationStop = 'preempted' | 'SIGTERM' | 'SIGINT' | 'aborted';

/** Both lexical traversal and existing symlink ancestors must stay inside this checkout's scratch space. */
function recordDirectory(repo: string, directory: string): string {
  const temp = resolve(repo, '.temp');
  const target = resolve(repo, directory);
  const inside = (path: string) => {
    const local = relative(temp, path);
    return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  };
  if (!inside(target)) throw new Error('--record must name a directory under .temp/');
  let ancestor = target;
  while (!existsSync(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('--record cannot escape through symlinks');
    ancestor = dirname(ancestor);
  }
  if ((ancestor !== resolve(repo) && ancestor !== temp && !inside(realpathSync(ancestor)))
    || (existsSync(temp) && realpathSync(temp) !== temp)) throw new Error('--record cannot escape through symlinks');
  return target;
}

function copyRecords(repo: string, source: string, target: string, prefix = ''): string[] {
  if (!existsSync(source)) return [];
  const copied: string[] = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) copied.push(...copyRecords(repo, join(source, entry.name), target, name));
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const destination = recordDirectory(repo, join(target, name));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(source, entry.name), destination);
      copied.push(destination);
    }
  }
  return copied;
}

function validateRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(runId)) throw new Error('Invalid confirmation run ID');
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function atomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function confirmationRunning(stateDir: string): boolean {
  return directoryLeaseHeld(join(stateDir, 'confirm.lock'));
}

function outcomeTier(file: string): RegressionTier {
  if (isQaE2ePath(file) || file.includes('.stories.') || isQaLoadPath(file))
    throw new Error(`Outcome confirmation cannot run browser or load files: ${file}`);
  return isQaIntegrationPath(file) ? 'integration' : isQaFaultPath(file) ? 'fault/recovery'
    : isQaModelPath(file) ? 'model' : isQaOwnerPath(file) ? 'owner' : 'unit';
}

/** A timeout is retryable only when there is no completed non-timeout failure. */
export function confirmationTimeoutOnly(manifest: Manifest, batch: Batch, result: Execution): boolean {
  if (!result.code || result.classification === 'infrastructure' || result.classification === 'resource') return false;
  const failed = batchTestResults(manifest, batch).filter(test => test.failed && test.name !== UNEXECUTED_FILE_TEST);
  if (failed.some(test => !test.timeout)) return false;
  return failed.some(test => test.timeout) || result.classification === 'deadline';
}

/** Tickets use process identities, so a dead requester cannot suppress scheduled work. */
function confirmationRequested(stateDir: string): boolean {
  const directory = join(stateDir, 'confirm-requests');
  return existsSync(directory) && readdirSync(directory).some(name => directoryLeaseHeld(join(directory, name)));
}

export async function runConfirmation(options: ConfirmationOptions): Promise<ConfirmationManifest> {
  const { stateDir } = options;
  // Validate before publishing a request or taking the shared lease.
  if (options.record !== undefined) recordDirectory(options.repo, options.record);
  const runId = options.runId ?? `confirm-${newRunId()}`;
  validateRunId(runId);
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'confirm.lock');
  const scheduled = options.leaseToken !== undefined;
  let stopped: ConfirmationStop | undefined;
  const stop = (reason: ConfirmationStop) => {
    if (stopped) return;
    stopped = reason;
    console.error(`Confirmation ${runId} stopping after active outcome batches clean up: ${reason}`);
  };
  const term = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  const abort = () => stop('aborted');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  options.signal?.addEventListener('abort', abort);
  if (options.signal?.aborted) abort();
  let request: Exclude<ReturnType<typeof tryAcquireDirectoryLease>, 'held'> | undefined;
  let token = options.leaseToken;
  try {
    if (scheduled) {
      const owner = readDirectoryLease(lock);
      if (owner?.pid !== process.pid || owner.token !== token) throw new Error('Confirmation reservation is not owned by this process');
    } else {
      const acquired = tryAcquireDirectoryLease(join(stateDir, 'confirm-requests', randomUUID()), { note: { runId } });
      if (acquired === 'held') throw new Error('Could not register confirmation request');
      request = acquired;
      for (;;) {
        if (stopped) throw new Error(`Confirmation stopped while queued: ${stopped}`);
        const acquired = tryAcquireDirectoryLease(lock, { note: { runId, command: 'confirm:requested' } });
        if (acquired !== 'held') { token = acquired.token; break; }
        await Bun.sleep(25);
      }
    }
    return await executeConfirmation({ ...options, runId }, () => {
      if (!stopped && scheduled && confirmationRequested(stateDir)) stop('preempted');
      return stopped;
    });
  } finally {
    // Retain both the reservation and the request through every lane's cleanup.
    if (token) releaseDirectoryLease(lock, token, process.pid);
    request?.release();
    process.off('SIGTERM', term);
    process.off('SIGINT', interrupt);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function executeConfirmation(options: ConfirmationOptions & { runId: string },
  stopReason: () => ConfirmationStop | undefined): Promise<ConfirmationManifest> {
  const { repo, stateDir, runId } = options;
  const recordTarget = options.record === undefined ? undefined : recordDirectory(repo, options.record);
  const startedAt = new Date().toISOString();
  let checkout: string | undefined;
  let manifest: ConfirmationManifest | undefined;
  let declarations: readonly RowOutcomes[] = [];
  let runLease: Exclude<ReturnType<typeof tryAcquireDirectoryLease>, 'held'> | undefined;
  // The format is shared, but a bounded run must not become a whole-regression baseline.
  const directory = join(stateDir, 'confirm', runId);
  const save = () => atomic(join(directory, 'manifest.json'), manifest);
  try {
    writeFileSync(join(stateDir, 'confirm-last-start'), `${startedAt}\n`);
    const main = git(repo, ['rev-parse', '--verify', 'main^{commit}']);
    const pinned = options.at === undefined ? main : git(repo, ['rev-parse', '--verify', '--end-of-options', `${options.at}^{commit}`]);
    const slots = options.slots ?? (await import('./qa-slots.ts')).qaSlotCount(join(stateDir, 'qa-slots'));
    if (!Number.isSafeInteger(slots) || slots < 1) throw new Error('GOAL_QA_SLOTS must be a positive integer');
    const lanes = options.lanes ?? Math.min(2, slots);
    if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > slots)
      throw new Error(`Confirmation lanes must be a positive integer at most the QA slot count (${slots})`);
    if (existsSync(join(directory, 'manifest.json'))) throw new Error(`Confirmation run already exists: ${runId}`);
    mkdirSync(directory, { recursive: true });
    const acquired = tryAcquireDirectoryLease(join(directory, 'lock'));
    if (acquired === 'held') throw new Error(`Confirmation ${runId} is already running`);
    runLease = acquired;
    // A separate cache prevents the regression pruner from treating a live confirmation as unowned.
    const checkoutRoot = options.checkoutRoot ?? process.env.GOAL_REGRESS_CHECKOUT_ROOT ?? `${regressionCheckoutRoot(repo)}-c`;
    checkout = createPinnedCheckout(repo, checkoutRoot, runId, `${pinned}:pinned`, pinned);
    atomic(join(directory, 'checkouts.json'), { [`${pinned}:pinned`]: checkout });
    manifest = { version: 1, runId, atCommit: pinned, checkout, startedAt, shards: 1, partial: false,
      status: 'running', files: [], batches: [], preflight: { commit: pinned, ok: false, artifactPaths: [] }, diagnoses: [],
      laneCount: lanes, ...(recordTarget ? { records: [] } : {}) };
    save();
    if (!stopReason()) manifest.preflight = { commit: pinned, ...await (options.prepare ?? (tree =>
      prepareCheckout(tree, join(directory, 'preflight'))))(checkout) };
    save();
    declarations = options.outcomeRegistry ? await options.outcomeRegistry(checkout)
      : [...(await (await import(pathToFileURL(join(checkout, 'scripts/qa/cases/outcomes.ts')).href) as
        typeof import('../qa/cases/outcomes.ts')).loadOutcomes({ root: checkout })).values()];
    // Keep the pinned declarations for status after the disposable checkout is removed.
    atomic(join(directory, 'declarations.json'), declarations);
    const files = [...new Set(declarations.flatMap(row => Object.values(row.cells)
      .flatMap(cell => cell && cell.state !== 'notApplicable' ? [cell.file!] : [])))].sort();
    manifest.files = files.map(file => ({ file, tier: outcomeTier(file), outcome: 'pending' }));
    manifest.batches = manifest.files.map((file, index) => ({ id: `outcome-${index + 1}`, tier: file.tier as RegressionTier,
      files: [file.file], state: 'pending', attempts: [] }));
    if (!stopReason()) manifest.retainedSources = await (options.retainedPreflight ?? preflightRetainedSources)(checkout, files, undefined, repo);
    if (manifest.retainedSources && !manifest.retainedSources.ok) {
      manifest.preflight.ok = false;
      manifest.preflight.reason = retainedPreflightSummary(manifest.retainedSources);
    }
    save();
    const runner = options.runner ?? runBatch;
    const execute = async (batch: Batch) => {
      batch.state = 'running'; save();
      const label = `${batch.id}/attempt-${batch.attempts.length + 1}`;
      const recordSource = recordTarget ? join('.temp', 'confirmation-records', runId, label) : undefined;
      try {
        batch.attempts.push(await runner(checkout!, batch, join(directory, label), 1, slots,
          regressionBatchQaDirectory(directory, label), { drainOnSignal: true, env: { ...process.env, REZICS_QA_RETAINED_ROOT: repo,
            ...(recordSource ? { OUTCOME_RECORD_DIR: recordSource } : {}) } }));
      } catch (error) {
        batch.attempts.push({ code: 1, outcomes: {}, artifactPaths: [], queueMs: 0, testMs: 0, totalMs: 0,
          classification: 'infrastructure', evidence: String(error) });
      }
      batch.state = 'done';
      const result = batch.attempts.at(-1)!;
      manifest!.files.find(file => file.file === batch.files[0])!.outcome = result.outcomes[batch.files[0]!] ?? 'missing';
      if (recordTarget && recordSource) {
        const cells = confirmationRecord(manifest!, declarations).outcomes.filter(cell => cell.file === batch.files[0]);
        const status = !result.code && result.outcomes[batch.files[0]!] === 'passed'
          && cells.length > 0 && cells.every(cell => cell.reading === 'passed') ? 'passed' : 'failed';
        const target = status === 'passed' ? recordTarget : join(recordTarget, 'failed', label);
        for (const path of copyRecords(repo, join(checkout!, recordSource), target))
          manifest!.records!.push({ record: relative(repo, path), file: batch.files[0]!, status, attempt: label });
      }
      save();
    };
    if (manifest.preflight.ok && !stopReason()) {
      let next = 0;
      const lanes = await Promise.allSettled(Array.from({ length: manifest.laneCount! }, async () => {
        while (next < manifest!.batches.length && !stopReason()) await execute(manifest!.batches[next++]!);
      }));
      const failure = lanes.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      // Drain all lanes before retrying a timeout, so its second attempt runs alone.
      for (const batch of manifest.batches)
        if (!stopReason() && confirmationTimeoutOnly(manifest, batch, batch.attempts.at(-1)!)) await execute(batch);
    }
    manifest.finishedAt = new Date().toISOString();
    manifest.stopped = stopReason();
    manifest.partial = manifest.stopped !== undefined;
    manifest.status = manifest.stopped ? 'incomplete' : !manifest.preflight.ok || manifest.batches.some(batch => batch.attempts.at(-1)?.code)
      ? 'failed' : manifest.files.every(file => file.outcome === 'passed') ? 'passed' : 'incomplete';
    save();
    recordConfirmation(stateDir, directory, manifest, declarations, manifest.finishedAt, pinned === main && !manifest.stopped);
    return manifest;
  } catch (error) {
    if (manifest) {
      manifest.status = 'incomplete';
      manifest.partial = true;
      manifest.stopped = stopReason();
      manifest.finishedAt = new Date().toISOString();
      save();
      recordConfirmation(stateDir, directory, manifest, declarations, manifest.finishedAt, false);
    }
    throw error;
  } finally {
    if (checkout) {
      const removed = spawnSync('git', ['worktree', 'remove', '--force', checkout], { cwd: repo, encoding: 'utf8' });
      if (removed.status !== 0) console.error(`Pinned checkout cleanup failed: ${removed.stderr}`);
    }
    runLease?.release();
  }
}

export function confirmationStatus(stateDir: string, now = Date.now(), runId?: string): string {
  if (runId !== undefined) {
    validateRunId(runId);
    const directory = join(stateDir, 'confirm', runId);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as ConfirmationManifest;
    const declarationsPath = join(directory, 'declarations.json');
    const record = manifest.status === 'running' || !latestConfirmation(directory)
      ? confirmationRecord(manifest, existsSync(declarationsPath)
        ? JSON.parse(readFileSync(declarationsPath, 'utf8')) as RowOutcomes[] : [], new Date(now).toISOString())
      : latestConfirmation(directory);
    return [`Confirmation ${runId}: ${manifest.atCommit}; ${manifest.status}; started ${manifest.startedAt}`,
      `Running: ${manifest.status === 'running' ? 'yes' : 'no'}`,
      ...(manifest.stopped ? [`Stopped: ${manifest.stopped}`] : []),
      ...(manifest.retainedSources ? [retainedPreflightSummary(manifest.retainedSources)] : []), ...confirmationSummary(record)].join('\n');
  }
  const record = latestConfirmation(stateDir);
  const counts = confirmationCounts(record);
  return [record ? `Last confirmation ${record.runId}: ${record.atCommit}; age ${Math.max(0,
    (now - Date.parse(record.recordedAt)) / 3_600_000).toFixed(1)}h; started ${record.startedAt}; recorded ${record.recordedAt}`
    : 'No confirmation run yet.',
  `Running: ${confirmationRunning(stateDir) ? 'yes' : 'no'}`,
  ...cellReadings.map(reading => `${reading}: ${counts[reading]}`)].join('\n');
}

export interface ScheduleConfirmationOptions {
  repo: string;
  stateDir: string;
  now?: number;
  spawn?: (token: string) => number;
}

function spawnConfirmation(repo: string, stateDir: string, token: string): number {
  const log = openSync(join(stateDir, 'confirm.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [join(import.meta.dir, 'confirm.ts'), token], {
      cwd: repo, detached: true, stdio: ['ignore', log, log], env: { ...process.env, GOAL_REGRESS_STATE_DIR: stateDir } });
    child.on('error', error => console.error(`Confirmation launch failed: ${error.message}`));
    if (!child.pid) throw new Error('Confirmation child has no PID');
    child.unref();
    return child.pid;
  } finally { closeSync(log); }
}

/** The pump reserves one independent run; worker liveness is deliberately irrelevant. */
export function scheduleConfirmation(options: ScheduleConfirmationOptions): boolean {
  const { repo, stateDir } = options;
  const now = options.now ?? Date.now();
  mkdirSync(stateDir, { recursive: true });
  const minutes = loadSettings({ stateDirectory: stateDir, cwd: repo }).settings.confirmIntervalMinutes;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes === 0 || confirmationRunning(stateDir) || confirmationRequested(stateDir)) return false;
  const record = latestConfirmation(stateDir);
  const startPath = join(stateDir, 'confirm-last-start');
  const lastStart = existsSync(startPath) ? Date.parse(readFileSync(startPath, 'utf8').trim())
    : record ? Date.parse(record.startedAt) : 0;
  if (now - lastStart < minutes * 60_000) return false;
  const main = git(repo, ['rev-parse', '--verify', 'main^{commit}']);
  if (record) {
    if (record.atCommit === main || spawnSync('git', ['merge-base', '--is-ancestor', record.atCommit, main], { cwd: repo }).status !== 0)
      return false;
  }
  const changes = git(repo, ['log', '--format=%H', record ? `${record.atCommit}..${main}` : main,
    '--', '.', ':(exclude)docs/**']);
  if (!changes) return false;
  const lock = join(stateDir, 'confirm.lock');
  const acquired = tryAcquireDirectoryLease(lock, { note: { startedAt: new Date(now).toISOString(), command: 'confirm:scheduled' } });
  if (acquired === 'held') return false;
  try {
    if (confirmationRequested(stateDir)) { acquired.release(); return false; }
    const pid = options.spawn ? options.spawn(acquired.token) : spawnConfirmation(repo, stateDir, acquired.token);
    transferDirectoryLease(lock, acquired.token, pid, process.pid);
    writeFileSync(startPath, `${new Date(now).toISOString()}\n`);
    return true;
  } catch (error) { acquired.release(); throw error; }
}

if (import.meta.main) {
  const { stateDir } = await import('./ledger.ts');
  const directory = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
  const token = process.argv[2]!;
  // Transfer occurs just after spawn; a child cannot consume the parent's reservation early.
  const deadline = Date.now() + 10_000;
  while (readDirectoryLease(join(directory, 'confirm.lock'))?.pid !== process.pid) {
    if (Date.now() >= deadline) throw new Error('Confirmation reservation was not transferred');
    await Bun.sleep(10);
  }
  await runConfirmation({ repo: process.cwd(), stateDir: directory, leaseToken: token });
}
