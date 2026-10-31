-- migrate:up
-- A later repoint or a missing source projection cannot certify a full undo inventory.
-- Existing footers stay unavailable until they have actual native source custody.
ALTER TABLE semantic.identity_epoch_mapping_undo ADD COLUMN fact_projection_complete boolean DEFAULT false NOT NULL;

-- migrate:down
-- Forward-only source projection custody.
