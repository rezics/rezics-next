import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { sha256, stable } from '../fixture/corpus.ts';
import { FixtureWorkBudget } from '../fixture/budget.ts';
import { createGovernanceOutputRedactor, redactCommandOutput } from '../fixture/command-output.ts';
import { isRetainedJson, retainedIntegrity, verifyRetainedIntegrity, type RetainedIntegrity, type RetainedJson, type RetainedOwnerState } from '../fixture/manifest.ts';
import { fixtureDirectory } from '../fixture/stack.ts';
import { POSTGRES_COLLATION_FILE, retainedCollationDifferences, retainedRuntimeFacts, retainedRuntimeDifferences, type RetainedRuntimeFacts } from '../fixture/runtime-facts.ts';

export const RETAINED_SOURCE_FORMAT = 'rezics-retained-source-v1';
export const SOURCE_PREPARATION_MS = 600_000;
export const SOURCE_RESTORE_MS = 600_000;
/** Keep two complete sources per producer; remove oldest publication first (key breaks ties).
 * Only this namespace is managed: historical corpus/Content/crash backups are never pruned. */
export const SOURCES_PER_PRODUCER = 2;

/** These roots govern admission, scheduling and process custody, never source
 * data. Prune their import branches too: harness imports reach unrelated tools
 * and test producers that must not become inputs of the retained corpus. */
export const RETAINED_SOURCE_EXCLUDED_ROOTS = [
  'scripts/goal/',
  'scripts/qa/core.ts',
  'scripts/qa/retained-preflight.ts',
  'scripts/qa/retained-requirements.ts',
  'scripts/qa/memory-admission.ts',
  'scripts/qa/host-admission.ts',
  'scripts/qa/resource-classes.ts',
  'scripts/qa/stack-startup.ts',
  'scripts/qa/stack-pool.ts',
  'scripts/qa/stack-ownership.ts',
  'scripts/qa/container-reaper.ts',
  'scripts/qa/process/',
] as const;

export function isRetainedSourceInput(path: string): boolean {
  const normalized = posix.normalize(path);
  return !RETAINED_SOURCE_EXCLUDED_ROOTS.some(root => root.endsWith('/')
    ? normalized === root.slice(0, -1) || normalized.startsWith(root)
    : normalized === root);
}

/** Physical artifact-only consumers select the matching prepared source. */
export function independentRestorePreparationOptions(file: string): { withRecipe: boolean } | undefined {
  if (file === 'tests/qa/fault-recovery/independent-restore.test.ts') return { withRecipe: true };
  if (file === 'tests/qa/fault-recovery/independent-restore-authority.test.ts'
    || file === 'tests/qa/fault-recovery/independent-restore-refusals.test.ts') return { withRecipe: false };
  return undefined;
}

/** Harness selection is explicit: callbacks have their own declared preparation adapter. */
export function ownerErasurePreparationOptions(file: string): { laterApiAdmission: boolean } | undefined {
  const defaultNames = ['production', 'completion', 'closure', 'authority', 'interruption', 'transition', 'source-closure'];
  if (file === 'tests/qa/fault-recovery/comment-source-erasure.test.ts' ||
    defaultNames.some(name => file === `tests/qa/fault-recovery/owner-restore-erasure-${name}.test.ts`))
    return { laterApiAdmission: false };
  if (['later-admission', 'later-admission-interruption', 'later-admission-denials']
    .some(name => file === `tests/qa/fault-recovery/owner-restore-erasure-${name}.test.ts`))
    return { laterApiAdmission: true };
  return undefined;
}

export interface SourceInputs {
  producer: string;
  version: string;
  /** Producer, helper, service and migration bytes that can shape this source. */
  files: Record<string, string>;
  inputs: RetainedOwnerState;
  /** Native image/schema facts; physical IDs and Git revision belong to provenance. */
  compatibility: RetainedOwnerState;
}

