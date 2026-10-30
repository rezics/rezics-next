import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { registerContent } from '../../src/content/register.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { effectsRelay, effectWorkflowId, type Effect } from '../../src/events/effects.ts';
import { readBatch, type CloudEvent, type Envelope } from '../../src/events/log.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

const idempotencyKey = () => randomUUID();
const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} was not returned`);
  return value;
};

export type NativePerson = Readonly<{ accountId: string; bearer: string }>;
export type CallResult = Readonly<{ response: Response; text: string; value: Record<string, any> | null }>;
export type ReactionTarget = Readonly<{
  threadId: string;
  postId: string;
  boardId: string;
  threadRoute: number;
  postRoute: number;
  boardRoute: number;
}>;
export type CreatedRealmTarget = ReactionTarget & Readonly<{ realmId: string }>;

export type ReactionRelayBase = {
  readonly system: NativeContentSystem;
  readonly author: NativePerson;
  readonly other: NativePerson;
  readonly governance: NativePerson;
  readonly conceptId: string;
  readonly schemeId: string;
  readonly mainBoardId: string;
  readonly mainTarget: ReactionTarget;
  call(method: string, path: string, options?: CallOptions): Promise<CallResult>;
  command<T = Record<string, any>>(method: string, path: string, body: unknown, options?: CommandOptions): Promise<T>;
  createThread(boardId: string, title: string, visibility?: 'published' | 'draft'): Promise<ReactionTarget>;
  createRealmTarget(
    title: string,
    visibility: 'public' | 'protected',
    boardVisibility?: 'published' | 'protected',
  ): Promise<CreatedRealmTarget>;
  startEffects(): Promise<ReactionWorkRuntime>;
};

export type CallOptions = Readonly<{
  bearer?: string;
  key?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Readonly<Record<string, string>>;
}>;
export type CommandOptions = Readonly<{
  bearer?: string;
  key?: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  expectedStatus?: number;
}>;

export type ReactionWorkRuntime = {
  readonly pool: Pool;
  readonly work: Awaited<ReturnType<typeof composeWork>>;
  readonly effect: Effect;
  readonly relay?: ReturnType<typeof startRelays>;
  readonly reactionEffects: readonly Effect[];
  pause(): Promise<void>;
  resume(): void;
  stop(): Promise<void>;
  captureBeforeWrite(actorId: string): Promise<ReactionEventCapture>;
  waitForEffect(envelope: Envelope, eventSeq: number): Promise<void>;
  relayCheckpoint(partition: number): Promise<Position | null>;
  partitionPosition(partition: number): Promise<Position>;
};

export type Position = Readonly<{ epoch: number; position: string }>;
export type ReactionEventCapture = Readonly<{
  consumer: string;
  before: Position;
  read(): Promise<Readonly<{ envelope: Envelope; event: CloudEvent; eventSeq: number }>>;
}>;

/**
 * The existing reactions-http and reaction-counts-http suites prove viewer slots and public projections separately.
 * This fixture joins those native paths and keeps production work registration observable for exact barriers.
 */
export async function createReactionRelayBase(databaseUrl = process.env.DATABASE_URL): Promise<ReactionRelayBase> {
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystem({ databaseUrl });
  try {
    const pool = system.database.pool;
    await bootstrapRelease(pool, bundledRelease);

    const governanceRow = await pool.query<{ account_id: string }>(
      'SELECT account_id FROM access.governance_bootstrap',
    );
    const governanceId = governanceRow.rows[0]?.account_id;
    if (!governanceId) throw new Error('Native governance bootstrap did not return its account');
    const governanceCredential = await system.auth.issue({
      accountId: governanceId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
    });
    const governance = { accountId: governanceId, bearer: governanceCredential.bearer };
    const author = {
      accountId: system.actors.author.actor.accountId,
      bearer: system.actors.author.bearer,
    };
    const other = { accountId: system.actors.other.actor.accountId, bearer: system.actors.other.bearer };

    const call = async (method: string, path: string, options: CallOptions = {}): Promise<CallResult> => {
      const headers = new Headers(options.headers);
      if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
      if (options.key !== undefined) headers.set('idempotency-key', JSON.stringify(options.key));
      if (options.body !== undefined || options.rawBody !== undefined) headers.set('content-type', 'application/json');
      const response = await system.kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers,
          ...(options.body === undefined && options.rawBody === undefined
            ? {}
            : { body: options.rawBody ?? JSON.stringify(options.body) }),
        }),
      );
      const text = await response.text();
      let value: Record<string, any> | null = null;
      if (text) {
        try {
          value = JSON.parse(text) as Record<string, any>;
        } catch {
          value = null;
        }
      }
      return { response, text, value };
    };

    const command = async <T = Record<string, any>>(
      method: string,
      path: string,
      body: unknown,
      options: CommandOptions = {},
    ): Promise<T> => {
      const result = await call(options.method ?? method, path, {
        bearer: options.bearer ?? author.bearer,
        key: options.key ?? idempotencyKey(),
        body,
        ...(options.headers ? { headers: options.headers } : {}),
      });
      const expected = options.expectedStatus ?? (method === 'POST' ? 201 : method === 'PUT' ? 200 : 204);
      if (result.response.status !== expected)
        throw new Error(`${options.method ?? method} ${path}: ${result.response.status} ${result.text}`);
      return (result.value ?? {}) as T;
    };

    const scheme = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
      type: 'skos:ConceptScheme',
      labels: { en: `Reaction relay scheme ${idempotencyKey()}` },
    });
    const schemeId = asString(scheme.subject?.id, 'ConceptScheme id');
    const concept = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: `Reaction relay concept ${idempotencyKey()}` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    });
    const conceptId = asString(concept.subject?.id, 'Concept id');

    const createThread = async (
      boardId: string,
      title: string,
      visibility: 'published' | 'draft' = 'published',
    ): Promise<ReactionTarget> => {
      let key = idempotencyKey();
      let target = threadTarget(system.routeKey, author.accountId, key);
      const actorRoutes = new Set([routeOf(author.accountId), routeOf(other.accountId)]);
      for (let attempt = 0; attempt < 256; attempt++) {
        const partition = partitionOf(target.route);
        const actorPartitions = new Set(
          [routeOf(author.accountId), routeOf(other.accountId)]
            .filter((route): route is number => route !== null)
            .map(partitionOf),
        );
        if (!actorRoutes.has(target.route) && !actorPartitions.has(partition)) break;
        key = idempotencyKey();
        target = threadTarget(system.routeKey, author.accountId, key);
        if (attempt === 255) throw new Error('Could not route a content target away from its native actors');
      }
      const created = await command<{ thread: { id: string; firstPost: { id: string } } }>(
        'POST',
        '/v1/threads',
        {
          title,
          body: fromPlainText(`${title} first post`),
          licence: 'CC0-1.0',
          subjectIds: [],
          boardId,
          visibility,
        },
        { key },
      );
      const threadId = asString(created.thread?.id, 'Thread id');
      const postId = asString(created.thread?.firstPost?.id, 'First post id');
      const threadRoute = routeOf(threadId);
      const postRoute = routeOf(postId);
      const boardRoute = routeOf(boardId);
      if (threadRoute === null || postRoute === null || boardRoute === null)
        throw new Error('HTTP-created reaction targets must have routable ids');
      if (
        threadRoute !== target.route ||
        routeOf(threadId) === routeOf(author.accountId) ||
        routeOf(threadId) === routeOf(other.accountId)
      )
        throw new Error('HTTP-created reaction target did not use an independent actor route');
      return { threadId, postId, boardId, threadRoute, postRoute, boardRoute };
    };

    const createRealmTarget = async (
      title: string,
      visibility: 'public' | 'protected',
      boardVisibility: 'published' | 'protected' = 'published',
    ): Promise<CreatedRealmTarget> => {
      const space = await command<{ space: { spaceId: string } }>('POST', '/v1/spaces', {
        title: `${title} space`,
        summary: `${title} space summary`,
      });
      const realm = await command<{ realm: { realmId: string; headRevisionId: string } }>('POST', '/v1/realms', {
        spaceId: asString(space.space?.spaceId, 'Space id'),
        title,
        summary: `${title} summary`,
        visibility,
        contextId: GLOBAL_CONTEXT,
      });
      const realmId = asString(realm.realm?.realmId, 'Realm id');
      const headRevisionId = asString(realm.realm?.headRevisionId, 'Realm revision id');
      await command(
        'PUT',
        `/v1/realms/${realmId}/boardScheme`,
        { schemeId },
        { headers: { 'if-match': JSON.stringify(headRevisionId) }, expectedStatus: 200 },
      );
      const board = await command<{ board: { id: string } }>('POST', `/v1/realms/${realmId}/boards`, {
        conceptId,
        title: `${title} board`,
        visibility: boardVisibility,
      });
      const boardId = asString(board.board?.id, 'Realm board id');
      const target = await createThread(boardId, `${title} thread`);
      return { ...target, realmId };
    };

    const mainTarget = await createRealmTarget(`Reaction relay public ${idempotencyKey()}`, 'public');
    const mainBoardId = mainTarget.boardId;
    return {
      system,
      author,
      other,
      governance,
      conceptId,
      schemeId,
      mainBoardId,
      mainTarget,
      call,
      command,
      createThread,
      createRealmTarget,
      async startEffects() {
        return startReactionEffects(system, system.database.pool, system.database.pool.options.connectionString!);
      },
    };
  } catch (error) {
    await system.close();
    throw error;
  }
}

/** Register the exact production content module and expose the reaction Effect it registered. */
export async function startReactionEffects(
  system: NativeContentSystem,
  pool: Pool,
  databaseUrl: string,
  options: { relay?: boolean } = {},
): Promise<ReactionWorkRuntime> {
  const client = await createWorkClient(databaseUrl, pool);
  const registered: Effect[] = [];
  const observedModule: WorkModule = {
    name: registerContent.name,
    register(context) {
      return registerContent.register({
        ...context,
        addEffects(effects) {
          registered.push(...effects);
          context.addEffects(effects);
        },
      });
    },
  };
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let relay: ReturnType<typeof startRelays> | undefined;
  try {
    work = await composeWork([observedModule], {
      databaseUrl,
      pool,
      client,
      executorId: `reaction-relay-${randomUUID()}`,
      env: { KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url') },
    });
    const reactionEffects = registered.filter((effect) => effect.name === 'content_reaction_count');
    if (reactionEffects.length !== 1)
      throw new Error('Content work did not register exactly one reaction count effect');
    const effect = reactionEffects[0]!;
    if (options.relay !== false) {
      await work.launch();
      const relayEffects = effectsRelay(pool, work.effects);
      relay = startRelays(pool, [relayEffects], {
        intervalMs: 5,
        concurrency: Math.max(1, Math.min(2, (pool.options.max ?? 10) - 1)),
      });
    }
    return {
      pool,
      work,
      effect,
      ...(relay ? { relay } : {}),
      reactionEffects: Object.freeze([...reactionEffects]),
      async pause() {
        if (!relay) throw new Error('The production effects relay was not started');
        await relay.pause();
      },
      resume() {
        if (!relay) throw new Error('The production effects relay was not started');
        relay.resume();
      },
      async stop() {
        try {
          await relay?.stop();
        } finally {
          try {
            await work?.shutdown();
          } finally {
            await client.close();
          }
        }
      },
      captureBeforeWrite(actorId) {
        return captureReactionEventBeforeWrite(pool, actorId);
      },
      async waitForEffect(envelope, eventSeq) {
        const id = effectWorkflowId(envelope, eventSeq, effect.name);
        await DBOS.retrieveWorkflow(id).getResult({ pollingIntervalMs: 10 });
        await waitForRelayPosition(pool, envelope.partition, envelope.epoch, envelope.position);
      },
      relayCheckpoint(partition) {
        return readCheckpoint(pool, 'effects', partition);
      },
      partitionPosition(partition) {
        return readPartitionPosition(pool, partition);
      },
    };
  } catch (error) {
    try {
      await relay?.stop();
    } finally {
      try {
        await work?.shutdown();
      } finally {
        await client.close();
      }
    }
    throw error;
  }
}

export async function captureReactionEventBeforeWrite(pool: Pool, actorId: string): Promise<ReactionEventCapture> {
  const actorRoute = routeOf(actorId);
  if (actorRoute === null) throw new TypeError('A native actor must have a routed account id');
  const partition = partitionOf(actorRoute);
  const before = await readPartitionPosition(pool, partition);
  const consumer = `reaction_capture_${randomUUID().replaceAll('-', '')}`;
  await pool.query(
    `INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position)
     VALUES ($1,$2,$3,$4)`,
    [partition, consumer, before.epoch, before.position],
  );
  return {
    consumer,
    before,
    async read() {
      const envelopes: Envelope[] = [];
      const result = await readBatch(pool, {
        consumer,
        partition,
        envelopes: 1,
        apply: async (batch) => {
          envelopes.push(...batch);
        },
      });
      if (result.status !== 'read' || envelopes.length !== 1)
        throw new Error(`The reaction command did not append one readable event envelope (${result.status})`);
      const envelope = envelopes[0]!;
      const matching = envelope.events.flatMap((event, eventSeq) =>
        event.type === 'com.rezics.content.reaction.changed.v1' &&
        (event.data as { actorId?: unknown }).actorId === actorId
          ? [{ event, eventSeq }]
          : [],
      );
      if (matching.length !== 1)
        throw new Error(`Expected one committed reaction event for ${actorId}; received ${matching.length}`);
      return { envelope, event: matching[0]!.event, eventSeq: matching[0]!.eventSeq };
    },
  };
}

export async function readPartitionPosition(pool: Pool, partition: number): Promise<Position> {
  const row = (
    await pool.query<{ epoch: number; position: string }>(
      'SELECT epoch, position::text AS position FROM core.partition WHERE partition_no=$1',
      [partition],
    )
  ).rows[0];
  if (!row) throw new Error(`Missing native partition ${partition}`);
  return { epoch: row.epoch, position: BigInt(row.position).toString() };
}

export async function readCheckpoint(pool: Pool, consumer: string, partition: number): Promise<Position | null> {
  const row = (
    await pool.query<{ epoch: number | null; position: string }>(
      `SELECT epoch, position::text AS position FROM core.consumer_checkpoint
       WHERE consumer=$1 AND partition_no=$2`,
      [consumer, partition],
    )
  ).rows[0];
  return row?.epoch === null || !row ? null : { epoch: row.epoch, position: BigInt(row.position).toString() };
}

export async function waitForRelayPosition(
  pool: Pool,
  partition: number,
  epoch: number,
  position: bigint,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const checkpoint = await readCheckpoint(pool, 'effects', partition);
    if (
      checkpoint &&
      (checkpoint.epoch > epoch || (checkpoint.epoch === epoch && BigInt(checkpoint.position) >= position))
    )
      return;
    if (Date.now() >= deadline)
      throw new Error(`The registered effects relay did not pass ${partition}.${epoch}.${position}`);
    await Bun.sleep(10);
  }
}

export function countFreshness(
  rows: readonly Readonly<{ source_epoch: number; source_position: string }>[],
): Position | null {
  let oldest: Position | null = null;
  for (const row of rows) {
    const current = { epoch: row.source_epoch, position: BigInt(row.source_position).toString() };
    if (
      oldest === null ||
      current.epoch < oldest.epoch ||
      (current.epoch === oldest.epoch && BigInt(current.position) < BigInt(oldest.position))
    )
      oldest = current;
  }
  return oldest;
}

export async function targetFreshness(pool: Pool, targetId: string): Promise<Position | null> {
  const rows = await pool.query<{ source_epoch: number; source_position: string }>(
    `SELECT source_epoch, source_position::text AS source_position
       FROM content.reaction_total WHERE route=$1 AND target_id=$2`,
    [routeOf(targetId), targetId],
  );
  return countFreshness(rows.rows);
}

export async function targetProjectionRows(pool: Pool, targetId: string) {
  const [bySource, totals] = await Promise.all([
    pool.query(
      `SELECT route, target_id, source_partition, kind, count, source_epoch, source_position::text AS source_position
         FROM content.reaction_count WHERE route=$1 AND target_id=$2
        ORDER BY source_partition, kind`,
      [routeOf(targetId), targetId],
    ),
    pool.query(
      `SELECT route, target_id, kind, count, source_epoch, source_position::text AS source_position
         FROM content.reaction_total WHERE route=$1 AND target_id=$2 ORDER BY kind`,
      [routeOf(targetId), targetId],
    ),
  ]);
  return { bySource: bySource.rows, totals: totals.rows };
}

export async function snapshotReactionOperation(pool: Pool, actorId: string, targetId: string, key: string) {
  const actorRoute = routeOf(actorId);
  const targetRoute = routeOf(targetId);
  if (actorRoute === null || targetRoute === null) throw new TypeError('Reaction snapshots require routed ids');
  const partition = partitionOf(actorRoute);
  const [partitionRow, slot, receipt] = await Promise.all([
    pool.query<{ epoch: number; position: string }>(
      'SELECT epoch, position::text AS position FROM core.partition WHERE partition_no=$1',
      [partition],
    ),
    pool.query(
      `SELECT route, actor_account_id, target_kind, target_route, target_id, kind, updated_at
         FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3`,
      [actorRoute, actorId, targetId],
    ),
    pool.query(
      `SELECT partition_no, principal_kind, principal_id, command_kind, idempotency_key,
              encode(request_digest,'hex') AS request_digest, epoch, position::text AS position,
              transaction_id, response
         FROM core.receipt
        WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND idempotency_key=$3`,
      [partition, actorId, key],
    ),
  ]);
  const current = partitionRow.rows[0];
  const event = current
    ? await pool.query(
        `SELECT partition_no, position::text AS position, event_seq, event_count, epoch, id, type, subject, data
           FROM core.outbox WHERE partition_no=$1 AND position=$2::bigint ORDER BY event_seq`,
        [partition, current.position],
      )
    : { rows: [] };
  const projection = await targetProjectionRows(pool, targetId);
  return {
    partition: current ? { epoch: current.epoch, position: BigInt(current.position).toString() } : null,
    slot: slot.rows,
    receipt: receipt.rows,
    event: event.rows,
    projection,
  };
}

export function comparePosition(left: Position | null, right: Position | null): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return left.epoch === right.epoch
    ? BigInt(left.position) < BigInt(right.position)
      ? -1
      : BigInt(left.position) > BigInt(right.position)
        ? 1
        : 0
    : left.epoch < right.epoch
      ? -1
      : 1;
}
