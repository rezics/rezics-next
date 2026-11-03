import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { readPartition } from '../partition/partition.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import type { SpaceDiscoveryInvalidation } from './space-discovery-events.ts';
import { SPACE_DISCOVERY_INVALIDATED } from './space-discovery-events.ts';
import {
  SPACE_DISCOVERY_DEPENDENCY_BASIS as basis,
  SPACE_DISCOVERY_DEPENDENCY_PAGE,
  spaceDiscoveryDependencyReadiness,
} from './space-discovery-dependencies.ts';

const sourcePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const decimal = /^(0|[1-9][0-9]*)$/;
const sourceTupleLimit = SPACE_DISCOVERY_DEPENDENCY_PAGE;

export type SpaceDiscoveryTupleWitnessInput = Readonly<{
  spaceId: string;
  spaceRevision: string;
  realmId: string | null;
  realmRevision: string | null;
  producerGeneration: string;
  producerEpoch: string;
  sourcePosition: string;
  tuples: readonly SourceFenceTuple[];
  origin: SpaceDiscoveryInvalidation['origin'];
}>;

export type SpaceDiscoveryTupleWitness = Readonly<{
  state: 'preparing' | 'unavailable' | 'ready';
  spaceId: string;
  spaceRevision?: string;
  realmId?: string | null;
  realmRevision?: string | null;
  producerGeneration?: string;
  producerEpoch?: string;
  sourcePosition?: string;
  witnessGeneration?: string;
  generation: string | null;
  cut: string | null;
  tuples: readonly SourceFenceTuple[];
}>;

type Identity = Pick<SourceFenceTuple, 'route' | 'source' | 'external_id' | 'field_group'>;
type OwnerHead = Readonly<{ space_revision: string; realm_id: string | null; realm_revision: string | null }>;
type Work = Readonly<{
  route: number;
  space_id: string;
  witness_generation: string;
  tuple_route: number;
  source: string;
  external_id: string;
  field_group: SourceFenceTuple['field_group'];
  action: 'upsert' | 'remove';
  producer_epoch: string;
  source_position: string;
}>;

const identity = (tuple: Identity): string =>
  JSON.stringify([tuple.route, tuple.source, tuple.external_id, tuple.field_group]);

function checkedTuple(value: unknown): SourceFenceTuple {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Space source tuple witness');
  const tuple = value as SourceFenceTuple;
  if (
    !Number.isInteger(tuple.route) ||
    tuple.route < 0 ||
    tuple.route > 65535 ||
    !sourcePattern.test(tuple.source) ||
    typeof tuple.external_id !== 'string' ||
    tuple.external_id.length < 1 ||
    tuple.external_id.length > 1024 ||
    !tuple.external_id.isWellFormed() ||
    controls.test(tuple.external_id) ||
    Buffer.byteLength(tuple.external_id, 'utf8') > 1024 ||
    !['facts', 'summary', 'cover'].includes(tuple.field_group)
  )
    throw new TypeError('Invalid Space source tuple witness');
  partitionOf(tuple.route);
  return {
    route: tuple.route,
    source: tuple.source,
    external_id: tuple.external_id,
    field_group: tuple.field_group,
  };
}

function checkedInput(input: SpaceDiscoveryTupleWitnessInput): SpaceDiscoveryTupleWitnessInput & {
  tuples: readonly SourceFenceTuple[];
} {
  const route = routeOf(input.spaceId);
  if (
    route === null ||
    routeOf(input.spaceRevision) === null ||
    (input.realmId !== null && routeOf(input.realmId) === null) ||
    (input.realmRevision !== null && routeOf(input.realmRevision) === null) ||
    typeof input.producerGeneration !== 'string' ||
    input.producerGeneration.length < 1 ||
    input.producerGeneration.length > 128 ||
    !decimal.test(input.producerEpoch) ||
    input.producerEpoch.length > 20 ||
    !decimal.test(input.sourcePosition) ||
    input.sourcePosition.length > 20 ||
    !Array.isArray(input.tuples) ||
    input.tuples.length > sourceTupleLimit
  )
    throw new TypeError('Invalid Space source tuple witness');
  const tuples = input.tuples.map(checkedTuple);
  if (new Set(tuples.map(identity)).size !== tuples.length) throw new TypeError('Duplicate Space source tuple witness');
  if (
    !Number.isInteger(input.origin.partition) ||
    input.origin.partition < 0 ||
    input.origin.partition >= PARTITIONS ||
    !decimal.test(input.origin.position)
  )
    throw new TypeError('Invalid Space source witness origin');
  return { ...input, tuples };
}

