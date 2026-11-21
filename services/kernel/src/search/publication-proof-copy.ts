import { encode, decode, tree } from './public-filter-codec.ts';

/** Empty the original generation proof payload only after its actual readers release.
 * Its immutable Source/dispatch metadata remains available for completion replay.
 */
export async function drainGenerationPublicationProofCopy(
  tx: Pick<import('pg').PoolClient, 'query'>,
  partition: number,
  physicalTarget: string,
  job: string,
  drained?: (registration: string, observation: string) => void,
): Promise<boolean> {
  if (partition !== 0) return false;
  const retained = await tx.query<{
    observation: string;
    registration: string;
    bootstrap: string;
    consumer_work: string;
  }>(
    `SELECT o.observation,o.registration,b.bootstrap::text,o.consumer_work
     FROM semantic.public_filter_bootstrap b
     JOIN search.public_filter_observation o
       ON (o.partition_no,o.consumer_bootstrap,o.observation)=(0,'0:'||b.bootstrap::text,b.publication_observation)
     JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
     WHERE (b.partition_no,b.publication_job)=(0,$1::uuid) AND r.physical_target=$2
       AND b.publication_execution IS NOT NULL AND o.state='open'
       AND NOT EXISTS (SELECT 1 FROM search.public_filter_reference f
         WHERE (f.partition_no,f.observation)=(0,o.observation) AND f.expires_at>$3)
     FOR UPDATE OF o`,
    [job, physicalTarget, Date.now()],
  );
  if (!retained.rowCount) return false;
  const row = retained.rows[0]!;
  const work = decode<Record<string, unknown>>(row.consumer_work);
  const { prepared: _prepared, preparedRows: _preparedRows, ...boundedWork } = work;
  const proofWork = JSON.stringify(tree({ ...boundedWork, after: undefined }, 'value'));
  await tx.query(
    `UPDATE search.public_filter_prepared SET state='erasing',
       segment_state=CASE WHEN segment_state='legacy' THEN 'legacy' ELSE 'erasing' END
     WHERE partition_no=0 AND registration=$1 AND build=$2`,
    [row.registration, '0:' + row.bootstrap],
  );
  const segments = await tx.query(
    `WITH candidate AS MATERIALIZED (
       SELECT partition_no,registration,build,generation,raw_ordinal
       FROM search.public_filter_preparation_segment
       WHERE partition_no=0 AND registration=$1 AND build=$2
       ORDER BY generation,raw_ordinal LIMIT 100
     ) DELETE FROM search.public_filter_preparation_segment s USING candidate c
       WHERE (s.partition_no,s.registration,s.build,s.generation,s.raw_ordinal)=
             (c.partition_no,c.registration,c.build,c.generation,c.raw_ordinal)
       RETURNING s.raw_ordinal`,
    [row.registration, '0:' + row.bootstrap],
  );
  if (segments.rowCount) return true;
  const prepared = await tx.query(
    `UPDATE search.public_filter_prepared SET rows=$3,state='erasing',raw_count=0,output_count=0,
       raw_exhausted=false,source_cursor=NULL
     WHERE partition_no=0 AND registration=$1 AND build=$2 AND
       (state<>'erasing' OR rows<>$3 OR raw_count<>0 OR output_count<>0 OR raw_exhausted OR source_cursor IS NOT NULL
         OR segment_state NOT IN ('legacy','erasing'))`,
    [row.registration, '0:' + row.bootstrap, encode([])],
  );
  const observation = await tx.query(
    `UPDATE search.public_filter_observation SET prepared_rows=$2,consumer_work=$3
     WHERE partition_no=0 AND observation=$1
       AND (prepared_rows IS DISTINCT FROM $2 OR consumer_work IS DISTINCT FROM $3)`,
    [row.observation, encode([]), proofWork],
  );
  if (prepared.rowCount || observation.rowCount) return true;
  drained?.(row.registration, row.observation);
  return false;
}

/** A failed private materialization can leave a closed PIT receipt after its Source
 * abort has removed the registration's work. The held publication registration
 * may release one physical receipt or its childless observation per turn. */
