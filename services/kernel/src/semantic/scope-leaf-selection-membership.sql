-- This is a bounded same-slot membership test, not a candidate range/refill.
-- The native <=32 selection shape bounds JSON work, independently of history.
SELECT CASE WHEN mode = 'replace' THEN
  jsonb_path_query_first(selection, '$[*] ? (@.candidate == $candidate)',
    jsonb_build_object('candidate', :candidate_id::text))
END AS selected
FROM semantic.adoption
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid
  AND context_id = '00000000-0000-8000-8000-000000000000'
ORDER BY head DESC LIMIT 1;
