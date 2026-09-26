import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { CommandRejected, FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { appEnvironment, composeProcessEnvironment, createSecrets, readEnv, savePrivate } from '../dev/config.ts';
import { type Corpus, type FixtureProfile, fixtureCorpus, stable } from './corpus.ts';
import { type FixtureManifest, type FixtureManifestCore, manifestCore, manifestIdentity } from './manifest.ts';
import { migrateFixtureOwners } from './migrate.ts';
import { fixtureOwners } from './owners/index.ts';
import type { LoadTarget } from './owners/types.ts';
import { assertGraphReady, checkSamples } from './smoke.ts';
import { VOLUME_KINDS, composeArgs, currentEngines, dockerEnvironment, fixtureDirectory, fixtureProject,
  freshPorts, removeVolumes, root, run, stream, volumeBytes } from './stack.ts';

const ONLINE_SERVICES = ['postgres', 'fuseki', 'rustfs'];

function moduleVersion(image: string): string {
  const version = image.match(/-cmd(\d+\.\d+\.\d+)(?:-|$)/)?.[1];
  if (!version) throw new Error('Fuseki image tag has no command-module version');
  return version;
}

export function readManifest(id: string): FixtureManifest | undefined {
  const path = join(fixtureDirectory(id), 'manifest.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest : undefined;
}

/**
 * Build one deterministic background corpus directly into owner storage, stop
 * every service and keep the stopped named volumes as the fixture backup.
 */
export async function buildFixture(profile: FixtureProfile, seed?: string): Promise<FixtureManifest> {
  const docker = dockerEnvironment();
  const planned = performance.now();
  const corpus = fixtureCorpus(profile, seed);
  const core = manifestCore(root, corpus, fixtureOwners, currentEngines(docker));
  const planMs = Math.round(performance.now() - planned);
  const { id } = manifestIdentity(core);
  return withBuildLock(id, async () => {
    const existing = readManifest(id);
    if (existing) {
      console.log(`Fixture ${id} is already built; restore it with yarn fixture:restore --fixture ${id}`);
      return existing;
    }
    return buildLocked(docker, corpus, core, planMs);
  });
}

/** One builder per fixture ID; a dead holder's lock is stale. */
async function withBuildLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const lock = `${fixtureDirectory(id)}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 1_800_000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(lock, 'utf8'));
      let alive = !Number.isSafeInteger(holder) || holder <= 0;
      try { if (!alive) { process.kill(holder, 0); alive = true; } } catch { /* holder exited */ }
      if (!alive) { rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`fixture ${id} build lock is held by process ${holder}`);
      await Bun.sleep(2_000);
    }
  }
  try { return await work(); } finally { rmSync(lock, { force: true }); }
}

async function buildLocked(docker: NodeJS.ProcessEnv, corpus: Corpus,
  core: FixtureManifestCore, planMs: number): Promise<FixtureManifest> {
  // Planning summarizes every owner's records; lock waiting is excluded.
  const started = Date.now() - planMs;
  const { digest, id } = manifestIdentity(core);
  const engines = core.engines;
  const dir = fixtureDirectory(id);
  const project = fixtureProject(id);
  const volumes = VOLUME_KINDS.map(kind => `${project}_${kind}`);
  const envFile = join(dir, 'compose.env');
  // A directory without a manifest is an interrupted build: discard it whole.
  if (existsSync(envFile)) {
    try { run('docker', composeArgs(project, envFile, ['down', '--volumes', '--remove-orphans']),
      composeProcessEnvironment(docker, readEnv(envFile)), 120_000); } catch { /* removed below */ }
  }
  removeVolumes(volumes, docker);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const evidence = join(root, '.artifacts', 'fixture', id);
  mkdirSync(evidence, { recursive: true });
  const phases: Record<string, number> = { plan: planMs };
  const loads: Record<string, unknown> = {};
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    try { return await work(); } finally {
      phases[name] = Math.round(performance.now() - at);
      console.log(`fixture ${id}: ${name} ${phases[name]} ms`);
    }
  };
  const saved = { ...createSecrets(), ...await freshPorts(),
    MAIN_DATA_EPOCH: corpus.lineage.dataEpoch, MAIN_ROUTING_EPOCH: corpus.lineage.routingEpoch,
    REZICS_STACK_STORAGE: 'persistent', REZICS_STACK_RAW_UPDATE: '0' };
  savePrivate(envFile, saved);
  const apps = appEnvironment(saved, dir);
  const env = composeProcessEnvironment(docker, readEnv(envFile));
  const compose = (command: string[], timeout = 300_000) => run('docker', composeArgs(project, envFile, command), env, timeout);
  // Pools connect lazily, only once PostgreSQL is up for the online owners.
  let pools: LoadTarget['pools'] | undefined = {
    access: new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 2 }),
    content: new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 2 }) };
  try {
    const target: LoadTarget = { root, apps, pools,
      fusekiOffline: (script, input) => stream('docker', composeArgs(project, envFile,
        ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'fuseki', '-ec', script]), env, input) };
    await phase('start', async () => { compose(['up', '-d', '--wait', ...ONLINE_SERVICES]); });
    await phase('migrate', async () => { await migrateFixtureOwners(apps); });
    // The command module bootstraps only an empty dataset, so the real bootstrap
    // commits first and the offline owners then load into the stopped TDB2.
    await phase('bootstrap-graph', async () => {
      const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN);
      const health = await fuseki.commandHealth();
      if (health.moduleVersion !== moduleVersion(engines.fuseki.image)) {
        throw new Error(`Fuseki command module ${health.moduleVersion} differs from ${engines.fuseki.image}`);
      }
      await initializeFreshGraph(fuseki, corpus.lineage);
      compose(['stop', 'fuseki']);
    });
    for (const owner of fixtureOwners.filter(item => item.phase === 'offline-graph')) {
      loads[owner.name] = await phase(`load:${owner.name}`, () => owner.load(corpus, target));
    }
    await phase('restart-graph', async () => { compose(['up', '-d', '--wait', 'fuseki']); });
    await phase('load:online', async () => {
      const online = fixtureOwners.filter(item => item.phase === 'online');
      const results = await Promise.all(online.map(owner => owner.load(corpus, target)));
      online.forEach((owner, index) => { loads[owner.name] = results[index]; });
    });
    const index = await phase('verify', async () => {
      for (const owner of fixtureOwners) {
        const actual = await owner.verify(corpus, target);
        const planned = core.owners[owner.name]!.counts;
        if (stable(actual) !== stable(planned)) {
          throw new Error(`${owner.name} stored ${JSON.stringify(actual)}, planned ${JSON.stringify(planned)}`);
        }
      }
      await checkSamples(apps, core, target.pools);
      return assertGraphReady(apps, core);
    });
    await Promise.all([pools.access.end(), pools.content.end()]);
    pools = undefined;
    // Stopped whole volumes are the consistent cut: no live TDB2 or PostgreSQL copy.
    await phase('stop', async () => { compose(['down']); });
    const bytes = await phase('measure', async () => volumeBytes(volumes, docker));
    const manifest: FixtureManifest = { ...core, id, digest,
      build: { startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started, phases, textIndexGeneration: index.generation, loads },
      backup: { project, volumes: bytes } };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(evidence, 'build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Fixture ${id} built in ${manifest.build.elapsedMs} ms; evidence ${evidence}/build.json`);
    return manifest;
  } catch (error) {
    writeFileSync(join(evidence, 'failure.json'), `${JSON.stringify({ id, phases, loads,
      failure: error instanceof Error ? error.message : String(error),
      ...(error instanceof CommandRejected ? { command: error.result } : {}) }, null, 2)}\n`);
    if (pools) await Promise.all([pools.access.end(), pools.content.end()]).catch(() => undefined);
    try { compose(['down', '--volumes', '--remove-orphans'], 120_000); } catch { /* volumes removed below */ }
    removeVolumes(volumes, docker);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
