-- The command path admits at most one live answer. Seek its latest immutable
-- attempt before checking operation/effect state, independent of cancelled history.
DROP INDEX access.moderation_decision_answers_step;
CREATE INDEX moderation_decision_answers_step
    ON access.moderation_decision (answers_step_id, case_sequence DESC)
    WHERE answers_step_id IS NOT NULL;
