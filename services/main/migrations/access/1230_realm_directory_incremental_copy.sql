-- A spare cut is valid only after it has been published or fully synchronized.
-- Older builders leave no trustworthy cut; finish their rebuild, then mirror it.
ALTER TABLE access.realm_directory_position ADD COLUMN spare_sequence bigint;
ALTER TABLE access.realm_directory_position DROP CONSTRAINT realm_directory_position_phase_check;
ALTER TABLE access.realm_directory_position ADD CONSTRAINT realm_directory_position_phase_check
  CHECK (phase IN ('idle','clean','copy','graph','sync-clean','sync-copy'));
UPDATE access.realm_directory_position SET build_data_epoch = NULL,revision = revision + 1 WHERE singleton;