export function sourceKey(inputs: SourceInputs): string {
  if (!isRetainedJson(inputs)) throw new Error('retained source inputs must be complete JSON data');
  if (!/^[a-z][a-z0-9-]{0,80}$/.test(inputs.producer) || !inputs.version)
    throw new Error('retained source requires producer identity and adapter version');
  if (!Object.keys(inputs.files).length || Object.values(inputs.files).some(d => !/^[a-f0-9]{64}$/.test(d)))
    throw new Error('retained source requires source-affecting file digests');
  return `rs-${inputs.producer}-${sha256(stable(inputs))}`;
}

export function sourceFileDigests(root: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries([...new Set(files)].filter(isRetainedSourceInput).sort()
    .map(path => [path, sha256(readFileSync(join(root, path)))]));
}

export interface RetainedSourceManifest<M extends RetainedJson = RetainedJson> {
  format: typeof RETAINED_SOURCE_FORMAT;
  key: string;
  specification: SourceInputs;
  metadata: M;
  integrity: RetainedIntegrity;
  provenance: {
    producerRevision: string;
    qaIdentity: string;
    startedAt: string;
    completedAt: string;
    elapsedMs: number;
    admissionWaitMs: number;
    phases: Record<string, number>;
    producerBuild?: RetainedProducerBuildEvidence;
    backupPath: string;
    manifestPath: string;
    runtime?: RetainedRuntimeFacts;
  };
  digest: string;
}

export interface SourceContext {
  key: string;
  /** Producer callbacks receive a pending path; only the lifecycle publishes it. */
  directory: string;
  backup: string;
  budget: FixtureWorkBudget;
}

export interface RetainedProducerBuildEvidence {
  deadlineMs: number;
  /** Adapter's justification for this deadline, retained with custody. */
  evidence: string;
  elapsedMs: number;
  admissionWaitMs: number;
}

/** Producer-specific proof/cut belongs to the adapter. The lifecycle owns custody.
 * Metadata must reconstruct the consumer without former live pools or directories.
 * verify checks external physical resources too; restore never invokes build or smoke. */
export interface RetainedSourceAdapter<M extends RetainedJson, C> {
  specification: SourceInputs;
  /** Optional producer work before the physical cut, under the same producer/key
   * leases. The lifecycle measures it; adapter.build then begins the 600 s cut,
   * backup, seal and verification clock. Keep source-affecting inputs in specification. */
  producerBuild?: {
    deadlineMs: number;
    evidence: string;
    run(context: SourceContext): Promise<void>;
  };
  build(context: SourceContext): Promise<{
    metadata: M;
    rdfDigest: string;
    ownerState: RetainedOwnerState;
    producerRevision: string;
    qaIdentity: string;
    phases: Record<string, number>;
  }>;
  verify(context: SourceContext, manifest: RetainedSourceManifest<M>): Promise<string[]>;
  restore(context: SourceContext, manifest: RetainedSourceManifest<M>): Promise<C>;
  dispose(candidate: C): Promise<void>;
  /** Remove external resources by key even if publication failed or its manifest is corrupt. */
  remove(key: string): Promise<void>;
}

export class RetainedSourceRefusal extends Error {
  constructor(readonly key: string, readonly evidence: string[], options?: ErrorOptions) {
    super(`retained source ${key} refused: ${evidence.join('; ')}`, options);
  }
}

type Timing = { elapsedMs: number; admissionWaitMs: number };
type Boundary = 'lease' | 'release' | 'verify-existing' | 'remove' | 'remove-orphan' | 'build' |
  'producer-build' | 'remove-staging' |
  'seal' | 'verify-staging' | 'prune' | 'publish' | 'verify-published' | 'restore' |
  'verify-restored' | 'dispose' | 'verify-disposed';
