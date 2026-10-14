import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { appEnvironment, composeProcessEnvironment, ensureSecrets, readEnv, replacePrivate, stackDirectory, type StackOptions } from '../dev/config.ts';
import { startDevCompose } from '../dev/cli.ts';
import { type StartupMemoryOptions } from '../qa/memory-admission.ts';
import { qaStartupServices, rememberQaStack, QA_STACK_TIER } from '../qa/stack-ownership.ts';
import { ownerReady } from '../load/restore.ts';
import { readManifest } from './build.ts';
import { DEFAULT_SEED, type FixtureProfile } from './corpus.ts';
import { FixtureWorkBudget } from './budget.ts';
import { type FixtureManifest, type RestoreCompatibility, migrationInventory,
  restoreCompatibility } from './manifest.ts';
import { migrateFixtureOwners } from './migrate.ts';
import { fixtureOwners } from './owners/index.ts';
import type { FixtureOwner } from './owners/types.ts';
import { assertGraphReady, checkSamples } from './smoke.ts';
import { VOLUME_KINDS, composeArgs, copyVolume, currentEngines, dockerEnvironment, fixtureDirectory, fixtureProject, fixtureRoot,
  freshPorts, projectRunning, root, volumeExists } from './stack.ts';
import { redactCommandOutput } from './command-output.ts';
import { fixtureModel } from './model.ts';
import { alignFixtureModel, type FixtureModelAlignment } from './align-model.ts';
import { ModelAlignmentTimeout } from './model-deadline.ts';

export const RESTORE_DEADLINE_MS = 600_000;

/** Queueing uses the run deadline; Compose readiness uses only active restore time. */
export function startRestoredFixture<T>(budget: FixtureWorkBudget, env: NodeJS.ProcessEnv,
  start: (timeout: number) => T | Promise<T>, admission: Partial<StartupMemoryOptions> = {}): Promise<T> {
  return startDevCompose(root, env, 'qa', timeout => start(Math.min(timeout, budget.remaining())), {
    ...admission, onAdmissionWait: ms => {
      budget.excludeAdmissionWait(ms);
      admission.onAdmissionWait?.(ms);
    },
  });
}

/** Owner generators, migration bytes and engine images a restore compares with a manifest. */
export function fixtureRestoreInputs(docker: NodeJS.ProcessEnv,
  owners: readonly FixtureOwner[] = fixtureOwners): Parameters<typeof restoreCompatibility>[1] {
  return { owners: Object.fromEntries(owners.map(owner => [owner.name,
    { generator: owner.generator, inputs: owner.compatibilityInputs(root) }])),
  migrations: migrationInventory(root), engines: currentEngines(docker),
  modelGeneration: fixtureModel(root).generation };
}

/** Newest retained backup of this profile and seed that the current checkout can restore. */
export function compatibleFixture(profile: FixtureProfile, seed = DEFAULT_SEED): FixtureManifest | undefined {
  const directory = fixtureRoot;
  if (!existsSync(directory)) return undefined;
  const current = fixtureRestoreInputs(dockerEnvironment());
  return readdirSync(directory).map(id => readManifest(id))
    .filter((manifest): manifest is FixtureManifest => manifest?.profile === profile && manifest.seed === seed
      && restoreCompatibility(manifest, current).compatible)
    .sort((a, b) => b.build.completedAt.localeCompare(a.build.completedAt))[0];
}

export interface FixtureRestoreEvidence {
  fixture: string; target: string; profile: string; works: number; startedAt: string;
  deadlineMs: number; compatibility?: RestoreCompatibility; phases: Record<string, number>;
  copyMs?: Record<string, number>;
  modelAlignment?: FixtureModelAlignment;
  appliedMigrations?: string[]; ready?: string[]; samples?: number; graph?: { generation: string; sequence: string };
  /** Active restore work; admission queueing is reported separately. */
  elapsedMs?: number; admissionWaitMs?: number;
  completedAt?: string; failure?: string; artifacts: string;
  failurePhase?: string; failureKind?: 'timeout' | 'error';
}

export class FixtureRestoreFailure extends Error {
  constructor(readonly evidence: FixtureRestoreEvidence, cause: unknown) {
    super(evidence.failure, { cause }); this.name = 'FixtureRestoreFailure';
  }
}

/** Phase injection replaces external owners while exercising the restore lifecycle. */
export interface FixtureRestoreRuntime {
  readManifest: typeof readManifest;
  inputs: typeof fixtureRestoreInputs;
  docker: typeof dockerEnvironment;
  projectRunning: typeof projectRunning;
  volumeExists: typeof volumeExists;
  readApps: typeof readEnv;
  alignModel: typeof alignFixtureModel;
  runPhase: <T>(name: string, work: () => T | Promise<T>) => Promise<T>;
  cleanup: (target: string, targetDir: string, volumes: string[], docker: NodeJS.ProcessEnv, artifacts: string) => void;
  deadlineMs: number;
  artifactsRoot: string;
}

