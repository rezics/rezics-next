-- migrate:up
CREATE INDEX effects_identity_admission_pending_idx ON core.outbox (partition_no, position)
WHERE type = 'com.rezics.semantic.identity-epoch.admitted.v1' AND payload_state = 'present';

-- migrate:down
DROP INDEX core.effects_identity_admission_pending_idx;