async function producer(pool: Pool) {
  return withConnection(pool, async (client) => {
    const row = (
      await client.query<{ generation: string; cut: string; complete: boolean }>(
        `SELECT generation,cut,complete FROM community.space_discovery_tuple_producer WHERE singleton=true`,
      )
    ).rows[0];
    return row ?? null;
  });
}

/** Search registers one explicit, complete source census before its per-Space witnesses can be accepted. */
export async function registerSpaceDiscoveryTupleProducer(
  pool: Pool,
  input: Readonly<{ generation: string; cut: string; complete: true }>,
): Promise<void> {
  if (
    typeof input.generation !== 'string' ||
    input.generation.length < 1 ||
    input.generation.length > 128 ||
    typeof input.cut !== 'string' ||
    input.cut.length < 1 ||
    input.cut.length > 256 ||
    input.complete !== true
  )
    throw new TypeError('Invalid Space tuple producer cut');
  const digest = createHash('sha256').update(canonicalize(input)!).digest();
  await runCommand(
    pool,
    {
      partition: 0,
      basis,
      receipt: {
        actorAccountId: basis.actorAccountId,
        kind: 'community.space-tuple-producer.register',
        key: createHash('sha256').update(input.generation).digest('hex'),
        digest,
      },
    },
    async (tx) => {
      const current = (
        await tx.query<{ generation: string; cut: string; complete: boolean }>(
          `SELECT generation,cut,complete FROM community.space_discovery_tuple_producer WHERE singleton=true FOR UPDATE`,
        )
      ).rows[0];
      if (current && current.generation !== input.generation)
        throw new TypeError('Space tuple producer generation cannot replace retained witnesses');
      if (current && current.cut !== input.cut)
        throw new TypeError('Space tuple producer cut changed without a new generation');
      if (current?.complete) return noEffect(null);
      await tx.query(
        `INSERT INTO community.space_discovery_tuple_producer(singleton,generation,cut,complete)
         VALUES(true,$1,$2,true) ON CONFLICT(singleton) DO UPDATE SET complete=true`,
        [input.generation, input.cut],
      );
      return noEffect(null);
    },
  );
}

async function currentHead(
  client: Pick<PoolClient, 'query'>,
  route: number,
  spaceId: string,
): Promise<OwnerHead | null> {
  const row = (
    await client.query<OwnerHead>(
      `SELECT s.head_revision_id::text AS space_revision,r.realm_id::text AS realm_id,
              r.head_revision_id::text AS realm_revision
       FROM community.space s LEFT JOIN community.realm r ON r.route=s.route AND r.space_id=s.space_id
       WHERE s.route=$1 AND s.space_id=$2 FOR UPDATE OF s`,
      [route, spaceId],
    )
  ).rows[0];
  return row ?? null;
}

function receiptDigest(input: SpaceDiscoveryTupleWitnessInput): Buffer {
  return createHash('sha256').update(canonicalize(input)!).digest();
}

