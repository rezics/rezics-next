WITH created AS (
  INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id, current_facts, current_release)
  VALUES (:route::integer, :subject_id::uuid, :type::text, :transaction_id::uuid,
          :current_facts::integer, :current_release::text)
  RETURNING route, subject_id
)
-- A Subject born after generation repair needs its own privacy position on its first public read.
-- Use the same locked Source head as repair, preserving any reduction already recorded for this ID.
INSERT INTO semantic.public_filter_privacy_subject (partition_no, route, subject_id, owner_epoch, position)
SELECT h.partition_no, s.route, s.subject_id, h.owner_epoch, h.position
FROM created s
JOIN semantic.public_filter_privacy_head h ON h.partition_no = s.route / 16
JOIN core.partition p ON p.partition_no = h.partition_no AND p.epoch = h.owner_epoch
WHERE p.write_state = 'active' AND NOT h.population_fenced
FOR UPDATE OF h
ON CONFLICT (partition_no, subject_id) DO NOTHING;
