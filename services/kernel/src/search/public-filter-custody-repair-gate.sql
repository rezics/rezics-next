SELECT consumer,incarnation,owner_epoch,write_alias,closed_token,enrollment_generation,fence_generation
FROM search.identity_writer_gate
WHERE partition_no=:partition_no::integer AND physical_target=:physical_target::text FOR SHARE;
