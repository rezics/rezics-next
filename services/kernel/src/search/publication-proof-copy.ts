import { encode, decode, tree } from './public-filter-codec.ts';

/** Empty the original generation proof payload only after its actual readers release.
 * Its immutable Source/dispatch metadata remains available for completion replay.
 */
export async function drainGenerationPublicationProofCopy(
  tx: Pick<import('pg').PoolClient, 'query'>,
  partition: number,
  physicalTarget: string,
  job: string,
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
  return !!(prepared.rowCount || observation.rowCount);
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
    WHERE r.partition_no=$1 AND r.physical_target=$2 AND NOT (
      o.prepared_rows=$3 AND EXISTS (
        SELECT 1 FROM semantic.public_filter_bootstrap b
        WHERE (b.partition_no,b.publication_job)=(0,$4::uuid)
          AND (o.partition_no,o.observation,o.consumer_bootstrap)=(0,b.publication_observation,'0:'||b.bootstrap::text)
      ) AND NOT EXISTS (SELECT 1 FROM search.public_filter_reference f
        WHERE (f.partition_no,f.observation)=(o.partition_no,o.observation) AND f.expires_at>$5))
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
