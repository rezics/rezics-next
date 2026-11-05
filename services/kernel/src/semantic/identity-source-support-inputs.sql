SELECT terminal::text, generation::text, basis_version::text, original_count::text,
       control_partition, owner_epoch
FROM semantic.identity_epoch_input
WHERE partition_no=$1 AND job_id=$2
ORDER BY terminal LIMIT 2;