export async function drainReleasedPublicationPit(
  tx: Pick<import('pg').PoolClient, 'query'>,
  registration: string,
  protectedObservation: string,
  now: number,
  limit: number,
): Promise<{ changed: boolean; examined: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new RangeError('Invalid released PIT window');
  const result = await tx.query<{ changed: boolean; examined: number }>(
    `WITH roots AS MATERIALIZED (
       SELECT o.partition_no,o.observation FROM search.public_filter_observation o
       WHERE o.partition_no=0 AND o.registration=$1 AND o.observation<>$2 AND EXISTS (
         SELECT FROM search.public_filter_registration r WHERE (r.partition_no,r.id)=(0,$1)
           AND r.state='active' AND r.consumer_bootstrap IS NULL AND r.consumer_work IS NULL FOR SHARE OF r
       ) ORDER BY o.observation LIMIT $4
     ), candidate AS MATERIALIZED (
       SELECT o.partition_no,o.observation FROM roots
       JOIN search.public_filter_observation o USING(partition_no,observation)
       WHERE o.state='closed' AND o.expires_at<=$3 AND o.consumer_work IS NULL
         AND o.consumer_bootstrap IS NULL AND o.prepared_rows IS NULL AND o.prepared_build IS NULL
         AND o.observation ~ '^0:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
         AND NOT EXISTS (SELECT FROM search.public_filter_reference f
           WHERE (f.partition_no,f.observation)=(o.partition_no,o.observation))
         AND NOT EXISTS (SELECT FROM search.public_filter_execution e
           WHERE (e.partition_no,e.observation)=(o.partition_no,o.observation))
         AND NOT EXISTS (SELECT FROM search.public_filter_coverage_page p
           WHERE (p.partition_no,p.observation)=(o.partition_no,o.observation))
         AND NOT EXISTS (SELECT FROM semantic.public_filter_population_start s
           WHERE (s.partition_no,s.observation)=(o.partition_no,o.observation))
         AND NOT EXISTS (SELECT FROM semantic.public_filter_bootstrap b WHERE b.partition_no=0
           AND (b.queried COLLATE "C"=o.observation OR b.publication_observation COLLATE "C"=o.observation))
         AND NOT EXISTS (SELECT FROM search.public_filter_pit_claim c WHERE c.partition_no=0 AND c.registration=$1
           AND c.bootstrap=substring(o.observation FROM '^0:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$')::uuid)
         AND NOT EXISTS (SELECT FROM search.public_filter_pit p
           WHERE (p.partition_no,p.observation)=(o.partition_no,o.observation) AND p.state='owned')
       ORDER BY o.observation LIMIT 1 FOR UPDATE OF o
     ), receipt AS MATERIALIZED (
       SELECT p.partition_no,p.observation,p.id FROM search.public_filter_pit p
       JOIN candidate c USING(partition_no,observation) WHERE p.state='released' ORDER BY p.id LIMIT 1 FOR UPDATE OF p
     ), released AS (
       DELETE FROM search.public_filter_pit p USING receipt r
       WHERE (p.partition_no,p.observation,p.id)=(r.partition_no,r.observation,r.id) RETURNING p.id
     ), retired AS (
       DELETE FROM search.public_filter_observation o USING candidate c
       WHERE (o.partition_no,o.observation)=(c.partition_no,c.observation) AND NOT EXISTS (SELECT FROM receipt)
       RETURNING o.observation
     ) SELECT EXISTS (SELECT FROM released) OR EXISTS (SELECT FROM retired) AS changed,
              (SELECT count(*)::integer FROM roots) AS examined`,
    [registration, protectedObservation, now, limit],
  );
  return result.rows[0]!;
}

/** Every other observation, prepared payload and original reader must drain normally. */
export async function hasRetainedWriterPublicationCopies(
  tx: Pick<import('pg').PoolClient, 'query'>,
  partition: number,
  physicalTarget: string,
  publicationJob: string | null = null,
): Promise<boolean> {
  const retained = await tx.query(
    `SELECT 1 FROM search.public_filter_observation o
    JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
    WHERE r.partition_no=$1 AND r.physical_target=$2 AND (
      o.prepared_rows=$3 AND o.consumer_work::jsonb->>0='object'
      AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(o.consumer_work::jsonb->1) entry
        WHERE entry->>0 IN ('prepared','preparedRows')
          OR (entry->>0='after' AND entry->1<>'["undefined"]'::jsonb)
      ) AND EXISTS (
        SELECT 1 FROM semantic.public_filter_bootstrap b
        WHERE (b.partition_no,b.publication_job)=(0,$4::uuid)
          AND (o.partition_no,o.observation,o.consumer_bootstrap)=(0,b.publication_observation,'0:'||b.bootstrap::text)
      ) AND NOT EXISTS (SELECT 1 FROM search.public_filter_reference f
        WHERE (f.partition_no,f.observation)=(o.partition_no,o.observation) AND f.expires_at>$5)) IS NOT TRUE
    UNION ALL
    SELECT 1 FROM search.public_filter_prepared p
    JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(p.partition_no,p.registration)
    WHERE r.partition_no=$1 AND r.physical_target=$2 AND
      (p.state<>'erasing' OR p.rows<>$3 OR p.raw_count<>0 OR p.output_count<>0 OR p.raw_exhausted
       OR p.source_cursor IS NOT NULL OR p.segment_state NOT IN ('legacy','erasing') OR EXISTS (
      SELECT 1 FROM search.public_filter_preparation_segment s
      WHERE (s.partition_no,s.registration,s.build,s.generation)=
        (p.partition_no,p.registration,p.build,p.generation)
    ))
    LIMIT 1`,
    [partition, physicalTarget, encode([]), publicationJob, Date.now()],
  );
  return retained.rowCount !== 0;
}

/** The held fence prevents new occupied homes. Seek both target-leading indexes once per distinct home. */
export async function nextWriterPublicationHomes(
  tx: Pick<import('pg').PoolClient, 'query'>,
  from: number,
  physicalTarget: string,
  limit: number,
): Promise<number[]> {
  const result = await tx.query<{ home: number }>(
    `WITH RECURSIVE occupied(home, ordinal) AS (
       VALUES ($2::integer - 1, 0)
       UNION ALL
       SELECT LEAST(
         COALESCE((SELECT partition_no FROM search.identity_writer
           WHERE physical_target=$1 AND partition_no > prior.home ORDER BY partition_no LIMIT 1),4096),
         COALESCE((SELECT partition_no FROM search.public_filter_target
           WHERE physical_target=$1 AND partition_no > prior.home ORDER BY partition_no LIMIT 1),4096)
       ), prior.ordinal + 1
       FROM occupied prior WHERE prior.ordinal < $3 AND prior.home < 4096
     ) SELECT home FROM occupied WHERE ordinal > 0 ORDER BY ordinal`,
    [physicalTarget, from, limit],
  );
  return result.rows.map(({ home }) => home);
}
