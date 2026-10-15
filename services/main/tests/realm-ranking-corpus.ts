import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import { fixtureRoot, stream } from '../../../scripts/fixture/stack.ts';
import {
  createCorpusBackupDriver,
  type CorpusBackupDriverOptions,
  type ManagedCorpusBackupDriver,
} from '../../../scripts/load/corpus-backup-driver.ts';
import {
  compatibleLoadStorage,
  loadCompatibility,
  type LoadCompatibility,
} from '../../../scripts/load/compatibility.ts';
import { startHomeStack, type HomeStack } from '../../../tests/qa/integration/feed-read-support.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

const root = resolve(import.meta.dir, '../../..');
const stageStarted = performance.now();
const stageDirectory = join(root, '.temp', 'realm-ranking-corpus', 'stages');
const stagePath = join(
  stageDirectory,
  `${process.env.REZICS_QA_RUN_ID ?? 'build'}-${process.pid}.jsonl`,
);

/** Keep completed and interrupted stages even if a profile child exceeds its deadline. */
export async function timeRealmRankingStage<T>(
  stage: string,
  operation: () => Promise<T>,
  details: Record<string, unknown> = {},
): Promise<T> {
  const started = performance.now();
  const record = (outcome: 'started' | 'passed' | 'failed', error?: unknown) => {
    const entry = {
      realmRankingStage: stage,
      ...details,
      outcome,
      elapsedMs: Math.round(performance.now() - started),
      totalMs: Math.round(performance.now() - stageStarted),
      ...(error === undefined ? {} : { error: String(error) }),
    };
    mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
    appendFileSync(stagePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...entry, stagePath }));
  };
  record('started');
  try {
    const value = await operation();
    record('passed');
    return value;
  } catch (error) {
    record('failed', error);
    throw error;
  }
}

/** Bump when the reply recipe or the retained cuts change, not for unrelated code edits. */
export const REALM_RANKING_CORPUS_VERSION = 'realm-ranking-commands-v3';
export const REALM_RANKING_SCALES = [100, 400, 1600] as const;
export type RealmRankingScale = (typeof REALM_RANKING_SCALES)[number];
export const REALM_RANKING_FILLERS = 1_598;
export const REALM_RANKING_BUILD_RUN = `realmrank-${realmRankingCorpusKey().slice(-16)}`;

/** Isolated PostgreSQL servers reuse database names; compare their endpoints
 * without persisting credentials. The observed database can come from a probe. */
export function realmRankingOwnerEndpoint(connectionString: string, database?: string) {
  const url = new URL(connectionString);
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ? 'loopback'
    : url.hostname;
  return {
    host,
    port: url.port || '5432',
    database: database ?? decodeURIComponent(url.pathname.slice(1)),
  };
}

export interface RealmRankingReplyIdentity {
  reply: string;
  revision: string;
  placement: string;
  digest: string;
  review: string;
}

export interface RealmRankingFollowups {
  realm: string;
  work: string;
  draftRevision: string;
  clean: RealmRankingReplyIdentity;
  chainRoot: RealmRankingReplyIdentity;
  chain: RealmRankingReplyIdentity[];
  wideRoot: RealmRankingReplyIdentity;
  wide: RealmRankingReplyIdentity[];
}

export interface RealmRankingIdentity {
  dataEpoch: string;
  routingEpoch: string;
  realm: string;
  author: string;
  reader: string;
  work: string;
  draftRevision: string;
  opening: RealmRankingReplyIdentity;
  second: RealmRankingReplyIdentity;
  /** Descendants of the second root, leaving the opening's reply count at zero. */
  deepChain: RealmRankingReplyIdentity[];
  /** Independent clean, deep and wide roots, retained from the 400-thread cut. */
  followups: RealmRankingFollowups | null;
  winner: { reply: string; placement: string };
}

export interface RealmRankingCorpusManifest {
  format: 'realm-ranking-corpus-v1';
  version: string;
  compatibility: LoadCompatibility;
  preparationMs: number;
  /** Fillers posted through the Realm reply commands, after the opening and the second root. */
  fillers: number;
  identity: RealmRankingIdentity;
  scales: RealmRankingScale[];
}

export function realmRankingCorpusKey(compatibility = loadCompatibility(root)): string {
  return `realm-ranking-${createHash('sha256')
    .update(JSON.stringify([REALM_RANKING_CORPUS_VERSION, compatibility.digest]))
    .digest('hex')
    .slice(0, 16)}`;
}

/** Retained inputs share the fixture store across checkouts; stage logs stay local. */
export function realmRankingCorpusDirectory(fixtures = fixtureRoot): string {
  return join(dirname(resolve(fixtures)), 'work-profiles', 'realm-ranking-corpus');
}

export function realmRankingCorpusRoot(): string {
  return join(realmRankingCorpusDirectory(), realmRankingCorpusKey());
}

export function realmRankingBackupPath(size: RealmRankingScale): string {
  return join(realmRankingCorpusRoot(), String(size), 'backup.json');
}

export function realmRankingBuildCommand(): string {
  return 'bun services/main/tests/build-realm-ranking-corpus.ts';
}

