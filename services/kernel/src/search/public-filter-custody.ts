import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { admitFilter, walkFilter } from '@rezics/filter';
import { withConnection } from '../database/pool.ts';
import { compileFilter } from './filter.ts';
import { compileText } from './text.ts';
import { OpenSearchError, type OpenSearch } from './opensearch.ts';
import type { PublicFilterConsumer, PublicFilterDependencyKey } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import type {
  CustodyCost,
  CustodyDefinition,
  CustodyExecution,
  CustodyFailure,
  CustodyFound,
  CustodyRead,
  CustodyRegistration,
  PublicFilterCustody,
} from './public-filter-custody-contract.ts';

const readSql = readFileSync(new URL('./public-filter-custody-read.sql', import.meta.url), 'utf8');
// A tagged canonical tree preserves bigint/undefined without collisions with user JSON objects.
type Tree = [string, unknown?];
function tree(value: unknown): Tree {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Array.isArray(value)) return ['array', value.map(tree)];
  if (value !== null && typeof value === 'object')
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, tree((value as Record<string, unknown>)[key])]),
    ];
  requireValue(
    value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)),
  );
  return ['scalar', value];
}
function untree(value: Tree): unknown {
  switch (value[0]) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value[1] as string);
    case 'array':
      return (value[1] as Tree[]).map(untree);
    case 'object':
      return Object.fromEntries((value[1] as [string, Tree][]).map(([key, entry]) => [key, untree(entry)]));
    case 'scalar':
      return value[1];
    default:
      throw new TypeError('Invalid custody encoding');
  }
}
const encode = (value: unknown) => JSON.stringify(tree(value));
const decode = <T>(value: string): T => untree(JSON.parse(value) as Tree) as T;
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
function requireValue(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid public filter custody input');
}
function text(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 65536 && !value.includes('\0'));
}
function home(value: number) {
  requireValue(Number.isInteger(value) && value >= 0 && value < 4096);
  return value;
}
function partition(observation: string) {
  text(observation);
  requireValue(/^(0|[1-9][0-9]{0,3}):[0-9a-f-]{36}$/.test(observation));
  return home(Number(observation.split(':')[0]));
}
function registration(value: CustodyRegistration) {
  home(value.partition);
  requireValue(/^[0-9a-f]{64}$/.test(value.id));
}
function lifetime(value: number) {
  requireValue(Number.isInteger(value) && value >= 1 && value <= 300_000);
}
function rows(value: CustodyExecution['ownRows']) {
  requireValue(Array.isArray(value) && value.length <= 1000);
  for (const row of value) {
    text(row.original);
    text(row.terminal);
  }
}
function queried(value: PublicFilterQueriedObservation) {
  partition(value.snapshot.observation);
  for (const key of ['physicalTarget', 'incarnation', 'consumerGeneration', 'projectionGeneration'] as const)
    text(value.consumer[key]);
  if (value.snapshot.kind === 'pit') text(value.snapshot.pit);
  else {
    requireValue(
      value.snapshot.kind === 'prepared' &&
        typeof value.snapshot.generation === 'bigint' &&
        value.snapshot.generation > 0n,
    );
    text(value.snapshot.build);
  }
}
function cost(): CustodyCost {
  return {
    statements: 0,
    rows: 0,
    bytes: 0,
    engineRequests: 0,
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
}
type Meter = { -readonly [K in keyof CustodyCost]: CustodyCost[K] };
class Failure extends Error {
  constructor(readonly reason: CustodyFailure['reason']) {
    super(reason);
  }
}
function check(context: PublicFilterConsumerContext) {
  requireValue(Number.isFinite(context.deadline));
  if (context.deadline <= Date.now()) throw new Failure('deadline');
}
function failure(error: unknown, meter: CustodyCost): CustodyFailure {
  if (error instanceof TypeError) throw error;
  const reason =
    error instanceof Failure
      ? error.reason
      : error instanceof OpenSearchError && error.status === 404
        ? 'observation_lost'
        : 'owner_unavailable';
  return {
    status: reason === 'deadline' || reason === 'owner_unavailable' ? 'unavailable' : 'unready',
    reason,
    cost: meter,
  };
}
async function sql(db: Pool | PoolClient, meter: Meter, query: string, values: unknown[] = []): Promise<QueryResult> {
  meter.statements++;
  meter.inputKeys += values.length;
  meter.bytes += Buffer.byteLength(query) + Buffer.byteLength(encode(values));
  const result = await db.query(query, values);
  meter.rows += result.rowCount ?? 0;
  meter.bytes += Buffer.byteLength(encode(result.rows));
  if (/\b(INSERT|UPDATE|DELETE)\b/.test(query)) meter.resultWrites += result.rowCount ?? 0;
  return result;
}
async function engine<T>(
  search: OpenSearch,
  meter: Meter,
  context: PublicFilterConsumerContext,
  method: Parameters<OpenSearch['request']>[0],
  path: string,
  body?: unknown,
) {
  check(context);
  meter.engineRequests++;
  meter.bytes += Buffer.byteLength(path) + Buffer.byteLength(encode(body));
  if (path.endsWith('/_search')) meter.engineSearches++;
  const response = await search.request<T>(method, path, body, {
    timeoutMs: Math.max(1, context.deadline - Date.now()),
  });
  meter.bytes += Buffer.byteLength(encode(response.body));
  if (path.endsWith('/_search'))
    meter.engineIteratorSteps += (response.body as { _shards: { total: number } })._shards.total;
  return response.body;
}
async function native(
  search: OpenSearch,
  meter: Meter,
  context: PublicFilterConsumerContext,
  target: string,
): Promise<string> {
  requireValue(/^[a-z0-9][a-z0-9_-]{0,254}$/.test(target));
  const metadata = await engine<Record<string, { settings: { index: { uuid: string } } }>>(
    search,
    meter,
    context,
    'GET',
    `/${target}/_settings`,
  );
  if (Object.keys(metadata).length !== 1 || !metadata[target]?.settings.index.uuid)
    throw new Failure('binding_mismatch');
  return metadata[target]!.settings.index.uuid;
}
function validateDefinition(definition: CustodyDefinition) {
  home(definition.source.partition);
  requireValue(Number.isInteger(definition.source.epoch) && definition.source.epoch > 0);
  text(definition.source.id);
  text(definition.source.configuration);
  text(definition.readDefinition);
  requireValue(definition.meaning.digest === releaseDigest(definition.meaning.release));
  const input = definition.capture;
  requireValue(Object.hasOwn(input, 'filterDocument') && Object.hasOwn(input, 'text'));
  requireValue(Number.isInteger(input.size) && input.size >= 1 && input.size <= 200);
  requireValue(['id', 'name', 'relevance', 'collections', 'rating'].includes(input.sort));
  if (input.filterDocument) {
    for (const node of walkFilter(input.filterDocument)) requireValue(!('owner' in node) && !('saved' in node));
    admitFilter(input.filterDocument, definition.meaning.release);
  }
  const filter = input.filterDocument
    ? compileFilter(input.filterDocument, { prefix: 'f', relationOverflow: true })
    : undefined;
  const compiledText = input.text ? compileText(input.text, { field: 'search_text', prefix: 't' }) : undefined;
  const properties = [
    ...new Set(
      filter?.leaves.flatMap((leaf) =>
        leaf.facet === 'statement' ? [leaf.property, ...(leaf.qualifiers?.map((q) => q.property) ?? [])] : [],
      ),
    ),
  ];
  const keys: PublicFilterDependencyKey[] = [{ kind: 'order', order: input.sort }];
  if (filter?.leaves.some((leaf) => leaf.facet === 'type')) keys.push({ kind: 'type' });
  keys.push(...properties.map((property) => ({ kind: 'property' as const, property })));
  // Source owns additional implicit text/order keys. Every compiler leaf must be retained, including NOT.
  for (const key of keys) requireValue(definition.dependencyKeys.some((entry) => encode(entry) === encode(key)));
  for (const [key, derived] of Object.entries({
    filter: filter?.query,
    query: compiledText?.query,
    boost: compiledText?.leaves
      .filter((leaf) => !leaf.negated)
      .map((leaf) => leaf.value)
      .join(' '),
    overflowProperties: filter
      ? [...new Set(filter.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))]
      : undefined,
  })) {
    if (Object.hasOwn(input, key)) requireValue(encode(input[key as keyof typeof input]) === encode(derived));
  }
}
async function read(
  pool: Pool,
  request: CustodyRead,
  context: PublicFilterConsumerContext,
  meter: Meter,
): Promise<CustodyFound> {
  check(context);
  queried(request.queried);
  const execution = request.execution;
  if (execution !== undefined) text(execution);
  const q = request.queried;
  const result = await sql(pool, meter, readSql, [
    partition(q.snapshot.observation),
    q.snapshot.observation,
    encode(q),
    q.consumer.incarnation,
    Date.now(),
    execution ?? null,
  ]);
  const row = result.rows[0];
  if (!row) throw new Failure('observation_lost');
  if (row.failure) throw new Failure(row.failure);
  const definition = decode<{ digest: string; data: CustodyDefinition }>(row.definition);
  requireValue(definition.digest === digest(definition.data));
  return {
    status: 'found',
    definition: definition.data,
    queried: decode(row.queried),
    covered: decode(row.covered),
    execution: execution === undefined ? null : decode(row.execution),
    cost: meter,
  };
}
export async function readPublicFilterConsumerCustody(
  pool: Pool,
  request: CustodyRead,
  context: PublicFilterConsumerContext,
): Promise<CustodyFound | CustodyFailure> {
  const meter = cost();
  try {
    return await read(pool, request, context, meter);
  } catch (error) {
    return failure(error, meter);
  }
}

