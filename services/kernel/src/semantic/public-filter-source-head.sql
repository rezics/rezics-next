SELECT position::text, owner_epoch, population_fenced
FROM semantic.public_filter_privacy_head
WHERE partition_no = :partition_no::integer;
