-- A raw key window precedes all current/selected/visibility filtering.
SELECT log_seq::text AS after, statement_id::text AS candidate_id, slot_id::text AS slot_id
FROM semantic.fact
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid
  AND log_seq > :after::bigint
ORDER BY log_seq LIMIT 1;
