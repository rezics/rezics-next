-- migrate:up
CREATE INDEX fact_subject_slot_order ON semantic.fact (route, subject_id, slot_id, log_seq);

-- migrate:down
DROP INDEX semantic.fact_subject_slot_order;
