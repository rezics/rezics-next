-- Exact current compact assertion metadata, independent of unrelated candidate/slot history.
SELECT operation FROM semantic.fact
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND statement_id = :candidate_id::uuid AND statement_id IS NOT NULL AND kind = 'statement'
ORDER BY log_seq DESC LIMIT 1;
