SELECT route,collection_id::text,plan_key,source_identity,job_id::text,job_epoch::text,scope,
 generation::text,capture_id::text,capture_frontier,collection_fence::text,account_fence::text,
 job_transaction_id::text,scope_digest,job_writer_fence,phase,driver,after_subject::text,after_fact::text,
 version::text,state,old_head::text,old_state,seal_transaction_id::text,frontier
FROM library.identity_scope_plan
WHERE route=$1 AND collection_id=$2 AND plan_key=$3;