function cleanupRestoredFixture(target: string, targetDir: string, volumes: string[], docker: NodeJS.ProcessEnv, artifacts: string) {
  const logs = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', target, '--persistent'],
    { cwd: root, env: docker, encoding: 'utf8', timeout: 30_000 });
  writeFileSync(join(artifacts, 'stack.log'), [logs.stdout, logs.stderr].filter(Boolean).map(part => redactCommandOutput(part)).join('\n'));
  spawnSync('bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', target, '--persistent'],
    { cwd: root, env: docker, encoding: 'utf8', timeout: 120_000 });
  for (const volume of volumes) spawnSync('docker', ['volume', 'rm', volume], { cwd: root, env: docker, timeout: 30_000 });
  rmSync(targetDir, { recursive: true, force: true });
}

const fixtureRestoreRuntime: FixtureRestoreRuntime = {
  readManifest, inputs: fixtureRestoreInputs, docker: dockerEnvironment, projectRunning, volumeExists,
  readApps: readEnv, alignModel: alignFixtureModel, runPhase: async (_name, work) => work(),
  cleanup: cleanupRestoredFixture, deadlineMs: RESTORE_DEADLINE_MS,
  artifactsRoot: join(root, '.artifacts', 'fixture-restore'),
};

/**
 * Restore an isolated writable QA stack from one stopped fixture backup under one
 * 600 seconds of active work: copy volumes, start services, apply only newer migrations,
 * check owner readiness and read the manifest's samples. No corpus rescan.
 */