/** Publish an exact current source-owner witness. Tuple inverse edges are installed at tuple home later. */
export async function publishSpaceDiscoveryTupleWitness(
  pool: Pool,
  rawInput: SpaceDiscoveryTupleWitnessInput,
): Promise<SpaceDiscoveryTupleWitness> {
  const input = checkedInput(rawInput);
  const route = routeOf(input.spaceId)!;
  const partition = partitionOf(route);
  const registered = await producer(pool);
  if (!registered?.complete || registered.generation !== input.producerGeneration)
    throw new TypeError('Space tuple producer has no matching complete cut');
  const result = await runCommand(
    pool,
    {
      partition,
      basis,
      receipt: {
        actorAccountId: basis.actorAccountId,
        kind: 'community.space-tuple-witness.publish',
        key: createHash('sha256')
          .update(`${input.spaceId}\n${input.producerGeneration}\n${input.producerEpoch}\n${input.sourcePosition}`)
          .digest('hex'),
        digest: receiptDigest(input),
      },
    },
    async (tx) => {
      const head = await currentHead(tx, route, input.spaceId);
      if (
        !head ||
        head.space_revision !== input.spaceRevision ||
        head.realm_id !== input.realmId ||
        head.realm_revision !== input.realmRevision
      )
        throw new TypeError('Space tuple witness does not match the current native head');
      const previous = (
        await tx.query<{
          witness_generation: string;
          producer_generation: string | null;
          producer_epoch: string;
          source_position: string;
          state: 'preparing' | 'unavailable' | 'ready';
        }>(
          `SELECT witness_generation::text,producer_generation,producer_epoch::text,source_position::text,state
           FROM community.space_discovery_tuple_witness WHERE route=$1 AND space_id=$2 FOR UPDATE`,
          [route, input.spaceId],
        )
      ).rows[0];
      if (!previous) throw new Error('Space tuple witness installation is unavailable');
      const pendingWork = await tx.query(
        `SELECT 1 FROM community.space_discovery_tuple_work WHERE route=$1 AND space_id=$2 LIMIT 1`,
        [route, input.spaceId],
      );
      if (previous.state === 'preparing' || pendingWork.rows.length)
        throw new TypeError('Space tuple witness repair is pending');
      if (previous.producer_generation === input.producerGeneration) {
        const oldEpoch = BigInt(previous.producer_epoch);
        const newEpoch = BigInt(input.producerEpoch);
        const oldPosition = BigInt(previous.source_position);
        const newPosition = BigInt(input.sourcePosition);
        if (newEpoch < oldEpoch || (newEpoch === oldEpoch && newPosition < oldPosition))
          throw new TypeError('Stale Space tuple producer position');
      }
      const witnessGeneration = (
        await tx.query<{ value: string }>(
          `SELECT nextval('community.space_discovery_tuple_witness_key')::text AS value`,
        )
      ).rows[0]!.value;
      const oldReferences = (
        await tx.query<Identity>(
          `SELECT tuple_route AS route,source,external_id,field_group
           FROM community.space_discovery_tuple_reference WHERE route=$1 AND space_id=$2
           UNION
           SELECT tuple_route AS route,source,external_id,field_group
           FROM community.space_discovery_tuple_work WHERE route=$1 AND space_id=$2`,
          [route, input.spaceId],
        )
      ).rows;
      const newKeys = new Set(input.tuples.map(identity));
      await tx.query('DELETE FROM community.space_discovery_tuple_work WHERE route=$1 AND space_id=$2', [
        route,
        input.spaceId,
      ]);
      await tx.query('DELETE FROM community.space_discovery_tuple_expected WHERE route=$1 AND space_id=$2', [
        route,
        input.spaceId,
      ]);
      for (const tuple of input.tuples) {
        await tx.query(
          `INSERT INTO community.space_discovery_tuple_expected
            (route,space_id,witness_generation,tuple_route,source,external_id,field_group)
           VALUES($1,$2,$3::bigint,$4,$5,$6,$7)`,
          [route, input.spaceId, witnessGeneration, tuple.route, tuple.source, tuple.external_id, tuple.field_group],
        );
        await tx.query(
          `INSERT INTO community.space_discovery_tuple_work
            (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
           VALUES($1,$2,$3::bigint,$4,$5,$6,$7,'upsert',$8::numeric,$9::numeric)`,
          [
            route,
            input.spaceId,
            witnessGeneration,
            tuple.route,
            tuple.source,
            tuple.external_id,
            tuple.field_group,
            input.producerEpoch,
            input.sourcePosition,
          ],
        );
      }
      for (const old of oldReferences) {
        if (newKeys.has(identity(old))) continue;
        await tx.query(
          `INSERT INTO community.space_discovery_tuple_work
            (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
           VALUES($1,$2,$3::bigint,$4,$5,$6,$7,'remove',$8::numeric,$9::numeric)`,
          [
            route,
            input.spaceId,
            witnessGeneration,
            old.route,
            old.source,
            old.external_id,
            old.field_group,
            input.producerEpoch,
            input.sourcePosition,
          ],
        );
      }
      const work = input.tuples.length + oldReferences.filter((old) => !newKeys.has(identity(old))).length;
      const nextState = work ? 'preparing' : 'ready';
      await tx.query(
        `UPDATE community.space_discovery_tuple_witness SET witness_generation=$3::bigint,
          space_revision=$4::uuid,realm_id=$5::uuid,realm_revision=$6::uuid,
          producer_generation=$7,producer_epoch=$8::numeric,source_position=$9::numeric,
          tuple_count=$10,state=$11
         WHERE route=$1 AND space_id=$2`,
        [
          route,
          input.spaceId,
          witnessGeneration,
          input.spaceRevision,
          input.realmId,
          input.realmRevision,
          input.producerGeneration,
          input.producerEpoch,
          input.sourcePosition,
          input.tuples.length,
          nextState,
        ],
      );
      const capabilityDelta =
        previous.state === 'ready' && work > 0
          ? { witnessed: -1, pending: 1 }
          : previous.state !== 'ready' && work === 0
            ? { witnessed: 1, pending: -1 }
            : { witnessed: 0, pending: 0 };
      await tx.query(
        `UPDATE community.space_discovery_tuple_capability
         SET witnessed=witnessed+$2,pending=pending+$3,cut=cut+1 WHERE partition_no=$1`,
        [partition, capabilityDelta.witnessed, capabilityDelta.pending],
      );
      if (!work) {
        await tx.query(
          `UPDATE community.space_discovery_tuple_reference SET witness_generation=$3::bigint
           WHERE route=$1 AND space_id=$2`,
          [route, input.spaceId, witnessGeneration],
        );
      }
      const invalidation: SpaceDiscoveryInvalidation = {
        target: { kind: 'space', id: input.spaceId },
        origin: input.origin,
        revisionId: input.spaceRevision,
        nativeVersion: null,
      };
      return {
        value: {
          state: nextState,
          spaceId: input.spaceId,
          spaceRevision: input.spaceRevision,
          realmId: input.realmId,
          realmRevision: input.realmRevision,
          producerGeneration: input.producerGeneration,
          producerEpoch: input.producerEpoch,
          sourcePosition: input.sourcePosition,
          witnessGeneration,
          generation: registered.generation,
          cut: registered.cut,
          tuples: nextState === 'ready' ? input.tuples : [],
        } satisfies SpaceDiscoveryTupleWitness,
        events: [
          {
            type: SPACE_DISCOVERY_INVALIDATED,
            subject: input.spaceId,
            data: invalidation,
          },
        ],
      };
    },
  );
  return result.value;
}

