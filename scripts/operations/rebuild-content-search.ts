import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { loadDockerEnvironment } from '../load/docker-env.ts';
import { resumeActivatedContentRebuild }
  from '../../services/main/src/modules/content-publication/rebuild.ts';
import { assertSavedStackRawUpdate, assertSavedStackStorage, composeProcessEnvironment,
  parseOptions, projectName,
  readEnv, stackDirectory } from '../dev/config.ts';
import { COMMAND_MODULE_VERSION } from '../../services/main/src/infrastructure/profile.ts';
import { DEFAULT_RESERVE_BYTES, rebuildPublicContentSearch, repositoryPins,
  type FusekiStateRunner } from './search-state.ts';
import { withQaStackStartup } from '../qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../..');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: task search:rebuild -- [--job <uuid>] [--reserve-bytes <n>] [--profile qa --run-id <id> --persistent [--raw-update]]';
const args = process.argv.slice(2);
function option(name: string, pattern: RegExp): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || !pattern.test(value)) throw new Error(USAGE);
  args.splice(at, 2);
  return value;
}
const jobArg = option('--job', UUID);
const reserveArg = option('--reserve-bytes', /^(0|[1-9][0-9]{0,15})$/);
const reserveBytes = reserveArg === undefined ? DEFAULT_RESERVE_BYTES : Number(reserveArg);
if (!Number.isSafeInteger(reserveBytes)) throw new Error(USAGE);
const stackArgs = args;
const options = parseOptions(stackArgs);
if (options.profile === 'qa' && (!options.runId || !options.persistent)) {
  throw new Error('QA rebuild requires --profile qa --run-id <id> --persistent');
}
const stack = stackDirectory(root, options);
const jobFile = join(stack, 'content-rebuild.json');

function compose(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('docker', ['compose', '--env-file', join(stack, 'compose.env'),
    '-f', join(root, 'infra/dev/compose.yaml'),
    ...(options.rawUpdate ? ['-f', join(root, 'infra/dev/compose.qa-raw-update.yaml')] : []),
    '--project-name', projectName(options), ...args],
  { cwd: root, env: composeProcessEnvironment(env, readEnv(join(stack, 'compose.env'))),
    encoding: 'utf8', timeout: 300_000, maxBuffer: 10_000_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker Compose ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  }
  return `${result.stdout}${result.stderr}`;
}

async function assertWritersStopped(mainOrigin: string): Promise<void> {
  try {
    await fetch(new URL('/health/live', mainOrigin), { signal: AbortSignal.timeout(800) });
    throw new Error('Stop task dev and every Main writer before rebuilding public search');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Stop task dev')) throw error;
  }
}

if (!existsSync(join(stack, 'compose.env')) || !existsSync(join(stack, 'apps.env'))) {
  throw new Error('Stack is absent; run task stack:up first');
}
assertSavedStackStorage(options, readEnv(join(stack, 'compose.env')));
assertSavedStackRawUpdate(options, readEnv(join(stack, 'compose.env')));
const apps = readEnv(join(stack, 'apps.env'));
const saved = existsSync(jobFile) ? JSON.parse(readFileSync(jobFile, 'utf8')) as { id: string } : null;
if (saved && !UUID.test(saved.id)) throw new Error('saved Content rebuild job is invalid');
if (saved && jobArg && saved.id !== jobArg) throw new Error('resume the saved Content rebuild job');
const id = saved?.id ?? jobArg ?? randomUUID();
const docker = loadDockerEnvironment();
const runner: FusekiStateRunner = {
  exec: script => compose(['exec', '-T', 'fuseki', 'sh', '-ec', script], docker),
  offline: script => compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'fuseki', '-ec', script], docker),
  stop: () => { compose(['stop', 'fuseki'], docker); },
  start: async () => {
    const start = () => { compose(['up', '-d', '--wait', 'fuseki'], docker); };
    if (options.profile === 'qa') await withQaStackStartup(root,
      composeProcessEnvironment(docker, readEnv(join(stack, 'compose.env'))), Date.now() + 300_000,
      start, { services: ['fuseki'] });
    else start();
  },
  container: () => compose(['ps', '-q', 'fuseki'], docker).trim(),
};
await assertWritersStopped(apps.MAIN_ORIGIN!);
const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
if ((await fuseki.commandHealth()).moduleVersion !== COMMAND_MODULE_VERSION) {
  throw new Error(`Fuseki command module ${COMMAND_MODULE_VERSION} is required; run task toolchain:install and restart the stack`);
}
if (!saved) writeFileSync(jobFile, JSON.stringify({ id }) + '\n', { mode: 0o600, flag: 'wx' });
const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
try {
  const content = new ContentCore(pool);
  const cursor = new ContentProjectionCursor(pool);
  const env = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!,
    routingEpoch: apps.MAIN_ROUTING_EPOCH! }, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
  const publicConsumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
  const activated = await resumeActivatedContentRebuild(env, cursor, id, publicConsumer);
  if (activated) {
    rmSync(jobFile);
    console.log(JSON.stringify({ job: id, generation: activated, resumed: true }));
  } else {
    const result = await rebuildPublicContentSearch({ runner, dockerEnv: docker, env, content, cursor,
      id, publicConsumer, reserveBytes, assertWritersStopped: () => assertWritersStopped(apps.MAIN_ORIGIN!),
      expected: repositoryPins(root, docker, `${projectName(options)}_fuseki_data`) });
    const logPath = join(stack, `content-rebuild-${id}.log`);
    writeFileSync(logPath, result.offlineLog, { mode: 0o600 });
    rmSync(jobFile);
    console.log(JSON.stringify({ job: id, removed: result.removed, replayed: result.replayed,
      generation: result.generation, logPath, storage: result.storage,
      pins: { imageId: result.pins.imageId, stateVolume: result.pins.stateVolume,
        assembler: result.pins.indexerAssemblerSha256, analyzer: result.pins.facts.analyzer,
        moduleVersion: result.pins.moduleVersion }, elapsedMs: result.elapsedMs }));
  }
} finally {
  await pool.end();
}