/** How to produce the backups. The ranking test prints this instead of writing storage directly. */
export function realmRankingCorpusInstructions(
  reason = `the backup is absent from the fixture store at ${realmRankingCorpusRoot()}`,
): string {
  const key = realmRankingCorpusKey();
  return (
    `Realm ranking corpus ${REALM_RANKING_CORPUS_VERSION} (${key}) cannot be restored: ${reason}. ` +
    `Build it once, outside the 600s preparation budget, with \`${realmRankingBuildCommand()}\`. ` +
    `That posts ${REALM_RANKING_FILLERS} root fillers and the deep/wide followups through the product commands and retains ` +
    `stopped copies at ${REALM_RANKING_SCALES.join(', ')} root threads.`
  );
}

function cutReady(size: RealmRankingScale, corpus = realmRankingCorpusRoot()): boolean {
  const directory = join(corpus, String(size));
  return (
    existsSync(join(directory, 'backup.json')) &&
    existsSync(join(directory, 'compose.env')) &&
    existsSync(join(directory, 'objects'))
  );
}

export function readRealmRankingCorpus(corpus = realmRankingCorpusRoot()): RealmRankingCorpusManifest | undefined {
  const path = join(corpus, 'manifest.json');
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as RealmRankingCorpusManifest;
  if (
    manifest.format !== 'realm-ranking-corpus-v1' ||
    manifest.version !== REALM_RANKING_CORPUS_VERSION ||
    manifest.fillers !== REALM_RANKING_FILLERS ||
    !manifest.identity.second?.reply ||
    manifest.identity.deepChain?.length !== 40 ||
    !manifest.identity.followups?.clean.reply ||
    !manifest.identity.followups.chainRoot.reply ||
    manifest.identity.followups.chain.length !== 34 ||
    !manifest.identity.followups.wideRoot.reply ||
    manifest.identity.followups.wide.length !== 193 ||
    !compatibleLoadStorage(manifest.compatibility, loadCompatibility(root)) ||
    REALM_RANKING_SCALES.some((size) => !manifest.scales.includes(size) || !cutReady(size, corpus))
  ) {
    return undefined;
  }
  return manifest;
}

export function explainUnavailableCorpus(): string {
  const current = loadCompatibility(root);
  const directory = realmRankingCorpusDirectory();
  if (!existsSync(directory)) return realmRankingCorpusInstructions();
  const stale = readdirSync(directory).flatMap((name) => {
    const path = join(directory, name, 'manifest.json');
    if (!existsSync(path)) return [];
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<RealmRankingCorpusManifest>;
    if (manifest.version !== REALM_RANKING_CORPUS_VERSION || !manifest.compatibility) return [];
    if (compatibleLoadStorage(manifest.compatibility, current)) return [];
    return [name];
  });
  if (stale.length) {
    return realmRankingCorpusInstructions(
      `retained cut ${stale[0]} does not match this checkout's owner migrations and graph model`,
    );
  }
  return realmRankingCorpusInstructions();
}

export interface RealmRankingProgress {
  identity: RealmRankingIdentity;
  fillers: number;
  startedAt: number;
  /** The size-100 cut's two upvotes are already committed. A resume must not vote again. */
  voted?: boolean;
}

