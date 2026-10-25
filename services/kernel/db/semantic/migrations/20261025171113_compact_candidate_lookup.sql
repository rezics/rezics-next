-- migrate:up
CREATE INDEX fact_compact_candidate
  ON semantic.fact (route, subject_id, statement_id, log_seq DESC)
  WHERE kind = 'statement' AND operation = 'assert' AND statement_id IS NOT NULL;

-- migrate:down
DROP INDEX semantic.fact_compact_candidate;
