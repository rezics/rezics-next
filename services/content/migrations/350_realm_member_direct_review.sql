-- Policy decisions preserve the same exact-revision review chain as human/AI
-- decisions. They never supersede a moderator rejection or revocation.
ALTER TABLE content.realm_review_decision DROP CONSTRAINT realm_review_decision_method_check;
ALTER TABLE content.realm_review_decision ADD CONSTRAINT realm_review_decision_method_check
    CHECK (method IN ('human', 'ai', 'policy'));
ALTER TABLE content.realm_placement_preparation ADD COLUMN direct_policy_revision text;