export type SpaceDiscoveryTupleWorkLocator = Readonly<{ route: number; spaceId: string }>;

/** Indexed maintenance locator for tuple-home work; history never supplies a cursor. */
export function nextSpaceDiscoveryTupleWitnessWork(pool: Pool): Promise<SpaceDiscoveryTupleWorkLocator | null> {
  return withConnection(pool, async (client) => {
    const row = (
      await client.query<{ route: number; space_id: string }>(
        `SELECT route,space_id FROM community.space_discovery_tuple_work
         ORDER BY route,space_id,witness_generation LIMIT 1`,
      )
    ).rows[0];
    return row ? { route: row.route, spaceId: row.space_id } : null;
  });
}

async function applyTupleWork(pool: Pool, work: Work): Promise<void> {
  const tuple = {
    route: work.tuple_route,
    source: work.source,
    external_id: work.external_id,
    field_group: work.field_group,
  } as const;
  const tuplePartition = partitionOf(tuple.route);
  const workIdentity = `${work.route}\n${work.space_id}\n${work.witness_generation}\n${identity(tuple)}\n${work.action}`;
  await runCommand(
    pool,
    {
      partition: tuplePartition,
      basis,
      receipt: {
        actorAccountId: basis.actorAccountId,
        kind: 'community.space-source-tuple.edge',
        key: createHash('sha256').update(workIdentity).digest('hex'),
        digest: createHash('sha256').update(workIdentity).digest(),
      },
    },
    async (tx) => {
      await tx.query(
        `INSERT INTO community.space_discovery_tuple_inverse
          (tuple_route,source,external_id,field_group,space_route,space_id,witness_generation,
           source_epoch,source_position,active)
         VALUES($1,$2,$3,$4,$5,$6,$7::bigint,$8::numeric,$9::numeric,$10)
         ON CONFLICT(tuple_route,source,external_id,field_group,space_route,space_id) DO UPDATE SET
           witness_generation=EXCLUDED.witness_generation,source_epoch=EXCLUDED.source_epoch,
           source_position=EXCLUDED.source_position,active=EXCLUDED.active,
           ordinal=nextval('community.space_discovery_tuple_inverse_key')
         WHERE community.space_discovery_tuple_inverse.witness_generation<EXCLUDED.witness_generation`,
        [
          tuple.route,
          tuple.source,
          tuple.external_id,
          tuple.field_group,
          work.route,
          work.space_id,
          work.witness_generation,
          work.producer_epoch,
          work.source_position,
          work.action === 'upsert',
        ],
      );
      return noEffect(null);
    },
  );
}

