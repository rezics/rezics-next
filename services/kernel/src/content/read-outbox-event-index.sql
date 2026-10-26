SELECT event_seq, event_count FROM core.outbox
WHERE partition_no = :partition_no::integer AND position = :position::bigint AND epoch = :epoch::integer
  AND id = :id::uuid AND type = :type::text
  AND subject IS NOT DISTINCT FROM :subject::nullable(text) AND data = :data::jsonb;
