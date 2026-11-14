import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { validSourceFigures, type SourceFigures } from './source-figures.ts';
import {
  SOURCE_OBSERVATION_PAYLOAD_VERSION,
  sourceObservation,
  sourceProvider,
  type SourceObservation,
  type SourceProvider,
} from './source-provider.ts';

const MAX_OBSERVATIONS = 256;
type Envelope = {
  digest: string;
  payload: SourceObservation;
  payloadVersion: number;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  nativeOrder: string | null;
  seekOrder: string | null;
  transactionId: string;
};
type Projection = {
  sourceAlias: string;
  sourceRecordId: string;
  scaleMin: number;
  scaleMax: number;
  mean: string;
  figures: SourceFigures | null;
  count: number;
  asOf: string;
  licence: string;
  attribution: string;
  transactionId: string;
  observationDigest: string | null;
};
type Head = { digest: string; lastOrder: string; lastSeekOrder: string };

function fail(detail: string): never {
  throw new Error(`Source observation materialization: ${detail}`);
}

/** Maintenance accepts the same facts as native publication, including a closed
 * clear payload. A matching content hash alone does not establish a valid fact.
 */
export function validMaterializedSourceObservation(source: SourceProvider, value: unknown): value is SourceObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const text = (part: unknown, max: number): part is string =>
    typeof part === 'string' && part.length > 0 && Buffer.byteLength(part, 'utf8') <= max;
  if (
    typeof payload.sourceAlias !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(payload.sourceAlias) ||
    !text(payload.sourceRecordId, 1024) || /[\u0000-\u001f\u007f-\u009f]/.test(payload.sourceRecordId) ||
    !sourceProvider(source)?.record(payload.sourceRecordId) ||
    typeof payload.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.asOf)
  ) return false;
  const date = new Date(`${payload.asOf}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== payload.asOf) return false;
  const shared = ['sourceAlias', 'sourceRecordId', 'count', 'asOf'];
  if (payload.count === 0) return Object.keys(payload).every((key) => shared.includes(key));
  if (!Number.isSafeInteger(payload.count) || (payload.count as number) < 1 ||
    (payload.count as number) > 2_147_483_647 || payload.scale === null ||
    typeof payload.scale !== 'object' || Array.isArray(payload.scale)) return false;
  const scale = payload.scale as Record<string, unknown>;
  if (Object.keys(scale).length !== 2 || !Number.isSafeInteger(scale.min) || !Number.isSafeInteger(scale.max) ||
    !sourceProvider(source)!.scale(scale.min as number, scale.max as number) ||
    typeof payload.mean !== 'number' || !Number.isFinite(payload.mean) ||
    payload.mean < (scale.min as number) || payload.mean > (scale.max as number) ||
    !text(payload.licence, 1024) || !text(payload.attribution, 2000)) return false;
  const fields = [...shared, 'scale', 'mean', 'licence', 'attribution', 'figures'];
  return Object.keys(payload).every((key) => fields.includes(key)) &&
    (payload.figures === undefined || validSourceFigures(source, payload.figures, payload.count as number));
}

function verifyEnvelope(row: Envelope, subjectId: string, source: SourceProvider) {
  if (row.payloadVersion !== SOURCE_OBSERVATION_PAYLOAD_VERSION) fail('unsupported payload version');
  if (!validMaterializedSourceObservation(source, row.payload)) fail('invalid observation payload');
  const observed = sourceObservation(subjectId, source, row.payload);
  if (
    observed.digest !== row.digest ||
    canonicalize(observed.payload) !== canonicalize(row.payload) ||
    row.payload.sourceAlias !== row.sourceAlias ||
    row.payload.sourceRecordId !== row.sourceRecordId ||
    row.payload.asOf !== row.asOf
  )
    fail('stored observation does not match its immutable envelope');
}

function observationFromProjection(row: Projection, subjectId: string, source: SourceProvider) {
  if (row.figures !== null && !validSourceFigures(source, row.figures, Number(row.count)))
    fail('projection has invalid figures');
  const observed = sourceObservation(subjectId, source, {
    sourceAlias: row.sourceAlias,
    sourceRecordId: row.sourceRecordId,
    scale: { min: Number(row.scaleMin), max: Number(row.scaleMax) },
    mean: Number(row.mean),
    ...(row.figures === null ? {} : { figures: row.figures }),
    count: Number(row.count),
    asOf: row.asOf,
    licence: row.licence,
    attribution: row.attribution,
  });
  if (!validMaterializedSourceObservation(source, observed.payload)) fail('invalid projection payload');
  return observed;
}

async function currentProjection(client: PoolClient, key: readonly [number, string, SourceProvider]) {
  return (
    await client.query<Projection>(
      `SELECT source_alias AS "sourceAlias", source_record_id AS "sourceRecordId",
              scale_min AS "scaleMin", scale_max AS "scaleMax", mean::text, figures, count,
              as_of::text AS "asOf", licence, attribution, transaction_id::text AS "transactionId",
              observation_digest AS "observationDigest"
       FROM rating.source_statistic WHERE route=$1 AND subject_id=$2 AND source=$3`,
      [...key],
    )
  ).rows[0];
}

type SlotKey = [number, string, SourceProvider];
type Phase = 'unknown' | 'native' | 'done';
type Progress = {
  phase: Phase;
  cursorDigest: string | null;
  cursorOrder: string | null;
  allocated: string;
  processed: string;
  nativeMax: string;
  headDigest: string;
  headTransaction: string;
  projectionTransaction: string | null;
  projectionDigest: string | null;
  adoptedDigest: string | null;
  materialized: boolean;
};
type MaintenanceInput = Readonly<{ route: number; subjectId: string; source: SourceProvider; limit?: number }>;

const envelopeColumns = `digest, payload, payload_version AS "payloadVersion", source_alias AS "sourceAlias",
  source_record_id AS "sourceRecordId", as_of::text AS "asOf", local_order::text AS "nativeOrder",
  seek_order::text AS "seekOrder", transaction_id::text AS "transactionId"`;
const progressColumns = `phase, cursor_digest AS "cursorDigest", cursor_order::text AS "cursorOrder",
  allocated::text, processed::text, native_max::text AS "nativeMax", head_digest AS "headDigest",
  head_transaction::text AS "headTransaction", projection_transaction::text AS "projectionTransaction",
  projection_digest AS "projectionDigest", adopted_digest AS "adoptedDigest", materialized`;

class InvalidatedMaterialization extends Error {}
function invalidated(detail: string): never {
  throw new InvalidatedMaterialization('Source observation materialization invalidated: ' + detail);
}

/** Explicit operator preparation for an older database, before runtime deployment.
 * These operational indexes and progress rows are not a second observation format.
 * The shipped baseline and migration retain their final NOT NULL constraints.
 */
export async function prepareSourceObservationMaterialization(pool: Pool) {
  await pool.query(`
    ALTER TABLE rating.source_statistic_observation ADD COLUMN IF NOT EXISTS seek_order bigint;
    ALTER TABLE rating.source_statistic_head ADD COLUMN IF NOT EXISTS last_seek_order bigint NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS rating.source_observation_materialization (
      route integer NOT NULL,
      subject_id uuid NOT NULL,
      source text NOT NULL CHECK (source IN ('vndb','bangumi')),
      phase text NOT NULL CHECK (phase IN ('unknown','native','done')),
      cursor_digest text,
      cursor_order bigint,
      allocated bigint NOT NULL,
      processed bigint NOT NULL DEFAULT 0,
      native_max bigint NOT NULL,
      head_digest text NOT NULL,
      head_transaction uuid NOT NULL,
      projection_transaction uuid,
      projection_digest text,
      adopted_digest text,
      materialized boolean NOT NULL,
      PRIMARY KEY (route,subject_id,source),
      FOREIGN KEY (route,subject_id) REFERENCES semantic.subject (route,subject_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS source_observation_materialization_unknown_idx
      ON rating.source_statistic_observation (route,subject_id,source,digest)
      WHERE seek_order IS NULL AND local_order IS NULL;
    CREATE INDEX IF NOT EXISTS source_observation_materialization_native_idx
      ON rating.source_statistic_observation (route,subject_id,source,local_order,digest)
      WHERE seek_order IS NULL AND local_order IS NOT NULL;
    CREATE INDEX IF NOT EXISTS source_observation_materialization_unkeyed_idx
      ON rating.source_statistic_observation (route,subject_id,source,digest) WHERE seek_order IS NULL;
    CREATE INDEX IF NOT EXISTS source_observation_materialization_seek_idx
      ON rating.source_statistic_observation (route,subject_id,source,seek_order DESC)
      WHERE seek_order IS NOT NULL;
  `);
}

async function currentEnvelope(client: PoolClient, key: SlotKey, digest: string) {
  return (await client.query<Envelope>(
    'SELECT ' + envelopeColumns + ` FROM rating.source_statistic_observation
     WHERE route=$1 AND subject_id=$2 AND source=$3 AND digest=$4`, [...key, digest],
  )).rows[0];
}

async function currentHead(client: PoolClient, key: SlotKey) {
  return (await client.query<Head>(
    `SELECT digest, last_order::text AS "lastOrder", last_seek_order::text AS "lastSeekOrder"
     FROM rating.source_statistic_head WHERE route=$1 AND subject_id=$2 AND source=$3`, key,
  )).rows[0];
}

function verifyProjection(
  current: Envelope, projection: Projection | undefined, subjectId: string, source: SourceProvider,
) {
  if (current.payload.count === 0) {
    if (projection !== undefined) fail('cleared head retains a projection');
    return;
  }
  if (projection === undefined) fail('published head has no projection');
  const projected = observationFromProjection(projection, subjectId, source);
  if (projected.digest !== current.digest || canonicalize(projected.payload) !== canonicalize(current.payload))
    fail('projection facts differ from its authoritative envelope');
  if (projection.observationDigest !== null && projection.observationDigest !== current.digest)
    fail('projection digest differs from its authoritative head');
}

function result(progress: Progress | null, examined: number) {
  return {
    done: progress === null || progress.phase === 'done',
    cursor: progress === null || progress.phase === 'done' ? null : {
      phase: progress.phase, digest: progress.cursorDigest, nativeOrder: progress.cursorOrder,
    },
    examined,
    observations: progress?.processed ?? '0',
    head: progress?.headDigest ?? null,
    materialized: progress?.materialized ?? false,
  };
}

async function start(client: PoolClient, key: SlotKey): Promise<Progress | null> {
  let head = await currentHead(client, key);
  const projection = await currentProjection(client, key);
  const firstUnkeyed = (await client.query(
    `SELECT 1 FROM rating.source_statistic_observation
     WHERE route=$1 AND subject_id=$2 AND source=$3 AND seek_order IS NULL LIMIT 1`, key,
  )).rows[0];
  let current = head ? await currentEnvelope(client, key, head.digest) : undefined;
  if (head && !current) invalidated('head has no retained envelope');
  if (current) {
    verifyEnvelope(current, key[1], key[2]);
    verifyProjection(current, projection, key[1], key[2]);
    // Keep issued cursors and immutable seek keys for already canonical slots.
    if (!firstUnkeyed && head!.lastSeekOrder !== '0' &&
      (projection === undefined || projection.observationDigest === head!.digest)) {
      return {
        phase: 'done', cursorDigest: null, cursorOrder: null, allocated: head!.lastSeekOrder,
        processed: '0', nativeMax: head!.lastOrder, headDigest: head!.digest,
        headTransaction: current.transactionId, projectionTransaction: projection?.transactionId ?? null,
        projectionDigest: projection?.observationDigest ?? null, adoptedDigest: null, materialized: false,
      };
    }
  }
  const lastSeek = (await client.query<{ seekOrder: string }>(
    `SELECT seek_order::text AS "seekOrder" FROM rating.source_statistic_observation
     WHERE route=$1 AND subject_id=$2 AND source=$3 AND seek_order IS NOT NULL
     ORDER BY seek_order DESC LIMIT 1`, key,
  )).rows[0]?.seekOrder ?? '0';
  let allocated = BigInt(lastSeek);
  if (head && BigInt(head.lastSeekOrder) > allocated) allocated = BigInt(head.lastSeekOrder);
  let adoptedDigest: string | null = null;
  let materialized = false;
  if (!head && projection) {
    const adopted = observationFromProjection(projection, key[1], key[2]);
    if (projection.observationDigest !== null && projection.observationDigest !== adopted.digest)
      fail('projection digest differs from its retained facts');
    current = await currentEnvelope(client, key, adopted.digest);
    if (!current) {
      if (allocated === 9_223_372_036_854_775_807n) fail('seek order exhausted');
      allocated++;
      // A positive temporary key also works against the final NOT NULL baseline.
      // This unpublished position is reassigned in the bounded unknown phase.
      await client.query(`
        INSERT INTO rating.source_statistic_observation
          (route,subject_id,source,digest,source_alias,source_record_id,as_of,payload,
           transaction_id,payload_version,local_order,seek_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,NULL,$11)`,
        [...key, adopted.digest, projection.sourceAlias, projection.sourceRecordId, projection.asOf,
          JSON.stringify(adopted.payload), projection.transactionId, SOURCE_OBSERVATION_PAYLOAD_VERSION,
          String(allocated)],
      );
      adoptedDigest = adopted.digest;
      current = await currentEnvelope(client, key, adopted.digest);
    }
    if (!current) invalidated('adopted envelope disappeared');
    verifyEnvelope(current, key[1], key[2]);
    verifyProjection(current, projection, key[1], key[2]);
    head = { digest: adopted.digest, lastOrder: '0', lastSeekOrder: '0' };
    await client.query(`
      INSERT INTO rating.source_statistic_head (route,subject_id,source,digest,last_order,last_seek_order)
      VALUES ($1,$2,$3,$4,0,0)`, [...key, head.digest],
    );
    materialized = true;
  }
  if (!head || !current) {
    const retained = (await client.query(
      `SELECT 1 FROM rating.source_statistic_observation
       WHERE route=$1 AND subject_id=$2 AND source=$3 LIMIT 1`, key,
    )).rows[0];
    if (retained) invalidated('retained observations have no authoritative head');
    return null;
  }
  await client.query(`UPDATE rating.source_statistic_head SET last_seek_order=0
    WHERE route=$1 AND subject_id=$2 AND source=$3`, key);
  const progress: Progress = {
    phase: 'unknown', cursorDigest: null, cursorOrder: null, allocated: String(allocated),
    processed: '0', nativeMax: head.lastOrder, headDigest: head.digest,
    headTransaction: current.transactionId, projectionTransaction: projection?.transactionId ?? null,
    projectionDigest: projection?.observationDigest ?? null, adoptedDigest, materialized,
  };
  await client.query(`
    INSERT INTO rating.source_observation_materialization
      (route,subject_id,source,phase,allocated,processed,native_max,head_digest,head_transaction,
       projection_transaction,projection_digest,adopted_digest,materialized)
    VALUES ($1,$2,$3,'unknown',$4,0,$5,$6,$7,$8,$9,$10,$11)`,
    [...key, progress.allocated, progress.nativeMax, progress.headDigest, progress.headTransaction,
      progress.projectionTransaction, progress.projectionDigest, progress.adoptedDigest, materialized],
  );
  return progress;
}

async function page(client: PoolClient, key: SlotKey, progress: Progress, limit: number) {
  const continued = progress.cursorDigest !== null;
  const unknown = progress.phase === 'unknown';
  // Reserve one candidate for the adopted temporary key; total candidates never
  // exceed the requested step limit, including an adopted candidate deferred below.
  const take = unknown && progress.adoptedDigest !== null ? limit - 1 : limit;
  const parameters: unknown[] = [...key];
  let boundary = '';
  if (continued) {
    if (unknown) {
      boundary = ' AND digest > $4::text';
      parameters.push(progress.cursorDigest);
    } else {
      boundary = ' AND (local_order,digest) > ($4::bigint,$5::text)';
      parameters.push(progress.cursorOrder, progress.cursorDigest);
    }
  }
  parameters.push(take);
  const sql = 'SELECT ' + envelopeColumns + ` FROM rating.source_statistic_observation
    WHERE route=$1 AND subject_id=$2 AND source=$3 AND seek_order IS NULL AND local_order ` +
    (unknown ? 'IS NULL' : 'IS NOT NULL') + boundary +
    (unknown ? ' ORDER BY digest' : ' ORDER BY local_order,digest') +
    ' LIMIT $' + parameters.length;
  const candidates = (await client.query<Envelope>(sql, parameters)).rows;
  let examined = candidates.length;
  if (unknown && progress.adoptedDigest !== null) {
    const adopted = await currentEnvelope(client, key, progress.adoptedDigest);
    examined++;
    if (!adopted) invalidated('adopted envelope disappeared');
    const last = candidates[candidates.length - 1];
    if (candidates.length < take || (last && adopted.digest <= last.digest)) {
      candidates.push(adopted);
      candidates.sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0);
    }
  }
  return { candidates, examined };
}

async function finish(client: PoolClient, key: SlotKey, progress: Progress) {
  const head = await currentHead(client, key);
  const current = await currentEnvelope(client, key, progress.headDigest);
  const projection = await currentProjection(client, key);
  if (!head || head.digest !== progress.headDigest || head.lastSeekOrder !== '0' ||
    !current || current.transactionId !== progress.headTransaction)
    invalidated('original head or retained envelope changed');
  if ((projection?.transactionId ?? null) !== progress.projectionTransaction ||
    (projection?.observationDigest ?? null) !== progress.projectionDigest)
    invalidated('original projection changed');
  verifyEnvelope(current, key[1], key[2]);
  verifyProjection(current, projection, key[1], key[2]);
  if (current.seekOrder === null) invalidated('head was not materialized');
  if (projection && projection.observationDigest === null) {
    await client.query(`UPDATE rating.source_statistic SET observation_digest=$4
      WHERE route=$1 AND subject_id=$2 AND source=$3`, [...key, head.digest]);
  }
  await client.query(`UPDATE rating.source_statistic_head
    SET last_order=GREATEST(last_order,$4),last_seek_order=$5
    WHERE route=$1 AND subject_id=$2 AND source=$3`,
    [...key, progress.nativeMax, progress.allocated],
  );
  const readback = await currentHead(client, key);
  const projected = await currentProjection(client, key);
  if (readback?.digest !== progress.headDigest || readback.lastSeekOrder !== progress.allocated ||
    (projected !== undefined && projected.observationDigest !== progress.headDigest))
    fail('head or projection readback differs');
  progress.phase = 'done';
  progress.cursorDigest = null;
  progress.cursorOrder = null;
}

/** One explicit, resumable maintenance step. The caller schedules further steps
 * from the returned durable cursor; there is no history-size cap or internal loop.
 * Runtime access stays gated by last_seek_order=0 until final readback succeeds.
 */
export async function materializeSourceObservations(pool: Pool, input: MaintenanceInput) {
  const limit = input.limit ?? MAX_OBSERVATIONS;
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > MAX_OBSERVATIONS)
    fail('step limit must be between 2 and 256');
  const key: SlotKey = [input.route, input.subjectId, input.source];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subject = await client.query(
      'SELECT 1 FROM semantic.subject WHERE route=$1 AND subject_id=$2 FOR UPDATE', key.slice(0, 2),
    );
    if (subject.rowCount !== 1) invalidated('subject no longer exists');
    let progress: Progress | undefined = (await client.query<Progress>(
      'SELECT ' + progressColumns + ` FROM rating.source_observation_materialization
       WHERE route=$1 AND subject_id=$2 AND source=$3 FOR UPDATE`, key,
    )).rows[0];
    if (progress?.phase === 'done') {
      await client.query(`DELETE FROM rating.source_observation_materialization
        WHERE route=$1 AND subject_id=$2 AND source=$3`, key);
      progress = undefined;
    }
    progress ??= await start(client, key) ?? undefined;
    if (!progress || progress.phase === 'done') {
      await client.query('COMMIT');
      return result(progress ?? null, 0);
    }
    const head = await currentHead(client, key);
    if (!head || head.digest !== progress.headDigest || head.lastSeekOrder !== '0')
      invalidated('original head changed');
    const selected = await page(client, key, progress, limit);
    for (const row of selected.candidates) verifyEnvelope(row, input.subjectId, input.source);
    for (const row of selected.candidates) {
      const allocated = BigInt(progress.allocated) + 1n;
      if (allocated > 9_223_372_036_854_775_807n) fail('seek order exhausted');
      const updated = await client.query(`UPDATE rating.source_statistic_observation SET seek_order=$5
        WHERE route=$1 AND subject_id=$2 AND source=$3 AND digest=$4
          AND seek_order IS NOT DISTINCT FROM $6::bigint`,
        [...key, row.digest, String(allocated), row.seekOrder],
      );
      if (updated.rowCount !== 1) invalidated('selected envelope disappeared');
      const readback = await currentEnvelope(client, key, row.digest);
      if (!readback || canonicalize(readback) !== canonicalize({ ...row,seekOrder: String(allocated) }))
        fail('observation readback differs');
      progress.allocated = String(allocated);
      progress.processed = String(BigInt(progress.processed) + 1n);
      if (row.nativeOrder !== null && BigInt(row.nativeOrder) > BigInt(progress.nativeMax))
        progress.nativeMax = row.nativeOrder;
      progress.cursorDigest = row.digest;
      progress.cursorOrder = row.nativeOrder;
      if (row.digest === progress.adoptedDigest) progress.adoptedDigest = null;
    }
    if (selected.candidates.length === 0) {
      if (progress.phase === 'unknown') {
        progress.phase = 'native';
        progress.cursorDigest = null;
        progress.cursorOrder = null;
      } else await finish(client, key, progress);
    }
    await client.query(`UPDATE rating.source_observation_materialization
      SET phase=$4,cursor_digest=$5,cursor_order=$6,allocated=$7,processed=$8,native_max=$9,adopted_digest=$10
      WHERE route=$1 AND subject_id=$2 AND source=$3`,
      [...key, progress.phase, progress.cursorDigest, progress.cursorOrder, progress.allocated,
        progress.processed, progress.nativeMax, progress.adoptedDigest],
    );
    await client.query('COMMIT');
    return result(progress, selected.examined);
  } catch (error) {
    if (error instanceof InvalidatedMaterialization) {
      await client.query(`DELETE FROM rating.source_observation_materialization
        WHERE route=$1 AND subject_id=$2 AND source=$3`, key);
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Operator reset discards only an obsolete operational cursor. It never restores
 * erased heads, observations or projection facts, and never marks a slot ready.
 */
export async function resetSourceObservationMaterialization(pool: Pool, input: MaintenanceInput) {
  await pool.query(`DELETE FROM rating.source_observation_materialization
    WHERE route=$1 AND subject_id=$2 AND source=$3`, [input.route,input.subjectId,input.source]);
}
