-- Two reusable generations retain the last completed directory while a bounded
-- worker clears, copies and hydrates its successor. Membership triggers update
-- both generations so publishing cannot overwrite an exact count delta.
ALTER TABLE access.realm_directory ADD COLUMN generation smallint NOT NULL DEFAULT 0 CHECK (generation IN (0,1));
ALTER TABLE access.realm_directory DROP CONSTRAINT realm_directory_pkey;
ALTER TABLE access.realm_directory ADD PRIMARY KEY (generation,realm);
CREATE INDEX realm_directory_realm ON access.realm_directory(realm);
DROP INDEX access.realm_directory_created;
DROP INDEX access.realm_directory_activity;
DROP INDEX access.realm_directory_members;
CREATE INDEX realm_directory_created ON access.realm_directory(generation,(-created),realm);
CREATE INDEX realm_directory_activity ON access.realm_directory(generation,(-activity),realm);
CREATE INDEX realm_directory_members ON access.realm_directory(generation,(-count_value),realm);
ALTER TABLE access.realm_directory_position
  ADD COLUMN generation smallint NOT NULL DEFAULT 0 CHECK (generation IN (0,1)),
  ADD COLUMN revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN build_data_epoch text,
  ADD COLUMN build_base_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN phase text NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle','clean','copy','graph'));
-- Older Main may have left a partially built projection; never label it complete.
UPDATE access.realm_directory_position SET data_epoch = NULL,target_sequence = NULL,
  refresh_after = '',rebuilding = true WHERE rebuilding OR target_sequence IS NOT NULL;
