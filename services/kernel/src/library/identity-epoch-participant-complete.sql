WITH input AS (
  SELECT $1::integer AS partition_no, $2::uuid AS transaction_id, $3::uuid AS job_id,
         $4::bigint AS job_epoch, $5::text AS scope_digest, $6::jsonb AS frontier, $7::jsonb AS work
)
INSERT INTO semantic.identity_epoch_step
 (partition_no,transaction_id,native_epoch,native_position,job_id,job_epoch,step,version,scope_digest,frontier,state,work)
SELECT c.partition_no,c.transaction_id,c.epoch,c.position,input.job_id,input.job_epoch,
       'library-private-follow-counts',1,input.scope_digest,input.frontier,'complete',input.work
FROM semantic.identity_epoch_native_commit c, input
WHERE c.partition_no=input.partition_no AND c.transaction_id=input.transaction_id
 AND c.purpose='library-private-follow-counts'
 AND NOT EXISTS (
   SELECT 1 FROM library.identity_scope_plan p
   WHERE p.route BETWEEN input.partition_no * 16 AND input.partition_no * 16 + 15
     AND p.job_id=input.job_id AND p.job_epoch=input.job_epoch AND p.state='building')
 AND NOT EXISTS (
   SELECT 1 FROM library.identity_epoch_participant_work w
   WHERE w.partition_no=input.partition_no AND w.job_id=input.job_id AND w.job_epoch=input.job_epoch
     AND NOT w.custodied AND NOT w.handed_off)
RETURNING transaction_id;
