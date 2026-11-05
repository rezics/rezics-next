SELECT b.job_id,b.terminal::text,b.owner_epoch,b.basis_version::text,s.closed_job
FROM semantic.identity_epoch_prearm_bridge b
JOIN semantic.identity_scope_bridge s USING(partition_no,generation)
WHERE b.partition_no=$1 AND b.generation=$2 FOR UPDATE OF b,s;