export interface RetainedSourceFailureEvidence extends Timing {
  key: string;
  boundary: Boundary;
  phases: Partial<Record<Boundary, Timing>>;
  /** Available only after build returned; a thrown adapter's local timings are unknown. */
  adapterPhases?: Record<string, number>;
  producerBuild?: RetainedProducerBuildEvidence;
  /** Physical-cut timing for a declared build; total elapsedMs includes all phases. */
  preparation?: Timing;
  cleanup: { boundary: Boundary; error: unknown; elapsedMs: number; admissionWaitMs: number }[];
}

const failures = new WeakMap<object, RetainedSourceFailureEvidence>();
function cleanupMessage(error: unknown): string {
  if (!(error instanceof Error)) return '[non-Error cleanup exception]';
  // Configuration dumps carry private non-credential values as well as secrets.
  if (/compose\.env|\b[A-Z][A-Z0-9_]*\s*=/u.test(error.message)) return '[configuration diagnostic omitted]';
  const redactor = createGovernanceOutputRedactor();
  return (redactor.push(redactCommandOutput(error.message)) + redactor.finish()).slice(0, 2_000);
}
/** Exact exceptions stay in memory, outside bounded diagnostic output. Never alter
 * the primary's cause, stack, refusal class or budget identity to attach cleanup. */
export function retainedSourceFailure(error: unknown): RetainedSourceFailureEvidence | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
}

class Lifecycle {
  boundary: Boundary = 'lease';
  private readonly phases: Partial<Record<Boundary, Timing>> = {};
  adapterPhases?: Record<string, number>;
  producerBuild?: RetainedProducerBuildEvidence;
  preparationBudget?: FixtureWorkBudget;
  private priorTiming: Timing = { elapsedMs: 0, admissionWaitMs: 0 };
  private failed?: { error: unknown; evidence: RetainedSourceFailureEvidence };
  constructor(private readonly key: string, public budget: FixtureWorkBudget) {}

  useBudget(budget: FixtureWorkBudget): void {
    this.priorTiming = this.timing();
    this.budget = budget;
  }

  timing(): Timing {
    const current = this.budget.timing();
    return { elapsedMs: this.priorTiming.elapsedMs + current.elapsedMs,
      admissionWaitMs: this.priorTiming.admissionWaitMs + current.admissionWaitMs };
  }

  async step<T>(boundary: Boundary, work: () => T | Promise<T>): Promise<T> {
    this.boundary = boundary;
    const before = this.budget.timing();
    try { return await work(); }
    finally {
      const after = this.budget.timing(), prior = this.phases[boundary];
      this.phases[boundary] = { elapsedMs: (prior?.elapsedMs ?? 0) + after.elapsedMs - before.elapsedMs,
        admissionWaitMs: (prior?.admissionWaitMs ?? 0) + after.admissionWaitMs - before.admissionWaitMs };
    }
  }

  failure(error: unknown): RetainedSourceFailureEvidence {
    if (this.failed && Object.is(this.failed.error, error)) return this.failed.evidence;
    const evidence: RetainedSourceFailureEvidence = { key: this.key, boundary: this.boundary,
      ...this.timing(), phases: { ...this.phases }, adapterPhases: this.adapterPhases,
      producerBuild: this.producerBuild, preparation: this.preparationBudget?.timing(), cleanup: [] };
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) failures.set(error, evidence);
    this.failed = { error, evidence };
    this.report(evidence);
    return evidence;
  }

  private report(evidence: RetainedSourceFailureEvidence): void {
    // Only bounded, redacted cleanup messages enter the log; exact errors stay above.
    // No metadata or configuration is read. This record is never a custody manifest.
    try { console.error(`RETAINED_SOURCE_FAILURE ${JSON.stringify({ key: evidence.key, boundary: evidence.boundary,
      elapsedMs: evidence.elapsedMs, admissionWaitMs: evidence.admissionWaitMs, phases: evidence.phases,
      adapterPhases: evidence.adapterPhases,
      producerBuild: evidence.producerBuild && { deadlineMs: evidence.producerBuild.deadlineMs,
        elapsedMs: evidence.producerBuild.elapsedMs, admissionWaitMs: evidence.producerBuild.admissionWaitMs },
      preparation: evidence.preparation,
      cleanup: evidence.cleanup.map(({ boundary, error, elapsedMs, admissionWaitMs }) =>
        ({ boundary, message: cleanupMessage(error), elapsedMs, admissionWaitMs })) })}`); }
    catch { /* Diagnostic output must not replace the lifecycle exception. */ }
  }

  async cleanup(evidence: RetainedSourceFailureEvidence, boundary: Boundary, work: () => void | Promise<void>): Promise<void> {
    const before = this.budget.timing();
    try { await work(); }
    catch (error) {
      const after = this.budget.timing();
      if (evidence.cleanup.length < 16) evidence.cleanup.push({ boundary, error,
        elapsedMs: after.elapsedMs - before.elapsedMs, admissionWaitMs: after.admissionWaitMs - before.admissionWaitMs });
      this.report(evidence);
    }
  }
}

