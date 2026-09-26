import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { collisionKey, confinedPath, inspectNpmTarball, type ArchiveViolation } from './install-archive.ts';
import type { GenerationState, InstallationGenerationRow, InstallationRow, InstallationStepRow }
  from './install-schema.ts';
import { PackageArtifactUnavailable } from './lock-artifacts.ts';
import { stableJson, type LockArtifactRow } from './lock-schema.ts';
import type { LockedArtifact, PackageLockStore } from './lock.ts';

export class PackageInstallInvalid extends Error {}
export class PackageInstallConflict extends Error {}
export class PackageInstallStale extends Error {}
export class PackageInstallUnavailable extends Error {}
export class PackageInstallDenied extends Error {}
/** Test-only crash injection: thrown without cleanup, as a killed process would stop. */
export class SimulatedInstallCrash extends Error {}

export const INSTALL_PROFILE = 'rezics-controlled-install-v1';

export type InstallFault = 'after-unpack-intent' | 'after-hook-intent' | 'after-switch-intent'
  | 'mid-switch' | 'before-activation-commit' | 'after-activation-commit' | 'mid-remove';

/** An approved lifecycle-hook runner. Without one, no hook can be approved. */
export interface HookExecutor {
  profile: string;
  run(input: { instanceKey: string; directory: string; hooks: string[] }): Promise<void>;
}

export interface InstallationRequest {
  profile: typeof INSTALL_PROFILE;
  target: string;
  environment: { os: 'linux'; cpu: 'x64' | 'arm64' };
}

export interface GenerationRequest {
  operation: 'install' | 'update' | 'rollback' | 'remove';
  lock: string | null;
  rollbackOf: string | null;
  expectedGeneration: string | null;
  userData: Array<{ path: string; kind: 'file' | 'directory' }>;
  approveHooks: string[];
}

export interface GenerationView {
  generation: string; installation: string; number: number; operation: GenerationRequest['operation'];
  state: GenerationState; terminalReason: string | null; lock: string | null;
  expectedGeneration: string | null; rollbackOf: string | null; planSha256: string;
  steps: Array<{ ordinal: number; action: string; stepKey: string; instanceKey: string | null;
    executesCode: boolean; idempotent: boolean; approved: boolean; lastEvent: string | null }>;
  paths: Array<{ path: string; kind: string; ownership: string }>;
  createdAt: string; updatedAt: string;
}

export interface InstallationView {
  installation: string; target: string; environment: Record<string, unknown>; state: 'present' | 'removed';
  headEpoch: number; activeGeneration: string | null; generationsTruncated: boolean;
  claims: Array<{ path: string; ownership: string }>;
  generations: Array<{ generation: string; number: number; operation: string; state: string;
    terminalReason: string | null }>;
}

export interface PlanViolation extends Partial<ArchiveViolation> {
  reason: NonNullable<InstallationGenerationRow['terminal_reason']>; instanceKey?: string; detail?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

interface PlannedStep { action: InstallationStepRow['action']; stepKey: string; artifact: number | null;
  executesCode: boolean; idempotent: boolean; approved: boolean;
  compensation: InstallationStepRow['compensation'] }
interface PlannedPath { path: string; kind: 'file' | 'directory'; ownership: 'installation' | 'user-data';
  step: number }
interface Analysis { reason: PlanViolation['reason'] | null; violations: PlanViolation[];
  steps: PlannedStep[]; paths: PlannedPath[] }
interface Source { lock: LockArtifactRow; artifact: string }

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/** Top-level instances become visible mounts; nested ones live inside their parent. */
function mounts(paths: string[]): Set<string> {
  return new Set(paths.filter(path => !paths.some(other => other !== path && path.startsWith(`${other}/`))));
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** A package mount may never follow an existing symlink above its own path. */
async function unsafeParent(root: string, path: string): Promise<boolean> {
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat && !rootStat.isDirectory()) return true;
  for (const ancestor of ancestors(path)) {
    const stat = await lstat(join(root, ancestor)).catch(() => null);
    if (stat && !stat.isDirectory()) return true;
  }
  return false;
}

async function admissibleMount(root: string, path: string, generations: string[]): Promise<boolean> {
  const link = join(root, path);
  const stat = await lstat(link).catch(() => null);
  if (!stat) return true;
  if (!stat.isSymbolicLink()) return false;
  const actual = resolve(dirname(link), await readlink(link));
  return generations.some(id => actual === join(root, '.rezics', 'generations', id, path));
}

/**
 * Controlled local installation of exact locks into one environment root.
 * Planning inspects the retained, verified archive bytes and rejects
 * traversal, ownership collisions, unapproved hooks and revoked artifacts
 * before any filesystem effect. Applying journals every step, stages into
 * owned directories, switches visible mounts by atomic symlink replacement
 * and activates the generation by CAS on the installation head. A second
 * apply after any interruption resumes from the journal; a non-idempotent
 * hook with an unknown outcome is never repeated.
 */
export class PackageInstallationStore {
  constructor(private readonly pool: Pool, private readonly locks: PackageLockStore,
    private readonly options: { rootDirectory: string; hookExecutor?: HookExecutor;
      fault?: InstallFault | ((point: InstallFault) => void) }) {}