async function acknowledgeTupleWork(pool: Pool, work: Work): Promise<void> {
  await runCommand(pool, { partition: partitionOf(work.route), basis }, async (tx) => {
    const head = await currentHead(tx, work.route, work.space_id);
    if (!head) return noEffect(null);
    const current = (
      await tx.query<{ witness_generation: string; state: string }>(
        `SELECT witness_generation::text,state FROM community.space_discovery_tuple_witness
         WHERE route=$1 AND space_id=$2 FOR UPDATE`,
        [work.route, work.space_id],
      )
    ).rows[0];
    if (!current) return noEffect(null);
    const exists = await tx.query(
      `SELECT 1 FROM community.space_discovery_tuple_work
       WHERE route=$1 AND space_id=$2 AND witness_generation=$3::bigint AND tuple_route=$4
         AND source=$5 AND external_id=$6 AND field_group=$7 AND action=$8`,
      [
        work.route,
        work.space_id,
        work.witness_generation,
        work.tuple_route,
        work.source,
        work.external_id,
        work.field_group,
        work.action,
      ],
    );
    if (!exists.rows.length) return noEffect(null);
    if (current.witness_generation === work.witness_generation) {
      if (work.action === 'upsert') {
        await tx.query(
          `INSERT INTO community.space_discovery_tuple_reference
            (route,space_id,tuple_route,source,external_id,field_group,witness_generation)
           VALUES($1,$2,$3,$4,$5,$6,$7::bigint)
           ON CONFLICT(route,space_id,tuple_route,source,external_id,field_group)
           DO UPDATE SET witness_generation=EXCLUDED.witness_generation`,
          [
            work.route,
            work.space_id,
            work.tuple_route,
            work.source,
            work.external_id,
            work.field_group,
            work.witness_generation,
          ],
        );
      } else {
        await tx.query(
          `DELETE FROM community.space_discovery_tuple_reference
           WHERE route=$1 AND space_id=$2 AND tuple_route=$3 AND source=$4 AND external_id=$5
             AND field_group=$6 AND witness_generation<$7::bigint`,
          [
            work.route,
            work.space_id,
            work.tuple_route,
            work.source,
            work.external_id,
            work.field_group,
            work.witness_generation,
          ],
        );
      }
    }
    await tx.query(
      `DELETE FROM community.space_discovery_tuple_work
       WHERE route=$1 AND space_id=$2 AND witness_generation=$3::bigint AND tuple_route=$4
         AND source=$5 AND external_id=$6 AND field_group=$7 AND action=$8`,
      [
        work.route,
        work.space_id,
        work.witness_generation,
        work.tuple_route,
        work.source,
        work.external_id,
        work.field_group,
        work.action,
      ],
    );
    if (current.state !== 'preparing' || current.witness_generation !== work.witness_generation) return noEffect(null);
    const pending = await tx.query(
      `SELECT 1 FROM community.space_discovery_tuple_work
       WHERE route=$1 AND space_id=$2 AND witness_generation=$3::bigint LIMIT 1`,
      [work.route, work.space_id, work.witness_generation],
    );
    if (pending.rows.length) return noEffect(null);
    const witness = (
      await tx.query<{ space_revision: string; realm_id: string | null; realm_revision: string | null }>(
        `SELECT space_revision::text,realm_id::text,realm_revision::text
         FROM community.space_discovery_tuple_witness WHERE route=$1 AND space_id=$2`,
        [work.route, work.space_id],
      )
    ).rows[0]!;
    if (
      !head ||
      witness.space_revision !== head.space_revision ||
      witness.realm_id !== head.realm_id ||
      witness.realm_revision !== head.realm_revision
    ) {
      await tx.query(
        `UPDATE community.space_discovery_tuple_witness SET state='unavailable'
         WHERE route=$1 AND space_id=$2 AND witness_generation=$3::bigint`,
        [work.route, work.space_id, work.witness_generation],
      );
      return noEffect(null);
    }
    await tx.query(
      `UPDATE community.space_discovery_tuple_witness SET state='ready'
       WHERE route=$1 AND space_id=$2 AND witness_generation=$3::bigint AND state='preparing'`,
      [work.route, work.space_id, work.witness_generation],
    );
    await tx.query(
      `UPDATE community.space_discovery_tuple_capability SET pending=pending-1,witnessed=witnessed+1,cut=cut+1
       WHERE partition_no=$1`,
      [partitionOf(work.route)],
    );
    return noEffect(null);
  });
}

