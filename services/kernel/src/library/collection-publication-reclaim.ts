import type { Pool } from 'pg';
import { noEffect, runCommand, withSingleCommandAttempt, type CommandTransaction } from '../command/command.ts';
import commandTime from '../command/time.sql';
import commandFence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import { ProblemError } from '../http/problem-error.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { instrumentNativeCollectionWork, NativeCollectionWork } from './collection-native-work.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import type { CollectionOutputRef } from './collection-source-output.ts';
import reclaimSQL from './collection-publication-reclaim.sql';

const pages = [
  `WITH keys AS (
    SELECT subject_id FROM library.collection_publication_staging_evidence
    WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id LIMIT 100
  )
  DELETE FROM library.collection_publication_staging_evidence e USING keys k
  WHERE e.route=$1 AND e.collection_id=$2 AND e.generation=$3 AND e.subject_id=k.subject_id`,
  `WITH keys AS (
    SELECT subject_id FROM library.collection_source_output_member
    WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id LIMIT 100
  )
  DELETE FROM library.collection_source_output_member m USING keys k
  WHERE m.route=$1 AND m.collection_id=$2 AND m.generation=$3 AND m.subject_id=k.subject_id`,
] as const;

const points = [
  'DELETE FROM library.collection_publication_staging_seal WHERE route=$1 AND collection_id=$2 AND generation=$3',
  'DELETE FROM library.collection_publication_staging WHERE route=$1 AND collection_id=$2 AND generation=$3',
  'DELETE FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2 AND generation=$3',
  'DELETE FROM library.collection_source_output_publication WHERE route=$1 AND collection_id=$2 AND generation=$3',
  'DELETE FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 AND generation=$3',
] as const;

const plans = new Map<string, [rows: number, points: number, statements: number]>([
  [reclaimSQL.sql, [160, 20, 1]],
  // Each deleted raw key pays its member/staging guards, counter update and their native FK/hold probes.
  [pages[0], [3200, 1200, 801]],
  [pages[1], [3200, 1200, 801]],
  ...points.map((sql): [string, [number, number, number]] => [sql, [64, 16, 8]]),
  [commandTime.sql, [8, 1, 1]],
  [commandFence.sql, [40, 5, 1]],
  [noEffectFence.sql, [8, 1, 1]],
]);

function footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const plan = plans.get(sql);
  const control =
    sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
    sql === 'COMMIT' ||
    sql === 'ROLLBACK' ||
    sql === "SET LOCAL lock_timeout = '200ms'" ||
    /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(sql);
  if (!plan && !control) return undefined;
  const [nativeRows, nativePoints, statements] = plan ?? [0, 0, 1];
  const page = sql === pages[0] || sql === pages[1];
  return {
    candidateKeys: page ? 100 : 0,
    nativeRows,
    nativePoints,
    identityMetadataRows: sql === reclaimSQL.sql ? 13 : 0,
    emptySeeks: nativePoints,
    witnessKeys: 0,
    statements,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + 256,
  };
}

async function removePage(tx: CommandTransaction, key: readonly [number, string, string]) {
  for (const page of pages) {
    const count = (await tx.query(page, [...key])).rowCount ?? 0;
    if (count) return count;
  }
  for (const sql of points.slice(0, -1)) await tx.query(sql, [...key]);
  const header = await tx.query(points[4], [...key]);
  if (header.rowCount !== 1) throw new ProblemError('dependency_unavailable');
  return header.rowCount;
}

/** Deletes one raw child page or the empty generation. Immutable disposition remains available for replay. */
export async function reclaimSupersededCollectionOutput(pool: Pool, ref: CollectionOutputRef, deadline: number) {
  if (routeOf(ref.collectionId) !== ref.route) throw new TypeError('Invalid Collection output route');
  const key = [ref.route, ref.collectionId, ref.generation] as const;
  const work = new NativeCollectionWork(
    {
      reservationId: ref.generation,
      // Two bounded raw seeks, the fixed child/header tail, and the single native attempt including rollback.
      remaining: {
        candidateKeys: 200,
        nativeRows: 7040,
        nativePoints: 2600,
        identityMetadataRows: 13,
        emptySeeks: 2600,
        witnessKeys: 0,
        statements: 1660,
        bytes: 32 * 1024,
      },
    },
    deadline,
  );
  const result = await instrumentNativeCollectionWork(pool, work, footprint, () =>
    withSingleCommandAttempt(() =>
      runCommand(pool, { partition: partitionOf(ref.route), deadline }, async (tx) => {
        if ((await tx.query(reclaimSQL.sql, [...key])).rowCount !== 1) return noEffect(0);
        const count = await removePage(tx, key);
        return {
          value: count,
          events: [
            {
              type: 'com.rezics.library.collection.output.reclaimed.v1',
              subject: ref.collectionId,
              data: { collectionId: ref.collectionId, generation: ref.generation, removed: count },
            },
          ],
        };
      }),
    ),
  );
  return result.value;
}
