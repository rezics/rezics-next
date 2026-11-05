-- migrate:up
-- Sending intent precedes released-home enrollment. It survives a lost directory reply.
ALTER TABLE semantic.identity_scope_summary ADD COLUMN maintenance_allowance jsonb
 CHECK(octet_length(maintenance_allowance::text)<=2048);
ALTER TABLE semantic.identity_scope_forward
 ADD COLUMN sending_known boolean NOT NULL DEFAULT false,
 ADD COLUMN directory_home integer CHECK(directory_home BETWEEN 0 AND 4095),
 ADD COLUMN directory_generation uuid,
 ADD COLUMN directory_group uuid,
 ADD CONSTRAINT identity_scope_directory_intent CHECK
  ((directory_home IS NULL AND directory_generation IS NULL AND directory_group IS NULL) OR
   (directory_home IS NOT NULL AND directory_generation IS NOT NULL AND directory_group IS NOT NULL));
-- Existing committed ticket locators remain authoritative when upgrading retained registration rows.
UPDATE semantic.identity_scope_forward SET sending_known=true,directory_home=(ticket->>'partition_no')::integer,
 directory_generation=(ticket->>'generation')::uuid,directory_group='00000000-0000-0000-0000-000000000000'
 WHERE ticket IS NOT NULL;
ALTER TABLE semantic.identity_scope_forward ALTER COLUMN sending_known SET DEFAULT true;
CREATE TABLE semantic.identity_scope_completion (
 partition_no integer NOT NULL,
 source_key text NOT NULL,
 scope_id text NOT NULL,
 registration uuid NOT NULL,
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL,
 source_generation text NOT NULL,
 capture_id uuid NOT NULL,
 attempt jsonb NOT NULL CHECK(octet_length(attempt::text)<=1024),
 seal jsonb CHECK(octet_length(seal::text)<=4096),
 after_key jsonb CHECK(octet_length(after_key::text)<=512),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,source_key,scope_id,registration,job_id,job_epoch)
);
CREATE INDEX identity_scope_active_attempt ON semantic.identity_scope_attempt
 (partition_no,source_key,scope_id,registration,job_id,job_epoch) WHERE state='active';
-- A directory-native release receipt and tombstone replace each removed inverse ticket.
CREATE TABLE semantic.identity_scope_directory_release (
 partition_no integer NOT NULL,
 generation uuid NOT NULL,
 original uuid NOT NULL,
 source_partition integer NOT NULL,
 source_key text NOT NULL,
 scope_id text NOT NULL,
 registration uuid NOT NULL,
 capture_id uuid NOT NULL,
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,generation,original,source_partition,source_key,scope_id,registration)
);
DROP INDEX semantic.identity_scope_repair_pending;
CREATE INDEX identity_scope_repair_pending ON semantic.identity_scope_summary(partition_no,source_key,scope_id)
 WHERE state IN ('capturing','enrolling','repair','retiring');
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK
 (purpose IN ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts',
 'identity-receiving-plan','identity-receiving-record','identity-receiving-custody',
 'identity-prearm','identity-prearm-cancel',
 'identity-scope-registration','identity-scope-enrollment','identity-scope-preparation','identity-scope-cancellation',
 'identity-public-capture','identity-scope-finish','identity-scope-retirement','identity-scope-directory-release'));

-- migrate:down
DROP TABLE semantic.identity_scope_directory_release;
DROP INDEX semantic.identity_scope_active_attempt;
DROP TABLE semantic.identity_scope_completion;
ALTER TABLE semantic.identity_scope_summary DROP COLUMN maintenance_allowance;
ALTER TABLE semantic.identity_scope_forward DROP COLUMN sending_known,DROP CONSTRAINT identity_scope_directory_intent,
 DROP COLUMN directory_home,DROP COLUMN directory_generation,DROP COLUMN directory_group;
DROP INDEX semantic.identity_scope_repair_pending;
CREATE INDEX identity_scope_repair_pending ON semantic.identity_scope_summary(partition_no,source_key,scope_id)
 WHERE state IN ('capturing','enrolling','repair');
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK
 (purpose IN ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts',
 'identity-receiving-plan','identity-receiving-record','identity-receiving-custody',
 'identity-prearm','identity-prearm-cancel',
 'identity-scope-registration','identity-scope-enrollment','identity-scope-preparation','identity-scope-cancellation','identity-public-capture'));