/** Apply at most fifty inverse edges, each in tuple home, then acknowledge from the Space home. */
export async function repairSpaceDiscoveryTupleWitness(
  pool: Pool,
  partition: number,
  spaceId: string,
  limit = SPACE_DISCOVERY_DEPENDENCY_PAGE,
): Promise<boolean> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid Space tuple work partition');
  if (!Number.isInteger(limit) || limit < 1 || limit > SPACE_DISCOVERY_DEPENDENCY_PAGE)
    throw new RangeError('Space tuple work page limit must be 1..50');
  const route = routeOf(spaceId);
  if (route === null || partitionOf(route) !== partition) throw new TypeError('Invalid Space tuple work locator');
  const page = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<Work>(
          `SELECT w.route,w.space_id,w.witness_generation::text,w.tuple_route,w.source,w.external_id,
                w.field_group,w.action,w.producer_epoch::text,w.source_position::text
         FROM community.space_discovery_tuple_work w
         WHERE w.route=$1 AND w.space_id=$2
         ORDER BY w.witness_generation,w.tuple_route,w.source,w.external_id,w.field_group,w.action LIMIT $3`,
          [route, spaceId, limit],
        )
      ).rows,
  );
  for (const work of page) {
    await applyTupleWork(pool, work);
    await acknowledgeTupleWork(pool, work);
  }
  return page.length === limit;
}

