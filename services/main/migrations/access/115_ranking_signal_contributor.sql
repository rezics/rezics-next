-- A retained rating observation is attributable to its sealed Access admission.
-- Null supports generations written before this migration; delivery treats those
-- generations conservatively after an Account erasure.
ALTER TABLE access.ranking_signal_slot
    ADD COLUMN contributor_principal_id uuid REFERENCES access.principal(id);
CREATE INDEX ranking_signal_contributor ON access.ranking_signal_slot
    (generation_id, contributor_principal_id) WHERE contributor_principal_id IS NOT NULL;
CREATE INDEX ranking_signal_unattributed ON access.ranking_signal_slot
    (generation_id) WHERE contributor_principal_id IS NULL;
