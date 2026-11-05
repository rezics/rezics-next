-- migrate:up
CREATE INDEX fact_current_relation_key_seek
  ON semantic.fact (route, subject_id, slot_id, statement_id, log_seq DESC)
  INCLUDE (operation, property, relation)
  WHERE statement_id IS NOT NULL;

-- migrate:down
DROP INDEX semantic.fact_current_relation_key_seek;