async function readOwnerWitnesses(pool: Pool, keys: readonly Readonly<{ route: number; id: string }>[]) {
  const groups = new Map<number, (typeof keys)[number][]>();
  for (const key of keys) {
    const partition = partitionOf(key.route);
    const group = groups.get(partition) ?? [];
    group.push(key);
    groups.set(partition, group);
  }
  const witnesses = new Map<string, SpaceDiscoveryTupleWitness>();
  for (const [partition, group] of groups) {
    await withConnection(pool, async (connection) => {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const anchor = await readPartition(connection, partition);
        if (!anchor || anchor.writeState !== 'active') throw new Error('Space tuple owner is unavailable');
        const rows = (
          await connection.query<{
            route: number;
            space_id: string;
            current_space_revision: string;
            current_realm_id: string | null;
            current_realm_revision: string | null;
            witness_generation: string | null;
            space_revision: string | null;
            realm_id: string | null;
            realm_revision: string | null;
            producer_generation: string | null;
            producer_epoch: string | null;
            source_position: string | null;
            state: 'preparing' | 'unavailable' | 'ready' | null;
          }>(
            `WITH requested AS MATERIALIZED (
               SELECT * FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid)
             )
             SELECT s.route,s.space_id,s.head_revision_id::text AS current_space_revision,
                    r.realm_id::text AS current_realm_id,r.head_revision_id::text AS current_realm_revision,
                    w.witness_generation::text,w.space_revision::text,w.realm_id::text,w.realm_revision::text,
                    w.producer_generation,w.producer_epoch::text,w.source_position::text,w.state
             FROM requested k JOIN community.space s ON s.route=k.route AND s.space_id=k.id
             LEFT JOIN community.realm r ON r.route=s.route AND r.space_id=s.space_id
             LEFT JOIN community.space_discovery_tuple_witness w ON w.route=s.route AND w.space_id=s.space_id`,
            [JSON.stringify(group)],
          )
        ).rows;
        const refs = rows.length
          ? (
              await connection.query<Identity & { space_id: string }>(
                `WITH requested AS MATERIALIZED (
                   SELECT * FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid)
                 )
                 SELECT d.space_id,d.tuple_route AS route,d.source,d.external_id,d.field_group
                 FROM requested k JOIN community.space_discovery_tuple_reference d
                   ON d.route=k.route AND d.space_id=k.id
                 ORDER BY d.route,d.space_id,d.tuple_route,d.source,d.external_id,d.field_group`,
                [JSON.stringify(group)],
              )
            ).rows
          : [];
        const tuples = new Map<string, SourceFenceTuple[]>();
        for (const ref of refs) {
          const list = tuples.get(ref.space_id) ?? [];
          list.push({
            route: ref.route,
            source: ref.source,
            external_id: ref.external_id,
            field_group: ref.field_group,
          });
          tuples.set(ref.space_id, list);
        }
        for (const row of rows) {
          const current =
            row.state === 'ready' &&
            row.space_revision === row.current_space_revision &&
            row.realm_id === row.current_realm_id &&
            row.realm_revision === row.current_realm_revision;
          witnesses.set(row.space_id, {
            state: current ? 'ready' : row.state === 'preparing' ? 'preparing' : 'unavailable',
            spaceId: row.space_id,
            ...(current
              ? {
                  spaceRevision: row.space_revision!,
                  realmId: row.realm_id,
                  realmRevision: row.realm_revision,
                  producerGeneration: row.producer_generation!,
                  producerEpoch: row.producer_epoch!,
                  sourcePosition: row.source_position!,
                  witnessGeneration: row.witness_generation!,
                }
              : {}),
            generation: null,
            cut: null,
            tuples: current ? (tuples.get(row.space_id) ?? []) : [],
          });
        }
        await connection.query('COMMIT');
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          /* Keep the original source-owner failure. */
        }
        throw error;
      }
    });
  }
  return witnesses;
}

