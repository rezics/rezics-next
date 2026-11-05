SELECT h.position::text, p.epoch, p.write_state
FROM semantic.public_filter_privacy_head h
JOIN core.partition p ON p.partition_no = h.partition_no
WHERE h.partition_no = :partition_no::integer;
