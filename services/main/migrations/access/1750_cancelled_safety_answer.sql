-- Cancelled answers retain their immutable decisions and confirmed receipts.
-- Case/step locks and generation CAS admit one live answer in the command path.
ALTER TABLE access.moderation_decision
    DROP CONSTRAINT moderation_decision_answers_step_id_key;

CREATE INDEX moderation_decision_answers_step
    ON access.moderation_decision (answers_step_id)
    WHERE answers_step_id IS NOT NULL;