async function readTupleFences(pool: Pool, tuples: readonly SourceFenceTuple[]) {
  const groups = new Map<number, SourceFenceTuple[]>();
  for (const tuple of tuples) {
    const partition = partitionOf(tuple.route);
    const group = groups.get(partition) ?? [];
    group.push(tuple);
    groups.set(partition, group);
  }
  const fenced = new Set<string>();
  for (const [partition, group] of groups) {
    await withConnection(pool, async (connection) => {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const anchor = await readPartition(connection, partition);
        if (!anchor || anchor.writeState !== 'active') throw new Error('Source tuple home is unavailable');
        for (let offset = 0; offset < group.length; offset += 100) {
          const found = await readFences(
            await partitionReadClient(connection, partition),
            group.slice(offset, offset + 100),
          );
          for (const fence of found) if (fence.takenDown) fenced.add(identity(fence));
        }
        await connection.query('COMMIT');
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          /* Keep the original tuple-owner failure. */
        }
        throw error;
      }
    });
  }
  return fenced;
}

/** Exact current tuple witnesses with a pre/final fence read and capability cut recheck. */
export async function readSpaceDiscoveryTupleWitnesses(
  pool: Pool,
  ids: readonly string[],
): Promise<ReadonlyMap<string, SpaceDiscoveryTupleWitness>> {
  if (!Array.isArray(ids) || ids.length > 100) throw new RangeError('At most 100 Space tuple witnesses');
  const keys = [
    ...new Map(
      ids.map((id) => {
        const route = routeOf(id);
        if (route === null) throw new TypeError('Invalid Space tuple witness key');
        return [id, { route, id }] as const;
      }),
    ).values(),
  ];
  const unavailable = (spaceId: string, state: 'preparing' | 'unavailable', current?: SpaceDiscoveryTupleWitness) =>
    ({
      state,
      spaceId: current?.spaceId ?? spaceId,
      generation: null,
      cut: null,
      tuples: [],
    }) satisfies SpaceDiscoveryTupleWitness;
  const before = await spaceDiscoveryDependencyReadiness(pool);
  if (before.state !== 'ready') return new Map(keys.map(({ id }) => [id, unavailable(id, before.state)]));
  const first = await readOwnerWitnesses(pool, keys);
  const candidateTuples = [...first.values()].flatMap((witness) =>
    witness.state === 'ready' ? [...witness.tuples] : [],
  );
  const preFenced = await readTupleFences(pool, candidateTuples);
  const second = await readOwnerWitnesses(pool, keys);
  const same = (left: SpaceDiscoveryTupleWitness | undefined, right: SpaceDiscoveryTupleWitness | undefined) =>
    left?.state === 'ready' &&
    right?.state === 'ready' &&
    left.witnessGeneration === right.witnessGeneration &&
    left.spaceRevision === right.spaceRevision &&
    left.realmId === right.realmId &&
    left.realmRevision === right.realmRevision &&
    left.producerGeneration === right.producerGeneration &&
    left.producerEpoch === right.producerEpoch &&
    left.sourcePosition === right.sourcePosition &&
    JSON.stringify(left.tuples.map(identity)) === JSON.stringify(right.tuples.map(identity));
  if (keys.some(({ id }) => !same(first.get(id), second.get(id))))
    return new Map(keys.map(({ id }) => [id, unavailable(id, 'unavailable', second.get(id))]));
  const finalFenced = await readTupleFences(pool, candidateTuples);
  const after = await spaceDiscoveryDependencyReadiness(pool);
  if (after.state !== 'ready' || after.generation !== before.generation || after.cut !== before.cut)
    return new Map(
      keys.map(({ id }) => [id, unavailable(id, after.state === 'preparing' ? 'preparing' : 'unavailable')]),
    );
  const result = new Map<string, SpaceDiscoveryTupleWitness>();
  for (const { id } of keys) {
    const witness = second.get(id);
    if (!witness || witness.state !== 'ready') {
      result.set(id, unavailable(id, witness?.state === 'preparing' ? 'preparing' : 'unavailable', witness));
      continue;
    }
    if (witness.tuples.some((tuple) => preFenced.has(identity(tuple)) || finalFenced.has(identity(tuple)))) {
      result.set(id, unavailable(id, 'unavailable', witness));
      continue;
    }
    result.set(id, { ...witness, generation: before.generation, cut: before.cut });
  }
  return result;
}
