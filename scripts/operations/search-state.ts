import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ContentCore } from '../../services/content/src/core.ts';
import type { ContentProjectionCursor } from '../../services/content/src/projection-cursor.ts';
import { activateRebuiltPublicContentSearch, clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut }
  from '../../services/main/src/modules/content-publication/rebuild.ts';
import type { WorkActivationEnvironment } from '../../services/main/src/modules/work/activate.ts';
import { backfillChapterSearchIndex } from '../../services/main/src/modules/work/search-index-backfill.ts';
import type { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../../services/main/src/infrastructure/profile.ts';
import { fusekiImageFromCompose } from '../load/image.ts';

/**
 * Graph/search state operations shared by `task search:rebuild` and its drills
 * (OPS09, OPS13, OPS15, OPS16). Each step addresses one Fuseki state volume
 * through a runner; nothing here opens a live TDB2 directory from a second JVM
 * or removes a database lock.
 */
export const STATE_DIRECTORY = '/fuseki/databases/rezics';
export const INDEXER_ASSEMBLER = '/fuseki/fuseki-text.ttl';
/** Relative to FUSEKI_BASE, so a restored volume can never resolve to the original. */
export const PINNED_TDB2_LOCATION = 'databases/rezics/tdb2';
export const PINNED_LUCENE_DIRECTORY = 'databases/rezics/lucene';
/** cjk-bigram-v2 analyzer of dataset profile `search-index-cjk-bigram-v3`. */
export const PINNED_ANALYZER = 'com.rezics.jena.FilteredGraphTextAssembler$CjkBigramV2';
export const DEFAULT_RESERVE_BYTES = 268_435_456;
export const OWNER_ENTRYPOINT = '/usr/local/bin/fuseki-owner';
const JENA_JAR = '/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar';
const COMMAND_JAR = '/fuseki/extra/fuseki-command.jar';

export class SearchStateRefused extends Error {}

export interface FusekiStateRunner {
  /** Read-only inspection inside the running Fuseki container. */
  exec(script: string): string;
  /** A one-shot container on the same state volume while Fuseki is stopped. */
  offline(script: string): string;
  stop(): void;
  start(): void | Promise<void>;
  /** The running container ID, or an empty string. */
  container(): string;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function docker(args: string[], env: NodeJS.ProcessEnv, timeout = 120_000): string {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout, maxBuffer: 10_000_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(-2000)}`);
  }
  return `${result.stdout}${result.stderr}`;
}

export interface AssemblerFacts {
  tdb2Location: string;
  luceneDirectory: string;
  analyzer: string;
  textDatasets: number;
}

function onlyValue(text: string, pattern: RegExp, name: string): string {
  const values = [...text.matchAll(pattern)].map(match => match[1]!);
  if (values.length !== 1) throw new SearchStateRefused(`assembler must declare exactly one ${name}`);
  return values[0]!;
}

/** The state paths and analyzer the text dataset opens; comments are ignored. */
export function assemblerFacts(text: string): AssemblerFacts {
  const body = text.split(/\r?\n/).map(line => line.replace(/(^|\s)#.*$/, '')).join('\n');
  return {
    tdb2Location: onlyValue(body, /tdb2:location\s+"([^"]*)"/g, 'tdb2:location'),
    luceneDirectory: onlyValue(body, /text:directory\s+"([^"]*)"/g, 'text:directory'),
    analyzer: onlyValue(body, /text:class\s+"([^"]*)"/g, 'text:class analyzer'),
    textDatasets: [...body.matchAll(/\ba\s+text:TextDataset\b/g)].length,
  };
}

/** OPS16: exact relative state paths and the pinned analyzer, before any index work. */
export function assertPinnedAssembler(facts: AssemblerFacts): void {
  const problems: string[] = [];
  if (facts.tdb2Location !== PINNED_TDB2_LOCATION) problems.push(`TDB2 location ${facts.tdb2Location}`);
  if (facts.luceneDirectory !== PINNED_LUCENE_DIRECTORY) problems.push(`Lucene directory ${facts.luceneDirectory}`);
  if (facts.analyzer !== PINNED_ANALYZER) problems.push(`analyzer ${facts.analyzer}`);
  if (facts.textDatasets !== 1) problems.push(`${facts.textDatasets} text datasets`);
  if (problems.length) throw new SearchStateRefused(`assembler differs from cjk-bigram-v2: ${problems.join(', ')}`);
}

export interface StatePins {
  imageId: string;
  stateVolume: string;
  serverAssembler: string;
  serverAssemblerSha256: string;
  indexerAssemblerSha256: string;
  fusekiJarSha256: string;
  commandJarSha256: string;
  moduleVersion: string;
  facts: AssemblerFacts;
}

export interface ExpectedPins {
  imageId: string;
  /** Repository assemblers keyed by in-container file name. */
  assemblers: Record<string, string>;
  /** The volume the caller intends to operate on. */
  stateVolume: string;
  /** Volumes that must not be opened, such as the original of a restore. */
  isolatedFrom?: string[];
}

/** Repository-pinned engine image and assembler digests for the current checkout. */
export function repositoryPins(root: string, env: NodeJS.ProcessEnv, stateVolume: string,
  isolatedFrom: string[] = []): ExpectedPins {
  const image = fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')).image;
  const imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}'], env, 10_000).trim();
  const assemblers = Object.fromEntries(['fuseki-text.ttl', 'fuseki-text-qa.ttl', 'fuseki-text-qa-raw.ttl']
    .map(name => [name, sha256(readFileSync(join(root, 'infra/jena', name)))]));
  return { imageId, assemblers, stateVolume, isolatedFrom };
}

/** Read the running container's image, state mount, assemblers, jars and module version. */
export async function inspectFusekiState(runner: FusekiStateRunner, env: NodeJS.ProcessEnv,
  fuseki: FusekiClient): Promise<StatePins> {
  const container = runner.container();
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new SearchStateRefused('Fuseki container is not running');
  const inspected = JSON.parse(docker(['inspect', container], env, 10_000))[0] as {
    Image: string; Args: string[]; Path: string;
    Mounts: { Type: string; Name?: string; Destination: string }[] };
  if (inspected.Path !== OWNER_ENTRYPOINT) {
    throw new SearchStateRefused('Fuseki does not run under the state owner entrypoint');
  }
  const mount = inspected.Mounts.filter(item => item.Destination === '/fuseki/databases');
  if (mount.length !== 1 || mount[0]!.Type !== 'volume' || !mount[0]!.Name) {
    throw new SearchStateRefused('Fuseki state is not exactly one named volume');
  }
  const configs = [inspected.Path, ...inspected.Args].filter(arg => arg.startsWith('--config='));
  if (configs.length !== 1) throw new SearchStateRefused('Fuseki server assembler is ambiguous');
  const serverAssembler = configs[0]!.slice('--config='.length);
  if (!/^\/fuseki\/[a-z0-9-]+\.ttl$/.test(serverAssembler)) {
    throw new SearchStateRefused(`Fuseki server assembler ${serverAssembler} is outside the image base`);
  }
  const digests = runner.exec(`sha256sum ${serverAssembler} ${INDEXER_ASSEMBLER} ${JENA_JAR} ${COMMAND_JAR}`)
    .trim().split(/\r?\n/).map(line => line.split(/\s+/)[0] ?? '');
  if (digests.length !== 4 || digests.some(digest => !/^[0-9a-f]{64}$/.test(digest))) {
    throw new SearchStateRefused('Fuseki file digests are unavailable');
  }
  const server = runner.exec(`cat ${serverAssembler}`);
  const indexer = runner.exec(`cat ${INDEXER_ASSEMBLER}`);
  const serverFacts = assemblerFacts(server);
  const facts = assemblerFacts(indexer);
  if (JSON.stringify(serverFacts) !== JSON.stringify(facts)) {
    throw new SearchStateRefused('server and indexer assemblers open different state or analyzers');
  }
  const moduleVersion = (await fuseki.commandHealth()).moduleVersion;
  return { imageId: inspected.Image, stateVolume: mount[0]!.Name!, serverAssembler,
    serverAssemblerSha256: digests[0]!, indexerAssemblerSha256: digests[1]!,
    fusekiJarSha256: digests[2]!, commandJarSha256: digests[3]!,
    moduleVersion, facts };
}

/** OPS16: every mismatch refuses before the index directory or text generation changes. */
export function assertPinnedState(pins: StatePins, expected: ExpectedPins): void {
  const problems: string[] = [];
  if (pins.imageId !== expected.imageId) problems.push(`image ${pins.imageId}`);
  if (pins.stateVolume !== expected.stateVolume) problems.push(`state volume ${pins.stateVolume}`);
  if (expected.isolatedFrom?.includes(pins.stateVolume)) problems.push('state volume is the isolated original');
  if (pins.moduleVersion !== COMMAND_MODULE_VERSION) problems.push(`command module ${pins.moduleVersion}`);
  if (expected.assemblers[basename(pins.serverAssembler)] !== pins.serverAssemblerSha256) {
    problems.push(`server assembler ${pins.serverAssembler}`);
  }
  if (expected.assemblers['fuseki-text.ttl'] !== pins.indexerAssemblerSha256) problems.push('indexer assembler');
  try { assertPinnedAssembler(pins.facts); }
  catch (error) { problems.push((error as Error).message); }
  if (problems.length) throw new SearchStateRefused(`Fuseki state is not pinned: ${problems.join('; ')}`);
}

export interface StorageHeadroom {
  freeBytes: number;
  tdb2Bytes: number;
  luceneBytes: number;
  reserveBytes: number;
  requiredBytes: number;
}

/** OPS09: the replacement index and a reserve must fit beside the current one. */
export function storageHeadroom(runner: FusekiStateRunner, reserveBytes: number): StorageHeadroom {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new Error('invalid storage reserve');
  const output = runner.exec(`cd ${STATE_DIRECTORY} && du -sk tdb2 lucene && df -Pk /fuseki/databases | tail -n 1`);
  const lines = output.trim().split(/\r?\n/);
  const size = (name: string) => Number(lines.find(line => line.endsWith(`\t${name}`))?.split('\t')[0]) * 1024;
  const freeBytes = Number(lines.at(-1)?.trim().split(/\s+/)[3]) * 1024;
  const tdb2Bytes = size('tdb2');
  const luceneBytes = size('lucene');
  if (![freeBytes, tdb2Bytes, luceneBytes].every(Number.isSafeInteger)) {
    throw new SearchStateRefused('Fuseki storage usage is unavailable');
  }
  const requiredBytes = 2 * luceneBytes + reserveBytes;
  return { freeBytes, tdb2Bytes, luceneBytes, reserveBytes, requiredBytes };
}

export function assertStorageHeadroom(headroom: StorageHeadroom): void {
  if (headroom.freeBytes < headroom.requiredBytes) {
    throw new SearchStateRefused(`insufficient storage headroom: ${headroom.freeBytes} free, ${headroom.requiredBytes} required`);
  }
}

/** Owner-locked offline indexer into an empty directory. The uncertainty marker
 * is removed only after the pinned indexer exits successfully. */
export const OFFLINE_INDEX_SCRIPT = `exec 9>>${STATE_DIRECTORY}/owner.lock
flock -n 9 || { echo "offline index: another process owns ${STATE_DIRECTORY}" >&2; exit 75; }
: > ${STATE_DIRECTORY}/lucene.uncertain
rm -rf ${STATE_DIRECTORY}/lucene && mkdir ${STATE_DIRECTORY}/lucene
java -Xmx2g -cp ${COMMAND_JAR}:${JENA_JAR} com.rezics.jena.ErasureTextIndexer --desc=${INDEXER_ASSEMBLER}
rm -f ${STATE_DIRECTORY}/lucene.uncertain && sync`;

export async function offlineTextIndex(runner: FusekiStateRunner): Promise<string> {
  let log = '';
  let stopped = false;
  try {
    runner.stop();
    stopped = true;
    log = runner.offline(OFFLINE_INDEX_SCRIPT);
  } finally {
    if (stopped) await runner.start();
  }
  return log;
}

export interface RebuildInput {
  runner: FusekiStateRunner;
  dockerEnv: NodeJS.ProcessEnv;
  env: WorkActivationEnvironment;
  content: ContentCore;
  cursor: ContentProjectionCursor;
  id: string;
  publicConsumer: string;
  expected: ExpectedPins;
  reserveBytes: number;
  /** Called before the service stops; it must prove no Main writer remains. */
  assertWritersStopped: () => Promise<void>;
}

export interface RebuildResult {
  job: string;
  removed: number;
  replayed: number;
  generation: string;
  offlineLog: string;
  storage: StorageHeadroom;
  pins: StatePins;
  elapsedMs: { verify: number; replay: number; offline: number; activate: number };
}

/** Quarantine, exact Content replay, empty-index offline rebuild and activation
 * of one new text generation. Pins and headroom refuse before quarantine.
 * Cost: one constant-size pin/headroom inspection, bounded Content clear/replay
 * batches, then one O(indexed RDF bytes) native indexer scan. The native pass
 * has a 300-second command timeout; elapsed phases and storage are returned. */
export async function rebuildPublicContentSearch(input: RebuildInput): Promise<RebuildResult> {
  const clock = () => performance.now();
  let started = clock();
  assertPinnedState(await inspectFusekiState(input.runner, input.dockerEnv, input.env.fuseki), input.expected);
  const storage = storageHeadroom(input.runner, input.reserveBytes);
  assertStorageHeadroom(storage);
  const verify = clock() - started;
  started = clock();
  const job = await quarantinePublicContentSearch(input.env, input.content, input.id);
  const removed = await clearQuarantinedContentUnits(input.env, job);
  const replayed = await replayQuarantinedContentCut(input.env, input.content, input.cursor, job);
  await input.assertWritersStopped();
  await backfillChapterSearchIndex(input.env);
  const replay = clock() - started;
  started = clock();
  const offlineLog = await offlineTextIndex(input.runner);
  const offline = clock() - started;
  started = clock();
  const pins = await inspectFusekiState(input.runner, input.dockerEnv, input.env.fuseki);
  assertPinnedState(pins, input.expected);
  const health = await input.env.fuseki.commandHealth() as { textIndexUncertain?: unknown };
  if (health.textIndexUncertain !== false) {
    throw new SearchStateRefused('rebuilt text index is still reported uncertain');
  }
  const offlineIndexDigest = sha256(JSON.stringify({ family: 'jena-textindexer-v2',
    image: pins.imageId, stateVolume: pins.stateVolume,
    assembler: pins.indexerAssemblerSha256, analyzer: pins.facts.analyzer,
    fusekiJar: pins.fusekiJarSha256, commandJar: pins.commandJarSha256,
    moduleVersion: pins.moduleVersion, output: sha256(offlineLog) }));
  const generation = await activateRebuiltPublicContentSearch(input.env, input.content,
    input.cursor, job, input.publicConsumer, offlineIndexDigest);
  const activate = clock() - started;
  return { job: input.id, removed, replayed, generation, offlineLog, storage, pins,
    elapsedMs: { verify: Math.round(verify), replay: Math.round(replay),
      offline: Math.round(offline), activate: Math.round(activate) } };
}

/**
 * OPS16: copy a stopped state volume into a new, empty volume. The source is
 * mounted read-only and its owner lock must be free, so a live JVM's files are
 * never copied. The restored text index is unqualified and starts uncertain.
 * Cost: one O(volume bytes) copy with a 300-second timeout and no retry loop.
 */
export function restoreStateVolume(env: NodeJS.ProcessEnv, image: string, from: string, to: string): void {
  const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
  if (!volumeName.test(from) || !volumeName.test(to)) throw new SearchStateRefused('invalid state volume name');
  if (from === to) throw new SearchStateRefused('restore target must be a new state volume');
  const source = spawnSync('docker', ['volume', 'inspect', from], { env, encoding: 'utf8', timeout: 10_000 });
  if (source.status !== 0) throw new SearchStateRefused(`restore source volume ${from} is absent`);
  const existing = spawnSync('docker', ['volume', 'inspect', to], { env, encoding: 'utf8', timeout: 10_000 });
  if (existing.status === 0) throw new SearchStateRefused(`restore target volume ${to} already exists`);
  docker(['volume', 'create', to], env, 15_000);
  try {
    docker(['run', '--rm', '--network', 'none', '--user', '0:0',
      '--volume', `${from}:/from:ro`, '--volume', `${to}:/to`, '--entrypoint', 'sh', image, '-ec',
      `test -d /from/rezics/tdb2 && test -d /from/rezics/lucene && test -f /from/rezics/owner.lock
exec 9</from/rezics/owner.lock
flock -n 9 || { echo "restore: ${from} is owned by a running process" >&2; exit 75; }
test -z "$(ls -A /to)"
cp -a /from/. /to/
rm -f /to/rezics/clean-stop
: > /to/rezics/lucene.uncertain
chown 10001:10001 /to/rezics/lucene.uncertain
sync`], env, 300_000);
  } catch (error) {
    spawnSync('docker', ['volume', 'rm', to], { env, encoding: 'utf8', timeout: 15_000 });
    throw error;
  }
}
