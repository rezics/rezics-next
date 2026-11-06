WITH input AS (
  SELECT $1::integer AS partition_no, $2::uuid AS transaction_id, $3::uuid AS job_id,
         $4::bigint AS job_epoch, $5::text AS scope_digest, $6::jsonb AS frontier, $7::jsonb AS work
)
INSERT INTO semantic.identity_epoch_step
 (partition_no,transaction_id,native_epoch,native_position,job_id,job_epoch,step,version,scope_digest,frontier,state,work)
SELECT c.partition_no,c.transaction_id,c.epoch,c.position,input.job_id,input.job_epoch,
       'search-canonical-index',1,input.scope_digest,input.frontier,'complete',input.work
FROM semantic.identity_epoch_native_commit c, input
WHERE c.partition_no=input.partition_no AND c.transaction_id=input.transaction_id
 AND c.purpose='search-canonical-index'
 AND NOT EXISTS (SELECT 1 FROM search.identity_receiving_native_scope_pending q
  WHERE q.partition_no=input.partition_no AND q.job_id=input.job_id AND q.job_epoch=input.job_epoch)
RETURNING transaction_id;
