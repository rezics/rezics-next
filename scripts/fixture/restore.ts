import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { appEnvironment, readEnv, savePrivate, stackDirectory, type StackOptions } from '../dev/config.ts';
import { ownerReady } from '../load/restore.ts';
import { readManifest } from './build.ts';
import { DEFAULT_SEED, type FixtureProfile } from './corpus.ts';
import { type FixtureManifest, type RestoreCompatibility, migrationInventory,
  restoreCompatibility } from './manifest.ts';
import { migrateFixtureOwners } from './migrate.ts';
import { fixtureOwners } from './owners/index.ts';
import type { FixtureOwner } from './owners/types.ts';
import { assertGraphReady, checkSamples } from './smoke.ts';
import { VOLUME_KINDS, copyVolume, currentEngines, dockerEnvironment, fixtureDirectory, fixtureProject, fixtureRoot,
  freshPorts, projectRunning, root, volumeExists } from './stack.ts';

export const RESTORE_DEADLINE_MS = 600_000;

function currentInputs(docker: NodeJS.ProcessEnv,
  owners: readonly FixtureOwner[] = fixtureOwners): Parameters<typeof restoreCompatibility>[1] {
  return { owners: Object.fromEntries(owners.map(owner => [owner.name,
    { generator: owner.generator, inputs: owner.compatibilityInputs(root) }])),
  migrations: migrationInventory(root), engines: currentEngines(docker) };
}

/** Newest retained backup of this profile and seed that the current checkout can restore. */
export function compatibleFixture(profile: FixtureProfile, seed = DEFAULT_SEED): FixtureManifest | undefined {
  const directory = fixtureRoot;
  if (!existsSync(directory)) return undefined;
  const current = currentInputs(dockerEnvironment());
  return readdirSync(directory).map(id => readManifest(id))
    .filter((manifest): manifest is FixtureManifest => manifest?.profile === profile && manifest.seed === seed
      && restoreCompatibility(manifest, current).compatible)
    .sort((a, b) => b.build.completedAt.localeCompare(a.build.completedAt))[0];
}

export interface FixtureRestoreEvidence {
  fixture: string; target: string; profile: string; works: number; startedAt: string;
  deadlineMs: number; compatibility?: RestoreCompatibility; phases: Record<string, number>;
  copyMs?: Record<string, number>;
  appliedMigrations?: string[]; ready?: string[]; samples?: number; graph?: { generation: string; sequence: string };
  elapsedMs?: number; completedAt?: string; failure?: string; artifacts: string;
}

/**
 * Restore an isolated writable QA stack from one stopped fixture backup under one
 * 600-second deadline: copy volumes, start services, apply only newer migrations,
 * check owner readiness and read the manifest's samples. No corpus rescan.
 */