  async createInstallation(principalId: string, key: string, request: InstallationRequest):
    Promise<{ installation: InstallationView; replayed: boolean }> {
    if (!KEY.test(key) || request?.profile !== INSTALL_PROFILE
      || typeof request.target !== 'string' || !/^[A-Za-z0-9:_./-]{1,256}$/.test(request.target)
      || request.environment?.os !== 'linux' || !['x64', 'arm64'].includes(request.environment.cpu)) {
      throw new PackageInstallInvalid('installation request is malformed');
    }
    const digest = sha(stableJson(request));
    const inserted = await this.pool.query<InstallationRow>(`INSERT INTO pkg.installation
        (id, principal_id, idempotency_key, request_digest, target_key, environment)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (principal_id, idempotency_key) DO NOTHING RETURNING *`,
    [randomUUID(), principalId, key, digest, request.target, JSON.stringify(request.environment)]);
    const row = inserted.rows[0] ?? (await this.pool.query<InstallationRow>(`SELECT * FROM pkg.installation
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0]!;
    if (row.request_digest !== digest) throw new PackageInstallConflict('idempotency key belongs to another installation');
    return { installation: (await this.read(principalId, row.id))!, replayed: !inserted.rows[0] };
  }

  async read(principalId: string, id: string): Promise<InstallationView | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query<InstallationRow>(`SELECT * FROM pkg.installation
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    if (!row) return null;
    const [claims, generations] = await Promise.all([
      this.pool.query<{ path: string; ownership: string }>(`SELECT path, ownership
        FROM pkg.installation_path_claim WHERE installation_id = $1 ORDER BY collision_key`, [id]),
      this.pool.query<InstallationGenerationRow>(`SELECT * FROM pkg.installation_generation
        WHERE installation_id = $1 ORDER BY number DESC LIMIT 65`, [id])]);
    return { installation: row.id, target: row.target_key, environment: row.environment, state: row.state,
      headEpoch: Number(row.head_epoch), activeGeneration: row.active_generation_id, claims: claims.rows,
      generationsTruncated: generations.rows.length > 64,
      generations: generations.rows.slice(0, 64).reverse().map(item => ({ generation: item.id, number: item.number,
        operation: item.operation, state: item.state, terminalReason: item.terminal_reason })) };
  }

  async readGeneration(principalId: string, installationId: string, id: string): Promise<GenerationView | null> {
    if (!UUID.test(id) || !UUID.test(installationId)) return null;
    const row = (await this.pool.query<InstallationGenerationRow>(`SELECT * FROM pkg.installation_generation
      WHERE id = $1 AND installation_id = $2 AND principal_id = $3`, [id, installationId, principalId])).rows[0];
    return row ? this.view(row) : null;
  }

  /** Plan one generation. A rejected plan is durable evidence and never reaches the filesystem. */
  async plan(principalId: string, installationId: string, key: string, request: GenerationRequest):
    Promise<{ generation: GenerationView; violations: PlanViolation[]; replayed: boolean }> {
    this.validate(key, request);
    const digest = sha(stableJson({ installation: installationId, request }));
    const previous = await this.generationByKey(principalId, key);
    if (previous) {
      if (previous.request_digest !== digest) throw new PackageInstallConflict('idempotency key belongs to another plan');
      const installation = (await this.installation(principalId, installationId))!;
      const analysis = previous.state === 'rejected' ? await this.analyze(installation, previous.id, request,
        await this.sources(principalId, installation, request)) : null;
      return { generation: await this.view(previous), violations: analysis?.violations ?? [], replayed: true };
    }
    const installation = await this.installation(principalId, installationId);
    if (!installation) throw new PackageInstallUnavailable('installation is unavailable');
    if (installation.state === 'removed') throw new PackageInstallConflict('installation was removed');
    if (installation.active_generation_id !== request.expectedGeneration
      || (request.operation === 'install') !== (installation.active_generation_id === null)) {
      throw new PackageInstallStale('expected generation is not current');
    }
    const sources = await this.sources(principalId, installation, request);
    const id = randomUUID();
    const analysis = await this.analyze(installation, id, request, sources);
    const lockId = request.operation === 'remove' ? null
      : request.operation === 'rollback' ? sources[0]?.lock.lock_id ?? await this.rollbackLock(installation, request)
        : request.lock;
    const planSha = sha(stableJson({ request, steps: analysis.steps, paths: analysis.paths }));
    try {
      await transaction(this.pool, async client => {
        const number = (await client.query<{ next: number }>(`SELECT COALESCE(max(number), 0) + 1 AS next
          FROM pkg.installation_generation WHERE installation_id = $1`, [installationId])).rows[0]!.next;
        await client.query(`INSERT INTO pkg.installation_generation (id, installation_id, principal_id,
            number, idempotency_key, request_digest, operation, lock_id, expected_prior_generation_id,
            rollback_of_generation_id, plan_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, installationId, principalId, number, key, digest, request.operation, lockId,
          request.expectedGeneration, request.rollbackOf, planSha]);
        for (const [ordinal, step] of analysis.steps.entries()) {
          await client.query(`INSERT INTO pkg.installation_step (generation_id, ordinal, action, step_key,
              lock_id, artifact_ordinal, executes_code, idempotent, hook_approval_id, executor_profile,
              capabilities, compensation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [id, ordinal, step.action, step.stepKey, step.artifact === null ? null : lockId, step.artifact,
            step.executesCode, step.idempotent, step.approved ? randomUUID() : null,
            step.approved ? this.options.hookExecutor!.profile : null,
            JSON.stringify(step.executesCode ? ['filesystem:instance-directory'] : []), step.compensation]);
        }
        if (!analysis.reason || analysis.reason !== 'path-traversal') {
          for (const path of analysis.paths) {
            await client.query(`INSERT INTO pkg.installation_path (generation_id, path, collision_key, kind,
                ownership, step_ordinal) VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, path.path, collisionKey(path.path), path.kind, path.ownership, path.step]);
          }
        }
        if (analysis.reason) {
          await client.query(`UPDATE pkg.installation_generation SET state = 'rejected', terminal_reason = $2
            WHERE id = $1`, [id, analysis.reason]);
        }
      });
    } catch (error) {
      const code = (error as { code?: string; constraint?: string });
      if (code.code === '23505' && code.constraint === 'installation_generation_inflight') {
        throw new PackageInstallConflict('another generation of this installation is in flight');
      }
      if (code.code === '23505') {
        const raced = await this.generationByKey(principalId, key);
        if (raced && raced.request_digest === digest) {
          return { generation: await this.view(raced), violations: analysis.violations, replayed: true };
        }
        throw new PackageInstallConflict('plan conflicts with a concurrent plan');
      }
      throw error;
    }
    const row = (await this.generationByKey(principalId, key))!;
    return { generation: await this.view(row), violations: analysis.violations, replayed: false };
  }

  /**
   * Execute or resume a planned generation. `fence` re-checks current authority
   * immediately before the visible switch; a false result leaves no visible effect.
   */
  async apply(principalId: string, installationId: string, generationId: string,
    fence: () => Promise<boolean>): Promise<{ generation: GenerationView; replayed: boolean }> {
    const lock = await this.pool.connect();
    const lockKey = `pkg-install:${installationId}`;
    try {
      const held = (await lock.query<{ held: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held', [lockKey])).rows[0]!.held;
      if (!held) throw new PackageInstallConflict('another apply of this installation is running');
      try { return await this.applyLocked(principalId, installationId, generationId, fence); }
      finally { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); }
    } finally { lock.release(); }
  }

  private async applyLocked(principalId: string, installationId: string, generationId: string,
    fence: () => Promise<boolean>): Promise<{ generation: GenerationView; replayed: boolean }> {
    const installation = await this.installation(principalId, installationId);
    let generation = await this.generation(principalId, installationId, generationId);
    if (!installation || !generation) throw new PackageInstallUnavailable('generation is unavailable');
    if (['rejected', 'failed'].includes(generation.state)) {
      throw new PackageInstallConflict(`generation is ${generation.state}`);
    }
    const root = this.root(installation.target_key);
    const dirs = { quarantine: join(root, '.rezics', 'quarantine', generationId),
      staging: join(root, '.rezics', 'staging', generationId),
      generation: join(root, '.rezics', 'generations', generationId) };
    if (generation.state === 'active' || generation.state === 'superseded') {
      // A lost response after activation: report the committed outcome and finish cleanup.
      await rm(dirs.staging, { recursive: true, force: true });
      await rm(dirs.quarantine, { recursive: true, force: true });
      return { generation: await this.view(generation), replayed: true };
    }
    const steps = (await this.pool.query<InstallationStepRow>(`SELECT * FROM pkg.installation_step
      WHERE generation_id = $1 ORDER BY ordinal`, [generationId])).rows;
    const lockRows = generation.lock_id ? (await this.pool.query<LockArtifactRow>(`SELECT * FROM pkg.lock_artifact
      WHERE lock_id = $1 ORDER BY ordinal`, [generation.lock_id])).rows : [];
    const request = { operation: generation.operation, rollbackOf: generation.rollback_of_generation_id,
      lock: generation.lock_id } as GenerationRequest;
    const sources = generation.lock_id ? await this.sources(principalId, installation, request) : [];
    const last = await this.lastEvents(generationId);
    const move = async (state: GenerationState, extra: { reason?: string; admission?: string } = {}) => {
      await this.pool.query(`UPDATE pkg.installation_generation SET state = $2,
          terminal_reason = COALESCE($3, terminal_reason),
          activation_admission_id = COALESCE($4, activation_admission_id) WHERE id = $1`,
      [generationId, state, extra.reason ?? null, extra.admission ?? null]);
      generation = (await this.generation(principalId, installationId, generationId))!;
    };
    const fail = async (reason: string, state: 'failed' | 'rejected' = 'failed') => {
      await move(state, { reason });
      await rm(dirs.staging, { recursive: true, force: true });
      await rm(dirs.quarantine, { recursive: true, force: true });
      await this.releaseUnactivatedClaims(installation, generationId);
      return { generation: await this.view(generation!), replayed: false };
    };
    const run = async (step: InstallationStepRow, effect: () => Promise<void>): Promise<boolean> => {
      const previous = last.get(step.ordinal);
      if (previous?.event === 'completed') return true;
      if (previous && !step.idempotent && !(previous.event === 'compensated'
        || (['failed', 'reconciled', 'cancelled'].includes(previous.event) && previous.effect === 'none'))) {
        // Unknown hook outcome: record the inspection and never repeat the hook blindly.
        await this.record(generationId, step.ordinal, 'reconciled', 'unknown',
          { note: 'prior intent has no recorded outcome; not repeated' });
        return false;
      }
      await this.record(generationId, step.ordinal, 'intent', 'none', {});
      try { await effect(); }
      catch (error) {
        if (error instanceof SimulatedInstallCrash) throw error;
        await this.record(generationId, step.ordinal, 'failed', step.idempotent ? 'none' : 'unknown',
          { error: error instanceof Error ? error.message.slice(0, 512) : 'step failed' });
        return false;
      }
      await this.record(generationId, step.ordinal, 'completed', 'complete', {});
      last.set(step.ordinal, { event: 'completed', effect: 'complete' });
      return true;
    };
    const byAction = (action: string) => steps.filter(step => step.action === action);
    const source = (ordinal: number) => sources.find(item => item.lock.ordinal === ordinal);

    if (generation.state === 'planned') {
      await move(generation.operation === 'remove' ? 'activating' : 'fetching',
        generation.operation === 'remove' ? { admission: await this.admit(fence) } : {});
    }
    if (generation.state === 'fetching') {
      for (const step of byAction('fetch')) {
        const item = source(step.artifact_ordinal!);
        const ok = await run(step, async () => {
          if (!item) throw new PackageArtifactUnavailable('retained artifact is unavailable');
          const { bytes } = await this.locks.artifacts.read(item.artifact);
          await mkdir(dirs.quarantine, { recursive: true });
          await writeFile(join(dirs.quarantine, `${step.artifact_ordinal}.tgz`), bytes);
        });
        if (!ok) return fail('artifact-unverified');
      }
      for (const step of byAction('verify')) {
        const item = source(step.artifact_ordinal!)!;
        let revoked = false;
        const ok = await run(step, async () => {
          const bytes = await readFile(join(dirs.quarantine, `${step.artifact_ordinal}.tgz`));
          const locked = createHash(item.lock.digest_algorithm as string).update(bytes).digest('hex');
          const artifact = (await this.pool.query<{ sha256: string }>('SELECT sha256 FROM pkg.artifact WHERE id = $1',
            [item.artifact])).rows[0];
          if (locked !== item.lock.digest_value || sha(bytes) !== artifact?.sha256) {
            throw new Error('quarantined bytes differ from the lock');
          }
          try {
            await this.pool.query(`INSERT INTO pkg.installation_artifact (generation_id, lock_id,
                artifact_ordinal, artifact_id, artifact_sha256) VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT DO NOTHING`, [generationId, generation!.lock_id, step.artifact_ordinal,
              item.artifact, artifact.sha256]);
          } catch (error) {
            if ((error as { constraint?: string }).constraint === 'installation_artifact_verified') revoked = true;
            throw error;
          }
        });
        if (!ok) return fail(revoked ? 'artifact-revoked' : 'artifact-unverified', revoked ? 'rejected' : 'failed');
      }
      await move('verified');
    }
    if (generation.state === 'verified') {
      for (const step of byAction('unpack')) {
        const ok = await run(step, async () => {
          const target = join(dirs.staging, `i${step.artifact_ordinal}`);
          await rm(target, { recursive: true, force: true });
          const inspection = inspectNpmTarball(await readFile(join(dirs.quarantine, `${step.artifact_ordinal}.tgz`)));
          if (inspection.violations.length) throw new Error('archive violates the confined layout');
          this.fault('after-unpack-intent');
          await mkdir(target, { recursive: true });
          for (const entry of inspection.entries.filter(item => item.kind !== 'symlink')) {
            const path = join(target, entry.path);
            if (entry.kind === 'directory') await mkdir(path, { recursive: true });
            else {
              await mkdir(dirname(path), { recursive: true });
              await writeFile(path, entry.bytes!, { mode: entry.executable ? 0o755 : 0o644 });
            }
          }
          for (const entry of inspection.entries.filter(item => item.kind === 'symlink')) {
            await mkdir(dirname(join(target, entry.path)), { recursive: true });
            await symlink(entry.target!, join(target, entry.path));
          }
        });
        if (!ok) return fail('path-traversal', 'rejected');
      }
      for (const step of byAction('build')) {
        const item = source(step.artifact_ordinal!)!;
        const ok = await run(step, async () => {
          this.fault('after-hook-intent');
          if (!step.hook_approval_id || !this.options.hookExecutor
            || this.options.hookExecutor.profile !== step.executor_profile) {
            throw new Error('approved hook executor is unavailable');
          }
          const hooks = inspectNpmTarball(await readFile(join(dirs.quarantine, `${step.artifact_ordinal}.tgz`)))
            .lifecycleHooks;
          await this.options.hookExecutor.run({ instanceKey: item.lock.instance_key,
            directory: join(dirs.staging, `i${step.artifact_ordinal}`), hooks });
        });
        if (!ok) return fail('step-failed');
      }
      if (!await exists(dirs.generation)) {
        const partial = `${dirs.generation}.partial`;
        await rm(partial, { recursive: true, force: true });
        await mkdir(partial, { recursive: true });
        for (const row of [...lockRows].sort((a, b) => a.instance_key.length - b.instance_key.length)) {
          await cp(join(dirs.staging, `i${row.ordinal}`), join(partial, row.instance_key),
            { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        }
        await rename(partial, dirs.generation);
      }
      await move('staged');
    }
    if (generation.state === 'staged') {
      if (!await this.claim(installation, generationId)) return fail('ownership-collision', 'rejected');
      await move('activating', { admission: await this.admit(fence) });
    }
    if (generation.state === 'activating') {
      const prior = installation.active_generation_id;
      const priorMounts = prior ? await this.mountPaths(prior) : [];
      if (generation.operation === 'remove') {
        const owned = (await this.pool.query<{ path: string }>(`SELECT path FROM pkg.installation_path_claim
          WHERE installation_id = $1 AND ownership = 'installation' ORDER BY collision_key`,
        [installationId])).rows.map(row => row.path);
        const ok = await run(byAction('remove')[0]!, async () => {
          for (const [index, path] of owned.entries()) {
            if (index === 1) this.fault('mid-remove');
            await this.unlinkOwned(root, path);
          }
        });
        if (!ok) return fail('step-failed');
      } else {
        const next = await this.mountPaths(generationId);
        for (const path of next) {
          if (await unsafeParent(root, path)
            || !await admissibleMount(root, path, [prior, generationId].filter((id): id is string => !!id))) {
            return fail('ownership-collision');
          }
        }
        const ok = await run(byAction('switch')[0]!, async () => {
          this.fault('after-switch-intent');
          for (const [index, path] of next.entries()) {
            if (index === 1) this.fault('mid-switch');
            const link = join(root, path);
            await mkdir(dirname(link), { recursive: true });
            const current = await lstat(link).catch(() => null);
            if (current && !current.isSymbolicLink()) throw new Error(`unowned entry occupies ${path}`);
            const temporary = `${link}.rezics-${generationId}`;
            await rm(temporary, { force: true });
            await symlink(relative(dirname(link), join(dirs.generation, path)), temporary);
            await rename(temporary, link);
          }
          for (const path of priorMounts.filter(item => !next.includes(item))) await this.unlinkOwned(root, path);
        });
        if (!ok) return fail('ownership-collision');
      }
      this.fault('before-activation-commit');
      await this.activate(installation, generation);
      this.fault('after-activation-commit');
      await rm(dirs.staging, { recursive: true, force: true });
      await rm(dirs.quarantine, { recursive: true, force: true });
      if (generation.operation === 'remove') {
        const owned = (await this.pool.query<{ id: string }>(`SELECT id FROM pkg.installation_generation
          WHERE installation_id = $1`, [installationId])).rows;
        for (const row of owned) await rm(join(root, '.rezics', 'generations', row.id), { recursive: true, force: true });
      }
      generation = (await this.generation(principalId, installationId, generationId))!;
    }
    return { generation: await this.view(generation), replayed: false };
  }

  private async admit(fence: () => Promise<boolean>): Promise<string> {
    if (!await fence()) throw new PackageInstallDenied('installation authority is no longer current');
    return randomUUID();
  }

  private async activate(installation: InstallationRow, generation: InstallationGenerationRow): Promise<void> {
    await transaction(this.pool, async client => {
      const head = (await client.query<InstallationRow>('SELECT * FROM pkg.installation WHERE id = $1 FOR UPDATE',
        [installation.id])).rows[0]!;
      if (head.active_generation_id !== generation.expected_prior_generation_id) {
        throw new PackageInstallStale('installation head moved');
      }
      if (head.active_generation_id) {
        await client.query(`UPDATE pkg.installation_generation SET state = 'superseded' WHERE id = $1`,
          [head.active_generation_id]);
      }
      await client.query(`UPDATE pkg.installation_generation SET state = 'active' WHERE id = $1`, [generation.id]);
      await client.query(`UPDATE pkg.installation SET active_generation_id = $2, head_epoch = head_epoch + 1,
          state = $3 WHERE id = $1 AND head_epoch = $4`, [installation.id, generation.id,
        generation.operation === 'remove' ? 'removed' : 'present', head.head_epoch]);
      await client.query(`DELETE FROM pkg.installation_path_claim c WHERE c.installation_id = $1
          AND c.ownership = 'installation' AND NOT EXISTS (SELECT 1 FROM pkg.installation_path p
            WHERE p.generation_id = $2 AND p.collision_key = c.collision_key)`,
      [installation.id, generation.id]);
    });
  }

  /** Claim every owned path of the generation; false when another installation owns one. */
  private async claim(installation: InstallationRow, generationId: string): Promise<boolean> {
    const collided = new Error('ownership collision');
    return transaction(this.pool, async client => {
      const paths = (await client.query<{ path: string; collision_key: string; ownership: string }>(
        `SELECT path, collision_key, ownership FROM pkg.installation_path WHERE generation_id = $1`,
        [generationId])).rows;
      for (const path of paths) {
        const conflicting = await client.query(`SELECT 1 FROM pkg.installation_path_claim
          WHERE target_key = $1 AND installation_id <> $2 AND (collision_key = ANY($3::text[])
            OR left(collision_key, length($4) + 1) = $4 || '/') LIMIT 1`,
        [installation.target_key, installation.id, [path.collision_key, ...ancestors(path.collision_key)],
          path.collision_key]);
        if (conflicting.rowCount) throw collided;
        await client.query(`INSERT INTO pkg.installation_path_claim (target_key, collision_key,
            installation_id, path, ownership) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (target_key, collision_key) DO NOTHING`,
        [installation.target_key, path.collision_key, installation.id, path.path, path.ownership]);
        const holder = (await client.query<{ installation_id: string }>(`SELECT installation_id
          FROM pkg.installation_path_claim WHERE target_key = $1 AND collision_key = $2`,
        [installation.target_key, path.collision_key])).rows[0];
        if (holder?.installation_id !== installation.id) throw collided;
      }
      return true;
    }).catch((error: unknown) => {
      if (error === collided) return false;
      throw error;
    });
  }

  private async releaseUnactivatedClaims(installation: InstallationRow, generationId: string): Promise<void> {
    await this.pool.query(`DELETE FROM pkg.installation_path_claim c WHERE c.installation_id = $1
        AND c.ownership = 'installation'
        AND EXISTS (SELECT 1 FROM pkg.installation_path p WHERE p.generation_id = $2
          AND p.collision_key = c.collision_key)
        AND NOT EXISTS (SELECT 1 FROM pkg.installation_path p JOIN pkg.installation i
          ON i.active_generation_id = p.generation_id WHERE i.id = $1 AND p.collision_key = c.collision_key)`,
    [installation.id, generationId]);
  }

  private async unlinkOwned(root: string, path: string): Promise<void> {
    const link = join(root, path);
    const current = await lstat(link).catch(() => null);
    if (!current?.isSymbolicLink()) return;
    const target = await readlink(link);
    if (target.split('/').includes('.rezics')) await unlink(link);
  }

  private async mountPaths(generationId: string): Promise<string[]> {
    return (await this.pool.query<{ path: string }>(`SELECT path FROM pkg.installation_path
      WHERE generation_id = $1 AND ownership = 'installation' ORDER BY path`, [generationId])).rows
      .map(row => row.path);
  }

  private async record(generationId: string, step: number, event: string, effect: string,
    evidence: Record<string, unknown>): Promise<void> {
    await this.pool.query(`INSERT INTO pkg.installation_journal (generation_id, sequence, step_ordinal,
        event, effect, evidence) SELECT $1, COALESCE(max(sequence), 0) + 1, $2, $3, $4, $5
      FROM pkg.installation_journal WHERE generation_id = $1`,
    [generationId, step, event, effect, JSON.stringify(evidence)]);
  }

  private async lastEvents(generationId: string): Promise<Map<number, { event: string; effect: string }>> {
    const rows = (await this.pool.query<{ step_ordinal: number; event: string; effect: string }>(`SELECT DISTINCT
        ON (step_ordinal) step_ordinal, event, effect FROM pkg.installation_journal WHERE generation_id = $1
      ORDER BY step_ordinal, sequence DESC`, [generationId])).rows;
    return new Map(rows.map(row => [row.step_ordinal, { event: row.event, effect: row.effect }]));
  }

  private fault(point: InstallFault): void {
    if (typeof this.options.fault === 'function') this.options.fault(point);
    if (this.options.fault === point) throw new SimulatedInstallCrash(`simulated crash ${point}`);
  }

  private root(target: string): string {
    return join(this.options.rootDirectory, 'roots', sha(target));
  }

  private validate(key: string, request: GenerationRequest): void {
    const ops = ['install', 'update', 'rollback', 'remove'];
    if (!KEY.test(key) || !request || !ops.includes(request.operation)
      || (request.expectedGeneration !== null && !UUID.test(request.expectedGeneration))
      || ((request.operation === 'install' || request.operation === 'update')
        !== (typeof request.lock === 'string' && UUID.test(request.lock)))
      || ((request.operation === 'rollback') !== (typeof request.rollbackOf === 'string'
        && UUID.test(request.rollbackOf)))
      || (request.operation !== 'install' && request.operation !== 'update' && request.lock !== null)
      || (request.operation !== 'rollback' && request.rollbackOf !== null)
      || !Array.isArray(request.userData) || request.userData.length > 64
      || !Array.isArray(request.approveHooks) || request.approveHooks.length > 256) {
      throw new PackageInstallInvalid('generation request is malformed');
    }
    for (const item of request.userData) {
      if (!confinedPath(item.path) || !['file', 'directory'].includes(item.kind)) {
        throw new PackageInstallInvalid('user data paths must be confined');
      }
    }
    if (request.approveHooks.length && !this.options.hookExecutor) {
      throw new PackageInstallInvalid('no approved hook executor is configured');
    }
  }

  private async installation(principalId: string, id: string): Promise<InstallationRow | undefined> {
    if (!UUID.test(id)) return undefined;
    return (await this.pool.query<InstallationRow>(`SELECT * FROM pkg.installation
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
  }

  private async generation(principalId: string, installationId: string, id: string):
    Promise<InstallationGenerationRow | undefined> {
    if (!UUID.test(id)) return undefined;
    return (await this.pool.query<InstallationGenerationRow>(`SELECT * FROM pkg.installation_generation
      WHERE id = $1 AND installation_id = $2 AND principal_id = $3`, [id, installationId, principalId])).rows[0];
  }

  private async generationByKey(principalId: string, key: string): Promise<InstallationGenerationRow | undefined> {
    return (await this.pool.query<InstallationGenerationRow>(`SELECT * FROM pkg.installation_generation
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
  }

  private async rollbackLock(installation: InstallationRow, request: GenerationRequest): Promise<string> {
    const row = (await this.pool.query<{ lock_id: string | null }>(`SELECT lock_id FROM pkg.installation_generation
      WHERE id = $1 AND installation_id = $2 AND state = 'superseded'`, [request.rollbackOf, installation.id])).rows[0];
    if (!row?.lock_id) throw new PackageInstallInvalid('rollback target is not a superseded generation');
    return row.lock_id;
  }

  /** Retained bytes per lock ordinal: the latest verified replay, or the restored generation's own. */
  private async sources(principalId: string, installation: InstallationRow, request: GenerationRequest):
    Promise<Source[]> {
    if (request.operation === 'remove') return [];
    if (request.operation === 'rollback') {
      await this.rollbackLock(installation, request);
      return (await this.pool.query<LockArtifactRow & { source: string }>(`SELECT l.*, i.artifact_id AS source
        FROM pkg.installation_artifact i JOIN pkg.lock_artifact l
          ON l.lock_id = i.lock_id AND l.ordinal = i.artifact_ordinal
        WHERE i.generation_id = $1 ORDER BY l.ordinal`, [request.rollbackOf])).rows
        .map(row => ({ lock: row, artifact: row.source }));
    }
    const lock = await this.locks.read(principalId, request.lock!);
    if (!lock) throw new PackageInstallUnavailable('lock is unavailable');
    const replay = await this.locks.latestVerifiedReplay(principalId, request.lock!);
    if (!replay) throw new PackageInstallInvalid('lock has no verified replay with retained artifacts');
    const rows = (await this.pool.query<LockArtifactRow>(`SELECT * FROM pkg.lock_artifact
      WHERE lock_id = $1 ORDER BY ordinal`, [request.lock])).rows;
    return rows.map(row => ({ lock: row, artifact: replay.artifacts[row.ordinal]!.artifact! }));
  }

  /** Read-only plan analysis over retained verified bytes and current root claims. */
  private async analyze(installation: InstallationRow, generationId: string, request: GenerationRequest,
    sources: Source[]): Promise<Analysis> {
    const violations: PlanViolation[] = [];
    const steps: PlannedStep[] = [];
    const paths: PlannedPath[] = [];
    if (request.operation === 'remove') {
      steps.push({ action: 'remove', stepKey: 'remove', artifact: null, executesCode: false, idempotent: true,
        approved: false, compensation: 'none' });
      return { reason: null, violations, steps, paths };
    }
    if (sources.some(item => item.lock.ecosystem !== 'npm')) {
      throw new PackageInstallInvalid('this installation layout admits npm archives only');
    }
    const digests = (await this.pool.query<{ id: string; sha256: string; state: string }>(`SELECT id, sha256, state
      FROM pkg.artifact WHERE id = ANY($1::uuid[])`, [sources.map(item => item.artifact)])).rows;
    const revoked = await this.locks.artifacts.revoked([...digests.map(item => item.sha256),
      ...sources.filter(item => item.lock.digest_algorithm === 'sha256').map(item => item.lock.digest_value!)]);
    for (const item of sources) {
      const artifact = digests.find(row => row.id === item.artifact);
      if (!artifact || revoked.has(artifact.sha256)
        || (item.lock.digest_algorithm === 'sha256' && revoked.has(item.lock.digest_value!))) {
        violations.push({ reason: 'artifact-revoked', instanceKey: item.lock.instance_key,
          detail: artifact?.sha256 ?? 'missing' });
      } else if (artifact.state !== 'verified') {
        violations.push({ reason: 'artifact-unverified', instanceKey: item.lock.instance_key });
      }
    }
    if (violations.length) return { reason: violations[0]!.reason, violations, steps, paths };
    const hooks = new Map<number, string[]>();
    for (const item of sources) {
      const coordinate = item.lock.coordinate as LockedArtifact['coordinate'];
      if (!confinedPath(item.lock.instance_key)) {
        violations.push({ reason: 'path-traversal', kind: 'path-traversal', path: item.lock.instance_key,
          instanceKey: item.lock.instance_key });
        continue;
      }
      const inspection = inspectNpmTarball((await this.locks.artifacts.read(item.artifact)).bytes);
      for (const violation of inspection.violations) {
        violations.push({ reason: violation.kind === 'case-collision' ? 'ownership-collision' : 'path-traversal',
          ...violation, instanceKey: item.lock.instance_key });
      }
      const found = [...inspection.lifecycleHooks, ...(coordinate.hasInstallScript
        && !inspection.lifecycleHooks.length ? ['registry:hasInstallScript'] : [])];
      if (found.length) hooks.set(item.lock.ordinal, found);
    }
    const ordered = [...sources].sort((a, b) => a.lock.ordinal - b.lock.ordinal);
    for (const item of ordered) {
      for (const action of ['fetch', 'verify', 'unpack'] as const) {
        steps.push({ action, stepKey: `${action}:${item.lock.ordinal}`, artifact: item.lock.ordinal,
          executesCode: false, idempotent: true, approved: false, compensation: 'discard-staging' });
      }
    }
    for (const item of ordered.filter(entry => hooks.has(entry.lock.ordinal))) {
      const approved = request.approveHooks.includes(item.lock.instance_key);
      if (!approved) {
        violations.push({ reason: 'unapproved-hook', instanceKey: item.lock.instance_key,
          detail: hooks.get(item.lock.ordinal)!.join(',') });
      }
      steps.push({ action: 'build', stepKey: `build:${item.lock.ordinal}`, artifact: item.lock.ordinal,
        executesCode: true, idempotent: false, approved, compensation: 'inspect-effect' });
    }
    steps.push({ action: 'switch', stepKey: 'switch', artifact: null, executesCode: false, idempotent: true,
      approved: false, compensation: 'restore-prior-generation' });
    const visible = mounts(ordered.map(item => item.lock.instance_key));
    for (const item of ordered.filter(entry => visible.has(entry.lock.instance_key))) {
      paths.push({ path: item.lock.instance_key, kind: 'directory', ownership: 'installation',
        step: steps.findIndex(step => step.stepKey === `unpack:${item.lock.ordinal}`) });
    }
    for (const item of request.userData) {
      paths.push({ path: item.path, kind: item.kind, ownership: 'user-data', step: steps.length - 1 });
    }
    for (const path of paths.filter(item => item.ownership === 'installation')) {
      const root = this.root(installation.target_key);
      if (await unsafeParent(root, path.path)
        || !await admissibleMount(root, path.path,
          installation.active_generation_id ? [installation.active_generation_id] : [])) {
        violations.push({ reason: 'ownership-collision', path: path.path,
          detail: 'a mount path or parent is not owned by this installation' });
      }
    }
    const keys = paths.map(path => collisionKey(path.path));
    for (const [index, key] of keys.entries()) {
      if (keys.some((other, position) => position !== index
        && (other === key || key.startsWith(`${other}/`)))) {
        violations.push({ reason: 'ownership-collision', path: paths[index]!.path, detail: 'within plan' });
      }
    }
    if (keys.length) {
      const held = (await this.pool.query<{ path: string; collision_key: string }>(`SELECT path, collision_key
        FROM pkg.installation_path_claim WHERE target_key = $1 AND installation_id <> $2
          AND (collision_key = ANY($3::text[]) OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS k(key)
            WHERE left(collision_key, length(k.key) + 1) = k.key || '/'))`,
      [installation.target_key, installation.id, [...keys, ...keys.flatMap(ancestors)]])).rows;
      for (const claim of held) {
        if (!violations.some(item => item.reason === 'ownership-collision' && item.path === claim.path)) {
          violations.push({ reason: 'ownership-collision', path: claim.path,
            detail: 'held by another installation' });
        }
      }
    }
    const order: PlanViolation['reason'][] = ['artifact-revoked', 'artifact-unverified', 'path-traversal',
      'ownership-collision', 'unapproved-hook'];
    const reason = order.find(item => violations.some(violation => violation.reason === item)) ?? null;
    void generationId;
    return { reason, violations, steps, paths };
  }

  private async view(row: InstallationGenerationRow): Promise<GenerationView> {
    const [steps, paths, last, instances] = await Promise.all([
      this.pool.query<InstallationStepRow>(`SELECT * FROM pkg.installation_step WHERE generation_id = $1
        ORDER BY ordinal`, [row.id]),
      this.pool.query<{ path: string; kind: string; ownership: string }>(`SELECT path, kind, ownership
        FROM pkg.installation_path WHERE generation_id = $1 ORDER BY path`, [row.id]),
      this.lastEvents(row.id),
      row.lock_id ? this.pool.query<{ ordinal: number; instance_key: string }>(`SELECT ordinal, instance_key
        FROM pkg.lock_artifact WHERE lock_id = $1`, [row.lock_id]) : Promise.resolve({ rows: [] })]);
    const instance = new Map(instances.rows.map(item => [item.ordinal, item.instance_key]));
    return { generation: row.id, installation: row.installation_id, number: row.number, operation: row.operation,
      state: row.state, terminalReason: row.terminal_reason, lock: row.lock_id,
      expectedGeneration: row.expected_prior_generation_id, rollbackOf: row.rollback_of_generation_id,
      planSha256: row.plan_sha256,
      steps: steps.rows.map(step => ({ ordinal: step.ordinal, action: step.action, stepKey: step.step_key,
        instanceKey: step.artifact_ordinal === null ? null : instance.get(step.artifact_ordinal) ?? null,
        executesCode: step.executes_code, idempotent: step.idempotent, approved: step.hook_approval_id !== null,
        lastEvent: last.get(step.ordinal)?.event ?? null })),
      paths: paths.rows, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
  }
}
