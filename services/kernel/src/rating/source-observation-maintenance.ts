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
const TRANSITION_SEEK_ORDER = '9223372036854775807';
type Envelope = {
  digest: string;
  payload: SourceObservation;
  payloadVersion: number;
  sourceAlias: string;
  sourceRecordId: string;
  asOf: string;
  nativeOrder: string | null;
  seekOrder: string | null;
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

async function envelopes(client: PoolClient, key: readonly [number, string, SourceProvider], limit: number) {
  const rows = (
    await client.query<Envelope>(
      `SELECT digest, payload, payload_version AS "payloadVersion", source_alias AS "sourceAlias",
              source_record_id AS "sourceRecordId", as_of::text AS "asOf",
              local_order::text AS "nativeOrder", seek_order::text AS "seekOrder"
       FROM rating.source_statistic_observation
       WHERE route=$1 AND subject_id=$2 AND source=$3
       ORDER BY digest ASC LIMIT $4`,
      [...key, limit + 1],
    )
  ).rows;
  // Read through the primary-key prefix before sorting at most one bounded slot.
  return rows.sort((left, right) => {
    if (left.nativeOrder === null && right.nativeOrder !== null) return -1;
    if (left.nativeOrder !== null && right.nativeOrder === null) return 1;
    if (left.nativeOrder !== null && right.nativeOrder !== null && left.nativeOrder !== right.nativeOrder)
      return BigInt(left.nativeOrder) < BigInt(right.nativeOrder) ? -1 : 1;
    return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
  });
}

/** Offline, explicit transition for one bounded subject/provider slot. Run between
 * adding nullable seek_order and enforcing its final NOT NULL constraint. Runtime
 * readers and writers never invoke this conversion. Existing transaction identities
 * and unknown native chronology survive without inventing commands or revisions.
 */
export async function materializeSourceObservations(
  pool: Pool,
  input: Readonly<{ route: number; subjectId: string; source: SourceProvider; limit?: number }>,
) {
  const limit = input.limit ?? MAX_OBSERVATIONS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OBSERVATIONS) fail('invalid observation limit');
  const key: [number, string, SourceProvider] = [input.route, input.subjectId, input.source];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subject = await client.query(
      'SELECT 1 FROM semantic.subject WHERE route=$1 AND subject_id=$2 FOR UPDATE',
      key.slice(0, 2),
    );
    if (subject.rowCount !== 1) fail('subject not found');
    let rows = await envelopes(client, key, limit);
    if (rows.length > limit) fail('observation limit exceeded; no rows converted');
    for (const row of rows) verifyEnvelope(row, input.subjectId, input.source);
    let initializeTraversal = rows.some((row) => row.seekOrder === null);
    if (initializeTraversal && rows.some((row) => row.seekOrder !== null))
      fail('slot traversal only partially initialized');
    const head = (
      await client.query<Head>(
        `SELECT digest, last_order::text AS "lastOrder", last_seek_order::text AS "lastSeekOrder"
         FROM rating.source_statistic_head WHERE route=$1 AND subject_id=$2 AND source=$3`,
        key,
      )
    ).rows[0];
    const projection = await currentProjection(client, key);
    let headDigest = head?.digest;
    let adopted: ReturnType<typeof sourceObservation> | undefined;
    if (!head && projection) {
      adopted = observationFromProjection(projection, input.subjectId, input.source);
      if (projection.observationDigest !== null && projection.observationDigest !== adopted.digest)
        fail('projection digest differs from its retained facts');
      headDigest = adopted.digest;
      if (!rows.some((row) => row.digest === adopted!.digest)) {
        if (rows.length === limit) fail('observation limit exceeded; no rows converted');
        // A populated traversal is already in service. Do not insert an unknown
        // historical position into that traversal during a later maintenance run.
        if (rows.some((row) => row.seekOrder !== null)) fail('slot traversal already initialized');
        initializeTraversal = true;
        await client.query(
          `INSERT INTO rating.source_statistic_observation
             (route, subject_id, source, digest, source_alias, source_record_id, as_of, payload,
              transaction_id, payload_version, local_order, seek_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,NULL,$11)`,
          [...key, adopted.digest, projection.sourceAlias, projection.sourceRecordId, projection.asOf,
            JSON.stringify(adopted.payload), projection.transactionId, SOURCE_OBSERVATION_PAYLOAD_VERSION,
            TRANSITION_SEEK_ORDER],
        );
        rows = await envelopes(client, key, limit);
      }
    }
    if (headDigest !== undefined && !rows.some((row) => row.digest === headDigest)) fail('head has no retained envelope');
    if (projection && headDigest !== undefined) {
      const current = rows.find((row) => row.digest === headDigest)!;
      const projected = observationFromProjection(projection, input.subjectId, input.source);
      if (current.payload.count === 0 || projected.digest !== headDigest ||
        canonicalize(projected.payload) !== canonicalize(current.payload))
        fail('projection facts differ from its authoritative envelope');
      if (projection.observationDigest !== null && projection.observationDigest !== headDigest)
        fail('projection digest differs from its authoritative head');
    }
    if (initializeTraversal) {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const seekOrder = String(index + 1);
        const updated = await client.query(
          `UPDATE rating.source_statistic_observation SET seek_order=$5
           WHERE route=$1 AND subject_id=$2 AND source=$3 AND digest=$4
             AND seek_order IS NOT DISTINCT FROM $6::bigint`,
          [...key, row.digest, seekOrder, row.seekOrder],
        );
        if (updated.rowCount !== 1) fail('observation changed during materialization');
        row.seekOrder = seekOrder;
      }
    }
    const lastOrder = rows.reduce((last, row) => row.nativeOrder !== null && BigInt(row.nativeOrder) > last
      ? BigInt(row.nativeOrder) : last, BigInt(head?.lastOrder ?? '0'));
    const lastSeekOrder = rows.reduce((last, row) => BigInt(row.seekOrder!) > last
      ? BigInt(row.seekOrder!) : last, BigInt(head?.lastSeekOrder ?? '0'));
    if (headDigest !== undefined) {
      await client.query(
        `INSERT INTO rating.source_statistic_head (route, subject_id, source, digest, last_order, last_seek_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (route,subject_id,source) DO UPDATE
         SET last_order=EXCLUDED.last_order, last_seek_order=EXCLUDED.last_seek_order`,
        [...key, headDigest, String(lastOrder), String(lastSeekOrder)],
      );
      if (projection && (adopted !== undefined || projection.observationDigest === null)) await client.query(
        `UPDATE rating.source_statistic SET observation_digest=$4
         WHERE route=$1 AND subject_id=$2 AND source=$3`,
        [...key, headDigest],
      );
    } else if (rows.length) fail('retained observations have no authoritative head');

    const stored = await envelopes(client, key, limit);
    if (canonicalize(stored) !== canonicalize(rows)) fail('observation readback differs');
    for (const row of stored) verifyEnvelope(row, input.subjectId, input.source);
    if (headDigest !== undefined) {
      const readback = (
        await client.query<Head>(
          `SELECT digest, last_order::text AS "lastOrder", last_seek_order::text AS "lastSeekOrder"
           FROM rating.source_statistic_head WHERE route=$1 AND subject_id=$2 AND source=$3`, key,
        )
      ).rows[0];
      if (readback?.digest !== headDigest || readback.lastOrder !== String(lastOrder) ||
        readback.lastSeekOrder !== String(lastSeekOrder)) fail('head readback differs');
      const current = stored.find((row) => row.digest === headDigest)!;
      const projectionReadback = await currentProjection(client, key);
      if (current.payload.count === 0) {
        if (projectionReadback !== undefined) fail('cleared head retains a projection');
      } else {
        if (projectionReadback === undefined || projectionReadback.observationDigest !== headDigest)
          fail('projection disagrees with its authoritative head');
        const projected = observationFromProjection(projectionReadback, input.subjectId, input.source);
        if (projected.digest !== headDigest || canonicalize(projected.payload) !== canonicalize(current.payload))
          fail('projection facts differ from its authoritative envelope');
      }
    }
    await client.query('COMMIT');
    return { observations: stored.length, materialized: adopted !== undefined, head: headDigest ?? null };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