export async function restoreFixture(id: string, target: string,
  owners: readonly FixtureOwner[] = fixtureOwners): Promise<FixtureRestoreEvidence> {
  const started = Date.now();
  const remaining = () => {
    const left = RESTORE_DEADLINE_MS - (Date.now() - started);
    if (left <= 0) throw new Error('Fixture preparation exceeded 600 seconds');
    return left;
  };
  const artifacts = join(root, '.artifacts', 'fixture-restore', target);
  if (existsSync(artifacts)) throw new Error(`Fixture restore evidence already exists: ${target}`);
  mkdirSync(artifacts, { recursive: true });
  const manifest = readManifest(id);
  if (!manifest) throw new Error(`Fixture ${id} has no retained manifest; run task fixture:build first`);
  const evidence: FixtureRestoreEvidence = { fixture: id, target, profile: manifest.profile,
    works: manifest.entities.works, startedAt: new Date(started).toISOString(),
    deadlineMs: RESTORE_DEADLINE_MS, phases: {}, artifacts };
  const phase = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    const at = performance.now();
    try { return await work(); } finally { evidence.phases[name] = Math.round(performance.now() - at); }
  };
  const docker = dockerEnvironment();
  const options: StackOptions = { profile: 'qa', runId: target, persistent: true };
  const targetDir = stackDirectory(root, options);
  const targetVolumes = VOLUME_KINDS.map(kind => `rezics-qa-${target}_${kind}`);
  let created = false;
  let pools: { access: Pool; content: Pool } | undefined;
  try {
    const compatibility = await phase('compatibility', () => restoreCompatibility(manifest,
      currentInputs(docker, owners)));
    evidence.compatibility = compatibility;
    if (!compatibility.compatible) {
      throw new Error(`Fixture ${id} is stale; rebuild it: ${compatibility.reasons.join('; ')}`);
    }
    const project = fixtureProject(id);
    if (projectRunning(project, docker)) throw new Error('Fixture backup project must be stopped');
    for (const kind of VOLUME_KINDS) {
      if (!volumeExists(`${project}_${kind}`, docker)) throw new Error(`Fixture backup volume is missing: ${kind}`);
    }
    if (existsSync(targetDir) || targetVolumes.some(volume => volumeExists(volume, docker))) {
      throw new Error(`Restore target ${target} already exists`);
    }
    created = true;
    // Owner credentials and graph lineage are baked into the volumes; only ports are run-local.
    const configurePorts = async () => {
      const saved = { ...readEnv(join(fixtureDirectory(id), 'compose.env')), ...await freshPorts(),
        REZICS_STACK_STORAGE: 'persistent', REZICS_STACK_RAW_UPDATE: '0' };
      savePrivate(join(targetDir, 'compose.env'), saved);
      savePrivate(join(targetDir, 'apps.env'), appEnvironment(saved, targetDir));
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
        const up = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:up', '--profile', 'qa', '--run-id', target, '--persistent'],
          { cwd: root, env: docker, encoding: 'utf8', timeout: remaining() });
        const log = [up.stdout, up.stderr, up.error?.message].filter(Boolean).join('\n');
        writeFileSync(join(artifacts, attempt === 1 ? 'stack-up.log' : `stack-up-${attempt}.log`), log);
        if (!up.error && up.status === 0) return;
        const collision = /port is already allocated|address already in use|programming external connectivity/i.test(log);
        if (!collision || attempt >= 3) throw new Error('Restored stack did not start; see stack-up.log');
        spawnSync('bun', ['scripts/dev/cli.ts', 'stack:down', '--profile', 'qa', '--run-id', target, '--persistent'],
          { cwd: root, env: docker, encoding: 'utf8', timeout: Math.min(remaining(), 120_000) });
        await configurePorts();
      }
    });
    const apps = readEnv(join(targetDir, 'apps.env'));
    evidence.appliedMigrations = await phase('migrate', () => migrateFixtureOwners(apps));
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
    evidence.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (pools) await Promise.all([pools.access.end(), pools.content.end()]);
  }
  evidence.elapsedMs = Date.now() - started;
  evidence.completedAt = new Date().toISOString();
  if (evidence.failure && created) {
    // A failed restore leaves no half-built writable copy behind; its logs stay as evidence.
    const logs = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:logs', '--profile', 'qa', '--run-id', target, '--persistent'],
      { cwd: root, env: docker, encoding: 'utf8', timeout: 30_000 });
    writeFileSync(join(artifacts, 'stack.log'), [logs.stdout, logs.stderr].filter(Boolean).join('\n'));
    spawnSync('bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', target, '--persistent'],
      { cwd: root, env: docker, encoding: 'utf8', timeout: 120_000 });
    for (const volume of targetVolumes) {
      spawnSync('docker', ['volume', 'rm', volume], { cwd: root, env: docker, timeout: 30_000 });
    }
    rmSync(targetDir, { recursive: true, force: true });
  }
  writeFileSync(join(artifacts, 'run.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Fixture restore artifacts: ${artifacts}`);
  if (evidence.failure) throw new Error(evidence.failure);
  return evidence;
}