export function readRealmRankingProgress(): RealmRankingProgress | undefined {
  const path = join(realmRankingCorpusRoot(), 'progress.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as RealmRankingProgress;
}

export function writeRealmRankingProgress(progress: RealmRankingProgress): void {
  const directory = realmRankingCorpusRoot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pending = join(directory, 'progress.pending.json');
  writeFileSync(pending, JSON.stringify(progress, null, 2) + '\n', {
    mode: 0o600,
  });
  renameSync(pending, join(directory, 'progress.json'));
}

export function writeRealmRankingManifest(manifest: RealmRankingCorpusManifest): void {
  writeFileSync(
    join(realmRankingCorpusRoot(), 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 },
  );
}

type RealmRankingDriverOptions = Pick<
  CorpusBackupDriverOptions,
  'sourceRunId' | 'quiesce' | 'smokeRead'
> &
  Partial<Pick<CorpusBackupDriverOptions, 'resumeSource'>>;

export function createRealmRankingCorpusDriver(
  options: RealmRankingDriverOptions,
): ManagedCorpusBackupDriver {
  return createCorpusBackupDriver({
    ...options,
    directory: realmRankingCorpusRoot(),
  });
}

export interface RealmRankingRestore {
  target: string;
  manifest: RealmRankingCorpusManifest;
  home: HomeStack;
  /** The restored endpoint differs from the parent QA shard's endpoint. */
  fusekiUrl: string;
  elapsedMs: number;
  close: () => Promise<void>;
}

/** Migration 024 leaves old empty headers unresolved. Only the relay's source
 * verification can establish their graph cuts; repair the isolated copy before
 * any feed projection or ranking smoke read, keeping the stopped corpus intact. */
async function repairRestoredEmptyGraphCuts(
  apps: Record<string, string>,
  signal: AbortSignal,
): Promise<number> {
  const pool = new Pool({
    connectionString: apps.MAIN_RELAY_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const unresolved = (
      await pool.query<{ data_epoch: string; sequence: string }>(
        `SELECT data_epoch, sequence::text FROM relay.delivered_batch
        WHERE stream_scope=$1 AND event_count=0 AND graph_sequence IS NULL
        ORDER BY data_epoch, sequence`,
        [MAIN_RELAY_STREAM_SCOPE],
      )
    ).rows;
    for (const header of unresolved) {
      signal.throwIfAborted();
      await stream(
        'task',
        [
          'main:relay',
          '--',
          '--repair-graph-cut',
          '--data-epoch',
          header.data_epoch,
          '--sequence',
          header.sequence,
        ],
        { ...process.env, ...apps, OTEL_SDK_DISABLED: 'true' },
        undefined,
        60_000,
        signal,
      );
    }
    const remaining = (
      await pool.query<{ count: string }>(
        `SELECT count(*) FROM relay.delivered_batch
      WHERE stream_scope=$1 AND event_count=0 AND graph_sequence IS NULL`,
        [MAIN_RELAY_STREAM_SCOPE],
      )
    ).rows[0]!.count;
    if (remaining !== '0')
      throw new Error('Restored empty Main batch graph cuts remain unresolved');
    console.log(JSON.stringify({ realmRankingGraphCutsRepaired: unresolved.length, remaining }));
    return unresolved.length;
  } finally {
    await pool.end();
  }
}

/** Restore one retained cut into its own QA project, then read it through Main before returning. */
export async function restoreRealmRankingCorpus(
  size: RealmRankingScale,
): Promise<RealmRankingRestore> {
  const started = performance.now();
  const manifest = readRealmRankingCorpus();
  if (!manifest) throw new Error(explainUnavailableCorpus());
  if (!REALM_RANKING_SCALES.includes(size) || !cutReady(size))
    throw new Error(`Realm ranking cut ${size} is not retained`);

  const target = `realm-ranking-${size}-${randomUUID().slice(0, 8)}`;
  let home: HomeStack | undefined;
  let fusekiUrl: string | undefined;
  const driver = createRealmRankingCorpusDriver({
    sourceRunId: REALM_RANKING_BUILD_RUN,
    async quiesce(signal) {
      signal.throwIfAborted();
    },
    async smokeRead(input) {
      if (!input.apps.FUSEKI_URL) throw new Error('Restored corpus has no Fuseki endpoint');
      fusekiUrl = input.apps.FUSEKI_URL;
      const previous = new Map<string, string | undefined>();
      try {
        const environment = {
          ...input.apps,
          REZICS_QA_RUN_ID: input.runId,
          REZICS_QA_STACK_MODE: 'scale',
          REZICS_QA_STACK_TIER: 'integration',
          REZICS_STACK_PROFILE: 'qa',
        };
        for (const key of Object.keys(environment)) previous.set(key, Bun.env[key]);
        Object.assign(Bun.env, environment);
        await timeRealmRankingStage(
          'graph-cut-repair',
          () => repairRestoredEmptyGraphCuts(input.apps, input.signal),
          { threads: size, target },
        );
        const restoredHome = await timeRealmRankingStage(
          'startup',
          () =>
            startHomeStack(`realm-ranking-restore-${target}`, {
              projectionStart: 'current',
              stableMembers: true,
            }),
          { threads: size, target },
        );
        home = restoredHome;
        const realm = manifest.identity.realm;
        const page = await timeRealmRankingStage(
          'readiness',
          async () =>
            restoredHome.json<{ items: unknown[] }>(
              await restoredHome.call(
                'GET',
                `/v1/realms/${realm.slice(-36)}/threads?sort=best&window=all&limit=2`,
              ),
            ),
          { threads: size, target },
        );
        if (page.items.length !== 2)
          throw new Error(`Restored Realm ranking cut ${size} did not return two threads`);
        return async () => restoredHome.stop();
      } catch (error) {
        await home?.stop();
        home = undefined;
        throw error;
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
        }
      }
    },
  });

  const remaining = 600_000 - (performance.now() - started);
  if (remaining <= 0) throw new Error('Realm ranking restore preparation exceeded 600 seconds');
  try {
    await timeRealmRankingStage(
      'restore',
      () =>
        driver.restore(
          realmRankingBackupPath(size),
          target,
          AbortSignal.timeout(Math.ceil(remaining)),
        ),
      { threads: size, target },
    );
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 600_000)
      throw new Error('Realm ranking restore preparation exceeded 600 seconds');
    if (!home || !fusekiUrl)
      throw new Error('Realm ranking smoke read did not retain its Main stack and endpoint');
    console.log(
      JSON.stringify({ realmRankingRestoreReadyMs: Math.round(elapsedMs), threads: size, target }),
    );
    return {
      target,
      manifest,
      home,
      fusekiUrl,
      elapsedMs,
      close: () =>
        timeRealmRankingStage('cleanup', () => driver.stop(target), { threads: size, target }),
    };
  } catch (error) {
    try {
      await driver.stop(target);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Realm ranking restore failed and cleanup was incomplete',
      );
    }
    throw error;
  }
}
