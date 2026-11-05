SELECT h.position::text
FROM semantic.public_filter_privacy_head h
JOIN core.partition p ON p.partition_no = h.partition_no
WHERE h.partition_no = :partition_no::integer AND p.epoch = :owner_epoch::integer
  AND p.write_state = 'active';
