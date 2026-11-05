-- migrate:up
CREATE INDEX fact_statement_identity ON semantic.fact (route, subject_id, statement_id, log_seq DESC)
WHERE kind = 'statement' AND statement_id IS NOT NULL;

-- migrate:down
DROP INDEX semantic.fact_statement_identity;
