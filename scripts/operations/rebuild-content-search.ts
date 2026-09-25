import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { activateRebuiltPublicContentSearch, clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut, resumeActivatedContentRebuild }
  from '../../services/main/src/modules/content-publication/rebuild.ts';
import { assertSavedStackRawUpdate, assertSavedStackStorage, composeProcessEnvironment,
  parseOptions, projectName,
  readEnv, stackDirectory } from '../dev/config.ts';

const root = resolve(import.meta.dir, '../..');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const jobAt = args.indexOf('--job');
const jobArg = jobAt < 0 ? undefined : args[jobAt + 1];
if (jobAt >= 0 && (!jobArg || !UUID.test(jobArg))) {
  throw new Error('Usage: yarn search:rebuild [--job <uuid>] [--profile qa --run-id <id> --persistent [--raw-update]]');
}
const stackArgs = jobAt < 0 ? args : args.filter((_, index) => index !== jobAt && index !== jobAt + 1);
const options = parseOptions(stackArgs);
if (options.profile === 'qa' && (!options.runId || !options.persistent)) {
  throw new Error('QA rebuild requires --profile qa --run-id <id> --persistent');
}
const stack = stackDirectory(root, options);
const jobFile = join(stack, 'content-rebuild.json');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const probe = (env: NodeJS.ProcessEnv) => spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
    { env, encoding: 'utf8', timeout: 5_000 }).status === 0;
  if (probe(process.env)) return process.env;
  const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ''}`, 'podman/podman.sock');
  const fallback = { ...process.env, DOCKER_HOST: `unix://${socket}` };
  if (existsSync(socket) && probe(fallback)) return fallback;
  throw new Error('Docker or the adopted Podman user socket is unavailable');
}

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
    throw new Error('Stop yarn dev and every Main writer before rebuilding public search');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Stop yarn dev')) throw error;
  }
}

if (!existsSync(join(stack, 'compose.env')) || !existsSync(join(stack, 'apps.env'))) {
  throw new Error('Stack is absent; run yarn stack:up first');
}
assertSavedStackStorage(options, readEnv(join(stack, 'compose.env')));
assertSavedStackRawUpdate(options, readEnv(join(stack, 'compose.env')));
const apps = readEnv(join(stack, 'apps.env'));
const saved = existsSync(jobFile) ? JSON.parse(readFileSync(jobFile, 'utf8')) as { id: string } : null;
if (saved && !UUID.test(saved.id)) throw new Error('saved Content rebuild job is invalid');
if (saved && jobArg && saved.id !== jobArg) throw new Error('resume the saved Content rebuild job');
const id = saved?.id ?? jobArg ?? randomUUID();
const docker = dockerEnvironment();
await assertWritersStopped(apps.MAIN_ORIGIN!);
const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
if ((await fuseki.commandHealth()).moduleVersion !== '0.5.19') {
  throw new Error('Fuseki command module 0.5.19 is required; run yarn toolchain:install and restart the stack');
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
    const job = await quarantinePublicContentSearch(env, content, id);
    const removed = await clearQuarantinedContentUnits(env, job);
    const replayed = await replayQuarantinedContentCut(env, content, cursor, job);
    await assertWritersStopped(apps.MAIN_ORIGIN!);
    let offlineLog = '';
    let stopped = false;
    try {
      compose(['stop', 'fuseki'], docker);
      stopped = true;
      offlineLog = compose(['run', '--rm', '--no-deps', '--entrypoint', 'sh', 'fuseki', '-ec',
        'rm -rf /fuseki/databases/rezics/lucene && mkdir -p /fuseki/databases/rezics/lucene && java -Xmx2g -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar jena.textindexer --desc=/fuseki/fuseki-text.ttl'], docker);
    } finally {
      if (stopped) compose(['up', '-d', '--wait', 'fuseki'], docker);
    }
    const logPath = join(stack, `content-rebuild-${id}.log`);
    writeFileSync(logPath, offlineLog, { mode: 0o600 });
    const offlineIndexDigest = digest(JSON.stringify({ family: 'jena-textindexer-v1',
      image: 'rezics/fuseki:6.2.0-cmd0.5.19',
      assembler: digest(readFileSync(join(root, 'infra/jena/fuseki-text.ttl'), 'utf8')),
      output: digest(offlineLog) }));
    const generation = await activateRebuiltPublicContentSearch(env, content, cursor, job,
      publicConsumer, offlineIndexDigest);
    rmSync(jobFile);
    console.log(JSON.stringify({ job: id, removed, replayed, generation, logPath }));
  }
} finally {
  await pool.end();
}