/** No Source authority, ACK, permission or population completion is minted by this storage boundary. */
export function createPublicFilterCustody(pool: Pool): PublicFilterCustody {
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  function run<T>(
    context: PublicFilterConsumerContext,
    work: (meter: Meter) => Promise<T>,
    allowClosed = false,
  ): Promise<T | CustodyFailure> {
    const meter = cost();
    const promise = (async () => {
      try {
        check(context);
        if (closed && !allowClosed) throw new Failure('owner_unavailable');
        return await work(meter);
      } catch (error) {
        return failure(error, meter);
      }
    })();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }
  async function transaction<T>(meter: Meter, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withConnection(pool, async (client) => {
      await sql(client, meter, 'BEGIN');
      try {
        const value = await work(client);
        await sql(client, meter, 'COMMIT');
        return value;
      } catch (error) {
        await sql(client, meter, 'ROLLBACK');
        throw error;
      }
    });
  }
  async function registered(value: CustodyRegistration, meter: Meter) {
    registration(value);
    const result = await sql(
      pool,
      meter,
      `SELECT r.consumer FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no, physical_target)
      WHERE (r.partition_no,r.id)=($1,$2) AND r.state='active'`,
      [value.partition, value.id],
    );
    if (!result.rows[0]) throw new Failure('definition_missing');
    const consumer = decode<PublicFilterConsumer>(result.rows[0].consumer);
    return consumer;
  }
  async function retain(
    value: CustodyRegistration,
    q: PublicFilterQueriedObservation,
    covered: unknown,
    expiresAt: number,
    prepared: unknown,
    meter: Meter,
    db: Pool | PoolClient = pool,
  ) {
    const inserted = await sql(
      db,
      meter,
      `WITH retained AS (INSERT INTO search.public_filter_observation (partition_no,observation,registration,queried,covered,expires_at,state,prepared_rows)
      SELECT r.partition_no,$3,r.id,$4,$5,$6,'open',$7 FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no,physical_target)
      WHERE (r.partition_no,r.id)=($1,$2) AND r.state='active' AND t.incarnation=$8 FOR SHARE OF r,t RETURNING partition_no,observation), owned AS (INSERT INTO search.public_filter_pit SELECT partition_no,observation,$9,$10,'owned' FROM retained WHERE $10::text IS NOT NULL) SELECT observation FROM retained`,
      [
        value.partition,
        value.id,
        q.snapshot.observation,
        encode(q),
        encode(covered),
        expiresAt,
        prepared === null ? null : encode(prepared),
        q.consumer.incarnation,
        q.snapshot.kind === 'pit' ? digest(q.snapshot.pit) : null,
        q.snapshot.kind === 'pit' ? q.snapshot.pit : null,
      ],
    );
    if (!inserted.rowCount) throw new Failure('binding_mismatch');
    return { status: 'retained' as const, queried: q, cost: meter };
  }
  const api: PublicFilterCustody = {
    register(request, search, context) {
      // Copy before the first await, so concurrent caller mutation never changes persisted identity.
      const input = decode<typeof request>(encode(request));
      validateDefinition(input.definition);
      text(input.consumerGeneration);
      text(input.projectionGeneration);
      return run(context, async (meter) => {
        const incarnation = await native(search, meter, context, input.physicalTarget);
        const definition = input.definition;
        const consumer: PublicFilterConsumer = {
          physicalTarget: input.physicalTarget,
          incarnation,
          consumerGeneration: input.consumerGeneration,
          projectionGeneration: input.projectionGeneration,
          meaningDigest: definition.meaning.digest,
          readDefinition: definition.readDefinition,
        };
        const identity = {
          partition: definition.source.partition,
          id: digest({ consumer, source: definition.source.id }),
        };
        await transaction(meter, async (client) => {
          await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_target VALUES ($1,$2,$3) ON CONFLICT (partition_no,physical_target) DO UPDATE SET incarnation=EXCLUDED.incarnation`,
            [identity.partition, consumer.physicalTarget, incarnation],
          );
          const result = await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_registration VALUES ($1,$2,$3,$4,$5,'active')
            ON CONFLICT (partition_no,id) DO UPDATE SET id=EXCLUDED.id WHERE public_filter_registration.consumer=EXCLUDED.consumer AND public_filter_registration.definition=EXCLUDED.definition AND public_filter_registration.state='active' RETURNING id`,
            [
              identity.partition,
              identity.id,
              consumer.physicalTarget,
              encode(consumer),
              encode({ digest: digest(definition), data: definition }),
            ],
          );
          if (!result.rowCount) throw new Failure('binding_mismatch');
        });
        return { status: 'registered' as const, registration: identity, consumer, cost: meter };
      });
    },
    openPit(request, search, context) {
      const input = decode<typeof request>(encode(request));
      lifetime(input.keepAliveMs);
      text(input.covered.observation);
      return run(context, async (meter) => {
        const consumer = await registered(input.registration, meter);
        if ((await native(search, meter, context, consumer.physicalTarget)) !== consumer.incarnation)
          throw new Failure('binding_mismatch');
        const openedAt = Date.now();
        const opened = await engine<{ pit_id: string; _shards: { failed: number } }>(
          search,
          meter,
          context,
          'POST',
          `/${consumer.physicalTarget}/_search/point_in_time?keep_alive=${input.keepAliveMs}ms`,
        );
        text(opened.pit_id);
        try {
          if (opened._shards.failed) throw new Failure('observation_lost');
          if ((await native(search, meter, context, consumer.physicalTarget)) !== consumer.incarnation)
            throw new Failure('binding_mismatch');
          return await retain(
            input.registration,
            {
              consumer,
              snapshot: {
                kind: 'pit',
                observation: `${input.registration.partition}:${randomUUID()}`,
                pit: opened.pit_id,
              },
            },
            input.covered,
            openedAt + input.keepAliveMs,
            null,
            meter,
          );
        } catch (error) {
          await deletePit(opened.pit_id, search, context, meter);
          throw error;
        }
      });
    },
    retainPrepared(request, context) {
      const input = decode<typeof request>(encode(request));
      rows(input.rows);
      text(input.build);
      text(input.covered.observation);
      requireValue(typeof input.generation === 'bigint' && input.generation > 0n && input.expiresAt > Date.now());
      return run(context, async (meter) => {
        const consumer = await registered(input.registration, meter);
        return transaction(meter, async (client) => {
          const saved = await sql(
            client,
            meter,
            `INSERT INTO search.public_filter_prepared VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (partition_no,registration,build,generation) DO UPDATE SET build=EXCLUDED.build WHERE public_filter_prepared.rows=EXCLUDED.rows RETURNING build`,
            [
              input.registration.partition,
              input.registration.id,
              input.build,
              input.generation.toString(),
              encode(input.rows),
            ],
          );
          if (!saved.rowCount) throw new Failure('binding_mismatch');
          return retain(
            input.registration,
            {
              consumer,
              snapshot: {
                kind: 'prepared',
                observation: `${input.registration.partition}:${randomUUID()}`,
                build: input.build,
                generation: input.generation,
              },
            },
            input.covered,
            input.expiresAt,
            input.rows,
            meter,
            client,
          );
        });
      });
    },
    acquire(q, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      return run(context, async (meter) => {
        const token = randomUUID();
        const result = await sql(
          pool,
          meter,
          `WITH locked AS (
          SELECT o.partition_no,o.observation FROM search.public_filter_observation o
          JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
          JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
          WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.state='open' AND o.expires_at>$4 AND r.state='active' AND t.incarnation=$7 FOR UPDATE OF o FOR SHARE OF r,t)
          INSERT INTO search.public_filter_reference SELECT partition_no,observation,$5,$6 FROM locked RETURNING token`,
          [
            partition(input.snapshot.observation),
            input.snapshot.observation,
            encode(input),
            Date.now(),
            token,
            Math.min(context.deadline, Date.now() + 300_000),
            input.consumer.incarnation,
          ],
        );
        if (!result.rowCount) throw new Failure('observation_lost');
        return { status: 'acquired' as const, use: { observation: input.snapshot.observation, token }, cost: meter };
      });
    },
    appendExecution(request, context) {
      const input = decode<typeof request>(encode(request));
      text(input.execution.id);
      text(input.execution.start.observation);
      rows(input.execution.ownRows);
      return run(context, async (meter) => {
        const result = await sql(
          pool,
          meter,
          `WITH locked AS (
          SELECT o.partition_no,o.observation FROM search.public_filter_observation o JOIN search.public_filter_reference f USING (partition_no,observation)
          WHERE (o.partition_no,o.observation)=($1,$2) AND f.token=$3 AND f.expires_at>$4 AND o.state<>'closed' FOR UPDATE OF o)
          INSERT INTO search.public_filter_execution SELECT partition_no,observation,$5,$6 FROM locked
          ON CONFLICT (partition_no,observation,id) DO UPDATE SET id=EXCLUDED.id WHERE public_filter_execution.execution=EXCLUDED.execution RETURNING id`,
          [
            partition(input.use.observation),
            input.use.observation,
            input.use.token,
            Date.now(),
            input.execution.id,
            encode(input.execution),
          ],
        );
        if (!result.rowCount) throw new Failure('execution_missing');
        return { status: 'appended' as const, cost: meter };
      });
    },
    release(use, context) {
      return run(
        context,
        async (meter) => {
          await sql(
            pool,
            meter,
            'DELETE FROM search.public_filter_reference WHERE (partition_no,observation,token)=($1,$2,$3)',
            [partition(use.observation), use.observation, use.token],
          );
          return { status: 'released' as const, cost: meter };
        },
        true,
      );
    },
    renewPit(q, keepAliveMs, search, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      lifetime(keepAliveMs);
      return run(context, async (meter) => {
        if (input.snapshot.kind !== 'pit') throw new Failure('binding_mismatch');
        const acquired = await api.acquire(input, context);
        addCost(meter, acquired.cost);
        if (acquired.status !== 'acquired') throw new Failure(acquired.reason);
        try {
          const old = await sql(
            pool,
            meter,
            'SELECT revision FROM search.public_filter_observation WHERE (partition_no,observation)=($1,$2)',
            [partition(input.snapshot.observation), input.snapshot.observation],
          );
          if ((await native(search, meter, context, input.consumer.physicalTarget)) !== input.consumer.incarnation)
            throw new Failure('binding_mismatch');
          const renewedAt = Date.now();
          const response = await engine<{ pit_id?: string; _shards: { failed: number }; timed_out: boolean }>(
            search,
            meter,
            context,
            'POST',
            '/_search',
            {
              size: 0,
              track_total_hits: false,
              query: { match_none: {} },
              pit: { id: input.snapshot.pit, keep_alive: `${keepAliveMs}ms` },
            },
          );
          if (response.timed_out || response._shards.failed) throw new Failure('observation_lost');
          const successor: PublicFilterQueriedObservation = {
            consumer: input.consumer,
            snapshot: { ...input.snapshot, pit: response.pit_id ?? input.snapshot.pit },
          };
          await sql(
            pool,
            meter,
            `INSERT INTO search.public_filter_pit VALUES ($1,$2,$3,$4,'owned') ON CONFLICT DO NOTHING`,
            [
              partition(input.snapshot.observation),
              input.snapshot.observation,
              digest(successor.snapshot.kind === 'pit' ? successor.snapshot.pit : ''),
              successor.snapshot.kind === 'pit' ? successor.snapshot.pit : '',
            ],
          );
          const updated = await sql(
            pool,
            meter,
            `UPDATE search.public_filter_observation o SET queried=$4,expires_at=$5,revision=o.revision+1 FROM search.public_filter_registration r JOIN search.public_filter_target t USING (partition_no,physical_target)
            WHERE (o.partition_no,o.observation)=($1,$2) AND o.queried=$3 AND o.revision=$6 AND o.state='open' AND o.expires_at>$7
            AND (r.partition_no,r.id)=(o.partition_no,o.registration) AND r.state='active' AND t.incarnation=$8 RETURNING o.observation`,
            [
              partition(input.snapshot.observation),
              input.snapshot.observation,
              encode(input),
              encode(successor),
              renewedAt + keepAliveMs,
              old.rows[0].revision,
              Date.now(),
              input.consumer.incarnation,
            ],
          );
          if (!updated.rowCount) throw new Failure('observation_lost');
          return { status: 'retained' as const, queried: successor, cost: meter };
        } finally {
          addCost(meter, (await api.release(acquired.use, context)).cost);
        }
      });
    },
    closeObservation(q, search, context) {
      const input = decode<typeof q>(encode(q));
      queried(input);
      return run(context, async (meter) => {
        const values = [partition(input.snapshot.observation), input.snapshot.observation];
        const barrier = await sql(
          pool,
          meter,
          `UPDATE search.public_filter_observation SET state=CASE WHEN state='closed' THEN 'closed' ELSE 'closing' END WHERE (partition_no,observation)=($1,$2) AND queried=$3 RETURNING state`,
          [...values, encode(input)],
        );
        if (!barrier.rowCount) throw new Failure('observation_lost');
        if (barrier.rows[0].state === 'closed') return { status: 'closed' as const, cost: meter };
        const refs = await sql(
          pool,
          meter,
          'SELECT expires_at FROM search.public_filter_reference WHERE (partition_no,observation)=($1,$2) ORDER BY expires_at DESC LIMIT 1',
          values,
        );
        if (refs.rows[0])
          await Bun.sleep(Math.max(0, Math.min(Number(refs.rows[0].expires_at) + 1, context.deadline) - Date.now()));
        check(context);
        await sql(
          pool,
          meter,
          'DELETE FROM search.public_filter_reference WHERE (partition_no,observation)=($1,$2) AND expires_at<=$3',
          [...values, Date.now()],
        );
        for (;;) {
          const owned = await sql(
            pool,
            meter,
            "SELECT id,locator FROM search.public_filter_pit WHERE (partition_no,observation)=($1,$2) AND state='owned' ORDER BY id LIMIT 64",
            values,
          );
          if (!owned.rowCount) break;
          for (const pit of owned.rows) await deletePit(pit.locator, search, context, meter);
          await sql(
            pool,
            meter,
            "UPDATE search.public_filter_pit SET state='released' WHERE (partition_no,observation)=($1,$2) AND id=ANY($3::text[])",
            [...values, owned.rows.map((row) => row.id)],
          );
        }
        await sql(
          pool,
          meter,
          "UPDATE search.public_filter_observation SET state='closed' WHERE (partition_no,observation)=($1,$2) AND state='closing'",
          values,
        );
        return { status: 'closed' as const, cost: meter };
      });
    },
    retire(value, context) {
      registration(value);
      return run(context, async (meter) => {
        const result = await sql(
          pool,
          meter,
          "UPDATE search.public_filter_registration SET state='retired' WHERE (partition_no,id)=($1,$2) RETURNING id",
          [value.partition, value.id],
        );
        if (!result.rowCount) throw new Failure('definition_missing');
        return { status: 'retired' as const, cost: meter };
      });
    },
    read(request, context) {
      return run(context, (meter) => read(pool, request, context, meter));
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
  return api;
}
function addCost(target: Meter, value: CustodyCost) {
  for (const key of Object.keys(target) as (keyof Meter)[]) target[key] += value[key];
}
async function deletePit(pit: string, search: OpenSearch, context: PublicFilterConsumerContext, meter: Meter) {
  try {
    await engine(search, meter, context, 'DELETE', '/_search/point_in_time', { pit_id: [pit] });
  } catch (error) {
    if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
  }
}