class ProducerBuildBudget extends FixtureWorkBudget {
  constructor(private readonly deadlineMs: number, now: () => number) { super(deadlineMs, now); }
  override remaining(): number {
    const remaining = this.deadlineMs - this.elapsed();
    if (remaining <= 0) throw new Error(`Retained source producer build exceeded declared ${this.deadlineMs} ms deadline`);
    return remaining;
  }
}

const digestManifest = (manifest: Omit<RetainedSourceManifest, 'digest'>) => sha256(stable(manifest));
const sourceRoot = () => fixtureDirectory('retained-sources');

function reportRecovery(key: string, reason: 'unpublished-staging' | 'unreadable-manifest' | 'verification-refused'): void {
  // Custody locks, not a PID file, establish that no producer can still own this work.
  try { console.info(`RETAINED_SOURCE_RECOVERY ${JSON.stringify({ key, reason })}`); }
  catch { /* Diagnostics must not interrupt recovery. */ }
}

/** Kernel custody prevents two builders across QA processes. Closing the owning
 * process's pipe releases custody even after a crash; no stale PID unlink race.
 * Lock files retain their inode, since unlinking an in-use lock splits custody. */
async function sourceLease(path: string, budget: FixtureWorkBudget, shared = false): Promise<() => Promise<void>> {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  for (;;) {
    budget.remaining();
    const holder = Bun.spawn(['flock', ...(shared ? ['--shared'] : []), '--nonblock', path, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    if (ready.done) {
      const status = await holder.exited;
      await holder.stdin.end();
      await new Response(holder.stderr).text();
      if (status !== 1) throw new Error(`retained-source custody lock failed (${status})`);
      await Bun.sleep(Math.min(50, budget.remaining()));
      continue;
    }
    let released = false;
    return async () => { if (!released) {
      released = true; await holder.stdin.end(); await holder.exited;
      await holder.stdout.cancel(); await holder.stderr.cancel();
    } };
  }
}

async function locked<T>(path: string, lifecycle: Lifecycle, work: () => Promise<T>, shared = false): Promise<T> {
  const release = await lifecycle.step('lease', () => sourceLease(path, lifecycle.budget, shared));
  let result: T;
  try { lifecycle.budget.remaining(); result = await work(); }
  catch (error) {
    await lifecycle.cleanup(lifecycle.failure(error), 'release', release);
    throw error;
  }
  return lifecycle.step('release', async () => { await release(); return result; });
}

export class RetainedSources {
  constructor(private readonly directory = sourceRoot(), private readonly now = Date.now) {}

  private context(key: string, budget: FixtureWorkBudget, directory = join(this.directory, key)): SourceContext {
    return { key, directory, backup: join(directory, 'backup'), budget };
  }

  private pending(key: string): string {
    return join(this.directory, `.${key}.pending-${randomUUID()}`);
  }

  /** Offline readiness never acquires a writable lock, repairs custody or calls
   * a producer. Consumer selection still holds its normal lease at restore. */
  async preflight<M extends RetainedJson, C>(adapter: RetainedSourceAdapter<M, C>,
    host = retainedRuntimeFacts()): Promise<RetainedSourceManifest<M>> {
    const key = sourceKey(adapter.specification);
    if (!existsSync(join(this.directory, key))) {
      const previous = existsSync(this.directory) ? readdirSync(this.directory)
        .filter(name => name.startsWith(`rs-${adapter.specification.producer}-`) && !name.endsWith('.lock')) : [];
      throw new RetainedSourceRefusal(key, [previous.length
        ? `stale key: expected ${key}; retained ${previous.sort().join(', ')}` : 'build is missing']);
    }
    // Runtime checks precede potentially large physical inventories.
    let manifest: RetainedSourceManifest<M>;
    try { manifest = JSON.parse(readFileSync(join(this.directory, key, 'manifest.json'), 'utf8')) as RetainedSourceManifest<M>; }
    catch { throw new RetainedSourceRefusal(key, ['complete manifest is missing or unreadable']); }
    const runtime = retainedRuntimeDifferences(manifest?.provenance?.runtime, host);
    if (manifest?.integrity?.files?.[POSTGRES_COLLATION_FILE])
      runtime.push(...retainedCollationDifferences(join(this.directory, key, 'backup', POSTGRES_COLLATION_FILE), host));
    if (runtime.length) throw new RetainedSourceRefusal(key, runtime);
    return this.verified(adapter, this.context(key, new FixtureWorkBudget(SOURCE_RESTORE_MS, this.now)));
  }

  private async verified<M extends RetainedJson, C>(adapter: RetainedSourceAdapter<M, C>, context: SourceContext,
    checkRuntime = false): Promise<RetainedSourceManifest<M>> {
    const evidence: string[] = [];
    let verificationError: unknown;
    let manifest: RetainedSourceManifest<M>;
    try {
      manifest = JSON.parse(readFileSync(join(context.directory, 'manifest.json'), 'utf8')) as RetainedSourceManifest<M>;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid manifest');
    }
    catch { throw new RetainedSourceRefusal(context.key, ['complete manifest is missing or unreadable']); }
    if (checkRuntime) {
      const host = retainedRuntimeFacts();
      evidence.push(...retainedRuntimeDifferences(manifest.provenance?.runtime, host));
      if (manifest.integrity?.files?.[POSTGRES_COLLATION_FILE])
        evidence.push(...retainedCollationDifferences(join(context.backup, POSTGRES_COLLATION_FILE), host));
      if (evidence.length) throw new RetainedSourceRefusal(context.key, evidence);
    }
    const { digest, ...body } = manifest;
    if (manifest.format !== RETAINED_SOURCE_FORMAT || manifest.key !== context.key)
      evidence.push('source format/key differs');
    if (sourceKey(adapter.specification) !== context.key || stable(manifest.specification) !== stable(adapter.specification))
      evidence.push('producer inputs or native/schema compatibility differs');
    if (digestManifest(body) !== digest) evidence.push('manifest digest differs');
    if (!manifest.integrity) evidence.push('integrity metadata is missing');
    else evidence.push(...verifyRetainedIntegrity(context.backup, manifest.integrity));
    if (!evidence.length) {
      try { evidence.push(...await adapter.verify(context, manifest)); }
      catch (error) { verificationError = error; evidence.push(`physical verification failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (evidence.length) throw new RetainedSourceRefusal(context.key, evidence, { cause: verificationError });
    context.budget.remaining();
    return manifest;
  }

  /** Selection is read-only: refusal is evidence, never a rebuild or reseal. */
  async select<M extends RetainedJson, C>(adapter: RetainedSourceAdapter<M, C>): Promise<RetainedSourceManifest<M>> {
    const key = sourceKey(adapter.specification), budget = new FixtureWorkBudget(SOURCE_RESTORE_MS, this.now);
    const lifecycle = new Lifecycle(key, budget);
    try {
      return await locked(join(this.directory, `${key}.lock`), lifecycle,
        () => lifecycle.step('verify-existing', () => this.verified(adapter, this.context(key, budget))), true);
    } catch (error) { lifecycle.failure(error); throw error; }
  }

  /** Dispose through the returned handle: its read lease prevents pruning the
   * source until every candidate resource is disposed and custody is reverified. */
  async restore<M extends RetainedJson, C>(adapter: RetainedSourceAdapter<M, C>): Promise<{ candidate: C; manifest: RetainedSourceManifest<M>; elapsedMs: number; admissionWaitMs: number; dispose(): Promise<void> }> {
    const key = sourceKey(adapter.specification), budget = new FixtureWorkBudget(SOURCE_RESTORE_MS, this.now);
    const lifecycle = new Lifecycle(key, budget);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lifecycle.step('lease', () => sourceLease(join(this.directory, `${key}.lock`), budget, true));
      const context = this.context(key, budget);
      const manifest = await lifecycle.step('verify-existing', () => this.verified(adapter, context)); // Consumer's first act.
      const expectedDigest = manifest.digest;
      const verifyUnchanged = async (checking: SourceContext) => {
        const current = await this.verified(adapter, checking);
        if (current.digest !== expectedDigest)
          throw new RetainedSourceRefusal(key, ['source manifest changed during consumption']);
      };
      const candidate = await lifecycle.step('restore', () => adapter.restore(context, manifest));
      try {
        await lifecycle.step('verify-restored', async () => {
          budget.remaining();
          // Detect a consumer writing the immutable source, rather than its fresh copy.
          await verifyUnchanged(context);
        });
        let disposed = false;
        let disposing: Promise<void> | undefined;
        const dispose = (): Promise<void> => {
          if (disposed) return Promise.resolve();
          if (disposing) return disposing;
          disposing = (async () => {
            const disposal = new Lifecycle(key, new FixtureWorkBudget(SOURCE_RESTORE_MS, this.now));
            try {
              await disposal.step('dispose', () => adapter.dispose(candidate));
            } catch (error) { disposal.failure(error); throw error; } // Failed disposal retains the lease for retry.
            try {
              await disposal.step('verify-disposed', () =>
                verifyUnchanged(this.context(key, new FixtureWorkBudget(SOURCE_RESTORE_MS, this.now))));
            } catch (error) {
              disposed = true;
              await disposal.cleanup(disposal.failure(error), 'release', release!);
              throw error;
            }
            disposed = true;
            try { await disposal.step('release', release!); }
            catch (error) { disposal.failure(error); throw error; }
          })().finally(() => { disposing = undefined; });
          return disposing;
        };
        return { candidate, manifest, ...budget.timing(), dispose };
      } catch (error) {
        await lifecycle.cleanup(lifecycle.failure(error), 'dispose', () => adapter.dispose(candidate));
        throw error;
      }
    } catch (error) {
      const evidence = lifecycle.failure(error);
      if (release) await lifecycle.cleanup(evidence, 'release', release);
      throw error;
    }
  }

  async prepare<M extends RetainedJson, C>(adapter: RetainedSourceAdapter<M, C>): Promise<{ manifest: RetainedSourceManifest<M>; built: boolean; elapsedMs: number; admissionWaitMs: number; producerBuild?: RetainedProducerBuildEvidence }> {
    const key = sourceKey(adapter.specification);
    let budget = new FixtureWorkBudget(SOURCE_PREPARATION_MS, this.now);
    const lifecycle = new Lifecycle(key, budget);
    const context = this.context(key, budget);
    // Valid custody can be reused alongside existing consumers. Only rebuilding
    // or pruning needs exclusive custody, so preparation does not queue behind an operation.
    if (existsSync(context.directory)) {
      try {
        const manifest = await locked(join(this.directory, `${key}.lock`), lifecycle,
          () => lifecycle.step('verify-existing', () => this.verified(adapter, context, true)), true);
        return { manifest, built: false, ...budget.timing() };
      } catch (error) {
        if (!(error instanceof RetainedSourceRefusal) || retainedSourceFailure(error)?.cleanup.length) {
          lifecycle.failure(error); throw error;
        }
      }
    }
    // Serialize publication/pruning per producer as well as preparation per key.
    try { return await locked(join(this.directory, `${adapter.specification.producer}.lock`), lifecycle, () =>
      locked(join(this.directory, `${key}.lock`), lifecycle, async () => {
        if (existsSync(context.directory)) {
          try { return { manifest: await lifecycle.step('verify-existing', () => this.verified(adapter, context, true)), built: false, ...budget.timing() }; }
          catch (error) {
            if (!(error instanceof RetainedSourceRefusal)) throw error;
            try {
              // Quarantine before asynchronous external cleanup: a second interruption
              // must not strand an unmanifested directory in the published namespace.
              const quarantine = this.pending(key);
              renameSync(context.directory, quarantine);
              reportRecovery(key, error.evidence.includes('complete manifest is missing or unreadable')
                ? 'unreadable-manifest' : 'verification-refused');
              await adapter.remove(key);
              rmSync(quarantine, { recursive: true, force: true });
            } catch (cleanupError) {
              await lifecycle.cleanup(lifecycle.failure(error), 'remove', () => { throw cleanupError; });
              throw error;
            }
          }
        }
        // A killed build can leave unpublished staging. Remove, never supplement it.
        const pendingPrefix = `.rs-${adapter.specification.producer}-`;
        for (const name of readdirSync(this.directory).filter(name => name.startsWith(pendingPrefix) && name.includes('.pending-'))) {
          const orphanKey = name.slice(1, name.indexOf('.pending-'));
          if (!/^[a-f0-9]{64}$/.test(orphanKey.slice(`rs-${adapter.specification.producer}-`.length))) continue;
          const remove = () => lifecycle.step('remove-orphan', async () => {
            // A live producer may have published while we waited for its key.
            if (!existsSync(join(this.directory, name))) return;
            reportRecovery(orphanKey, 'unpublished-staging');
            await adapter.remove(orphanKey);
            rmSync(join(this.directory, name), { recursive: true, force: true });
          });
          if (orphanKey === key) await remove(); // Already exclusively held.
          else await locked(join(this.directory, `${orphanKey}.lock`), lifecycle, remove);
        }
        await lifecycle.step('remove', () => adapter.remove(key));
        const staging = this.pending(key);
        const candidate = this.context(key, budget, staging);
        mkdirSync(candidate.backup, { recursive: true, mode: 0o700 });
        const startedAt = new Date(this.now()).toISOString();
        let published = false, sealed = false;
        try {
          const declared = adapter.producerBuild;
          if (declared) {
            const { deadlineMs, evidence, run } = declared;
            await lifecycle.step('producer-build', async () => {
              if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 ||
                typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2_000)
                throw new Error('Retained source producer build requires a positive deadlineMs and bounded nonempty evidence');
            });
            const producerBudget = new ProducerBuildBudget(deadlineMs, this.now);
            lifecycle.useBudget(producerBudget);
            await lifecycle.step('producer-build', async () => {
              try {
                await run.call(declared, this.context(key, producerBudget, staging));
                producerBudget.remaining();
              } finally {
                lifecycle.producerBuild = { deadlineMs, evidence, ...producerBudget.timing() };
              }
            });
            // The existing build callback starts with the physical cut, never a
            // producer rerun. Both callbacks remain inside the same custody lease.
            budget = new FixtureWorkBudget(SOURCE_PREPARATION_MS, this.now);
            lifecycle.useBudget(budget);
            lifecycle.preparationBudget = budget;
            context.budget = budget;
            candidate.budget = budget;
          }
          const build = await lifecycle.step('build', async () => {
            const result = await adapter.build(candidate);
            // Bound adapter evidence without serializing its metadata or configuration.
            lifecycle.adapterPhases = Object.fromEntries(Object.entries(result.phases).slice(0, 32)
              .filter(([name, ms]) => /^[a-z][a-z0-9-]{0,63}$/.test(name) && Number.isFinite(ms) && ms >= 0));
            budget.remaining();
            return result;
          });
          await lifecycle.step('seal', () => {
            const body: Omit<RetainedSourceManifest<M>, 'digest'> = {
              format: RETAINED_SOURCE_FORMAT, key, specification: adapter.specification,
              metadata: build.metadata,
              integrity: retainedIntegrity(candidate.backup, build.rdfDigest, build.ownerState),
              provenance: {
                producerRevision: build.producerRevision, qaIdentity: build.qaIdentity,
                startedAt, completedAt: new Date(this.now()).toISOString(), ...budget.timing(),
                admissionWaitMs: lifecycle.timing().admissionWaitMs,
                ...(lifecycle.producerBuild ? { producerBuild: lifecycle.producerBuild } : {}),
                phases: build.phases, backupPath: context.backup,
                manifestPath: join(context.directory, 'manifest.json'),
                runtime: retainedRuntimeFacts(),
              },
            };
            writeFileSync(join(staging, 'manifest.json'), `${stable({ ...body, digest: digestManifest(body) })}\n`, { mode: 0o600 });
            sealed = true;
          });
          await lifecycle.step('verify-staging', () => this.verified(adapter, candidate));
          await lifecycle.step('prune', () => this.prune(adapter, key, lifecycle));
          await lifecycle.step('publish', () => {
            budget.remaining();
            renameSync(staging, context.directory); // Manifest and complete backup become visible together.
            published = true;
          });
          const manifest = await lifecycle.step('verify-published', () => this.verified(adapter, context));
          return { manifest, built: true, ...budget.timing(), admissionWaitMs: lifecycle.timing().admissionWaitMs,
            ...(lifecycle.producerBuild ? { producerBuild: lifecycle.producerBuild } : {}) };
        } catch (error) {
          const evidence = lifecycle.failure(error);
          // Failed published verification must become unselectable even if external removal fails.
          if (published) await lifecycle.cleanup(evidence, 'publish', () => renameSync(context.directory, staging));
          await lifecycle.cleanup(evidence, 'remove', async () => {
            await adapter.remove(key);
            rmSync(staging, { recursive: true, force: true });
          });
          // No manifest exists yet: external cleanup failure must not strand
          // unsealed producer bytes. Sealed quarantine retains its repair evidence.
          if (!sealed) await lifecycle.cleanup(evidence, 'remove-staging', () => rmSync(staging, { recursive: true, force: true }));
          throw error;
        }
      })); } catch (error) { lifecycle.failure(error); throw error; }
  }

  private async prune<M extends RetainedJson, C>(adapter: RetainedSourceAdapter<M, C>, key: string, lifecycle: Lifecycle): Promise<void> {
    const prefix = `rs-${adapter.specification.producer}-`;
    const retained = readdirSync(this.directory).filter(name => name.startsWith(prefix) && !name.endsWith('.lock') && name !== key)
      .map(name => {
        let completed = '';
        try {
          const timestamp = (JSON.parse(readFileSync(join(this.directory, name, 'manifest.json'), 'utf8')) as RetainedSourceManifest).provenance.completedAt;
          if (typeof timestamp === 'string') completed = timestamp;
        }
        catch { /* An incomplete source is removed first. */ }
        return { name, completed };
      }).sort((a, b) => a.completed.localeCompare(b.completed) || a.name.localeCompare(b.name));
    for (const source of retained.slice(0, Math.max(0, retained.length - SOURCES_PER_PRODUCER + 1))) {
      await locked(join(this.directory, `${source.name}.lock`), lifecycle, async () => {
        await lifecycle.step('remove', async () => {
          await adapter.remove(source.name);
          rmSync(join(this.directory, source.name), { recursive: true, force: true });
        });
      });
    }
  }
}