export async function restoreFixture(id: string, target: string,
  owners: readonly FixtureOwner[] = fixtureOwners,
  dependencies: Partial<FixtureRestoreRuntime> = {}): Promise<FixtureRestoreEvidence> {
  const runtime = { ...fixtureRestoreRuntime, ...dependencies };
  const started = Date.now();
  const budget = new FixtureWorkBudget(runtime.deadlineMs);
  const remaining = () => budget.remaining();
  const artifacts = join(runtime.artifactsRoot, target);
  if (existsSync(artifacts)) throw new Error(`Fixture restore evidence already exists: ${target}`);
  mkdirSync(artifacts, { recursive: true });
  const manifest = runtime.readManifest(id);
  if (!manifest) throw new Error(`Fixture ${id} has no retained manifest; run task fixture:build first`);
  const evidence: FixtureRestoreEvidence = { fixture: id, target, profile: manifest.profile,
    works: manifest.entities.works, startedAt: new Date(started).toISOString(),
    deadlineMs: runtime.deadlineMs, phases: {}, artifacts };
  let activePhase: string | undefined;
  let failureCause: unknown;
  const phase = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    const at = performance.now(), waiting = budget.admissionWaitMs();
    activePhase = name;
    try { return await runtime.runPhase(name, work); } finally {
      evidence.phases[name] = Math.round(performance.now() - at - (budget.admissionWaitMs() - waiting));
    }
  };
  const docker = runtime.docker();
  const options: StackOptions = { profile: 'qa', runId: target, persistent: true };
  const targetDir = stackDirectory(root, options);
  const targetVolumes = VOLUME_KINDS.map(kind => `rezics-qa-${target}_${kind}`);
  let created = false;
  let pools: { access: Pool; content: Pool } | undefined;
  try {
    const compatibility = await phase('compatibility', () => restoreCompatibility(manifest,
      runtime.inputs(docker, owners)));
    evidence.compatibility = compatibility;
    if (!compatibility.compatible) {
      throw new Error(`Fixture ${id} is stale; rebuild it: ${compatibility.reasons.join('; ')}`);
    }
    const project = fixtureProject(id);
    if (runtime.projectRunning(project, docker)) throw new Error('Fixture backup project must be stopped');
    for (const kind of VOLUME_KINDS) {
      if (!runtime.volumeExists(`${project}_${kind}`, docker)) throw new Error(`Fixture backup volume is missing: ${kind}`);
    }
    if (existsSync(targetDir) || targetVolumes.some(volume => runtime.volumeExists(volume, docker))) {
      throw new Error(`Restore target ${target} already exists`);
    }
    created = true;
    // Owner credentials and graph lineage are baked into the volumes; only ports are run-local.
    const configurePorts = async () => {
      const saved = { ...readEnv(join(fixtureDirectory(id), 'compose.env')), ...await freshPorts(),
        REZICS_STACK_STORAGE: 'persistent', REZICS_STACK_RAW_UPDATE: '0' };
      // A port collision retries configuration in the same isolated directory.
      replacePrivate(join(targetDir, 'compose.env'), saved);
      const configured = ensureSecrets(root, options, {});
      const apps = appEnvironment(configured, targetDir);
      replacePrivate(join(targetDir, 'apps.env'), apps);
      mkdirSync(apps.MAIN_OBJECT_DIRECTORY!, { recursive: true, mode: 0o700 });
      mkdirSync(apps.MAIN_CANDIDATE_DIRECTORY!, { recursive: true, mode: 0o700 });
    };
    await phase('configure', async () => {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      await configurePorts();
    });
    evidence.copyMs = {};
    await phase('copy', () => Promise.all(VOLUME_KINDS.map(async (kind, index) => {
      const at = performance.now();
      await copyVolume(`${project}_${kind}`, targetVolumes[index]!, docker);
      evidence.copyMs![kind] = Math.round(performance.now() - at);
    })));
    await phase('start', async () => {
      // Concurrent restores choose free ports before Compose binds them, so another
      // stack can take one first; a bind collision gets fresh ports, not a new copy.
      for (let attempt = 1; ; attempt++) {
        rememberQaStack(options);
        const envFile = join(targetDir, 'compose.env');
        const env = composeProcessEnvironment(docker, readEnv(envFile));
        const up = await startRestoredFixture(budget, env, timeout => spawnSync('docker',
          composeArgs(`rezics-qa-${target}`, envFile,
            ['up', '--no-build', '-d', '--wait', ...qaStartupServices(options, env[QA_STACK_TIER])]),
          { cwd: root, env, encoding: 'utf8', timeout }), { project: `rezics-qa-${target}` });
        const log = [up.stdout, up.stderr, up.error?.message].filter((part): part is string => Boolean(part)).map(part => redactCommandOutput(part)).join('\n');
        writeFileSync(join(artifacts, attempt === 1 ? 'stack-up.log' : `stack-up-${attempt}.log`), log);
        if (!up.error && up.status === 0) return;
        const collision = /port is already allocated|address already in use|programming external connectivity/i.test(log);
        if (!collision || attempt >= 3) throw new Error('Restored stack did not start; see stack-up.log');
        spawnSync('bun', ['scripts/dev/cli.ts', 'stack:down', '--profile', 'qa', '--run-id', target, '--persistent'],
          { cwd: root, env: docker, encoding: 'utf8', timeout: Math.min(remaining(), 120_000) });
        await configurePorts();
      }
    });
    const apps = runtime.readApps(join(targetDir, 'apps.env'));
    evidence.appliedMigrations = await phase('migrate', () => migrateFixtureOwners(apps));
    remaining();
    evidence.modelAlignment = await phase('align-model', () => runtime.alignModel(root, targetDir, apps, manifest,
      { remaining, signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining()))) }));
    remaining();
    await phase('ready', async () => {
      for (const [key, database] of [
        ['ACCOUNT_DATABASE_URL', 'account'], ['ACCESS_DATABASE_URL', 'access'],
        ['CONTENT_DATABASE_URL', 'content'], ['ACCOUNT_RELAY_DATABASE_URL', 'relay'],
      ] as const) await ownerReady(apps[key]!, database);
      evidence.graph = await assertGraphReady(apps, manifest);
      evidence.ready = ['account', 'access', 'content', 'relay', 'fuseki', 'lucene', 'rustfs'];
    });
    pools = { access: new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1 }),
      content: new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 1 }) };
    evidence.samples = await phase('smoke', () => checkSamples(apps, manifest, pools!));
    remaining();
  } catch (error) {
    failureCause = error;
    evidence.failure = redactCommandOutput(error instanceof Error ? error.message : String(error));
    evidence.failurePhase = activePhase;
    evidence.failureKind = error instanceof ModelAlignmentTimeout ? 'timeout' : 'error';
  } finally {
    if (pools) await Promise.all([pools.access.end(), pools.content.end()]);
  }
  Object.assign(evidence, budget.timing());
  evidence.completedAt = new Date().toISOString();
  if (evidence.failure && created) {
    // A failed restore leaves no half-built writable copy behind; its logs stay as evidence.
    runtime.cleanup(target, targetDir, targetVolumes, docker, artifacts);
  }
  writeFileSync(join(artifacts, 'run.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Fixture restore artifacts: ${artifacts}`);
  if (evidence.failure) throw new FixtureRestoreFailure(evidence, failureCause);
  return evidence;
}
