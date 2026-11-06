-- migrate:up
-- Bounded receiving progress for the installed fixed Library participant.
ALTER TABLE library.identity_epoch_participant_work
  ADD COLUMN follow_after uuid,
  ADD COLUMN follow_partition integer CHECK (follow_partition BETWEEN 0 AND 4095),
  ADD COLUMN follow_complete boolean NOT NULL DEFAULT true,
  ADD COLUMN source_route integer,
  ADD COLUMN source_id uuid,
  ADD COLUMN plan_key text,
  ADD COLUMN disposition text,
  ADD COLUMN handed_off boolean NOT NULL DEFAULT false;
ALTER TABLE library.identity_epoch_participant_work
  DROP CONSTRAINT identity_epoch_participant_work_role_check,
  ADD CONSTRAINT identity_epoch_participant_work_role_check
    CHECK (role IN ('member','entry','label','session','copy','output','follow'));

CREATE TABLE library.identity_epoch_participant_scope (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch > 0),
  source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535),
  source_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  plan_key text NOT NULL CHECK (octet_length(plan_key)=64),
  after_effect_key text NOT NULL DEFAULT '',
  after_disposition text NOT NULL DEFAULT '',
  exhausted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(partition_no,job_id,job_epoch,source_route,source_id,plan_key),
  CHECK (partition_no = ((get_byte(uuid_send(job_id),10)*256+get_byte(uuid_send(job_id),11)) >> 4)),
  CHECK (source_route = ((get_byte(uuid_send(source_id),10)*256+get_byte(uuid_send(source_id),11)))),
  CHECK (partition_no = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4))
);
CREATE INDEX identity_epoch_participant_scope_pending
  ON library.identity_epoch_participant_scope(partition_no,job_id,job_epoch,source_route,source_id,plan_key)
  WHERE NOT exhausted;
CREATE INDEX identity_epoch_participant_scope_owner
  ON library.identity_epoch_participant_scope(partition_no,owner_id,job_id,job_epoch);

-- Negative and not-yet-delivered follow source rows must be discoverable by original.
CREATE INDEX follow_count_source_identity
  ON library.follow_count_source(target_id,partition_no,account_id)
  WHERE target_type='subject';

-- Structural owner candidates are locators/support only. Native facts and accepted pins remain in their owners.
CREATE TABLE library.owner_identity_candidate_support (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  owner_id uuid NOT NULL,
  canonical_id uuid NOT NULL,
  original_id uuid NOT NULL,
  source_id uuid NOT NULL,
  incarnation text NOT NULL CHECK (octet_length(incarnation) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('member','entry','label','session','copy','output')),
  fact_id uuid NOT NULL,
  PRIMARY KEY(partition_no,owner_id,canonical_id,original_id,source_id,incarnation,role,fact_id),
  CHECK (partition_no = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4)),
  CHECK (partition_no = ((get_byte(uuid_send(canonical_id),10)*256+get_byte(uuid_send(canonical_id),11)) >> 4))
);
CREATE INDEX owner_identity_candidate_support_original
  ON library.owner_identity_candidate_support(partition_no,owner_id,original_id,canonical_id,source_id,role,fact_id);

CREATE TABLE library.owner_identity_candidate (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  owner_id uuid NOT NULL,
  canonical_id uuid NOT NULL,
  original_id uuid NOT NULL,
  support bigint NOT NULL CHECK (support > 0),
  PRIMARY KEY(partition_no,owner_id,canonical_id,original_id),
  CHECK (partition_no = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4)),
  CHECK (partition_no = ((get_byte(uuid_send(canonical_id),10)*256+get_byte(uuid_send(canonical_id),11)) >> 4))
);
CREATE INDEX owner_identity_candidate_order
  ON library.owner_identity_candidate(partition_no,owner_id,canonical_id,original_id);

-- Exact external-owner handoffs remain visible until that owner supplies a real receipt.
CREATE TABLE library.identity_epoch_participant_handoff (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch > 0),
  effect_key text NOT NULL CHECK (octet_length(effect_key) BETWEEN 1 AND 256),
  owner_id uuid NOT NULL,
  owner_partition integer NOT NULL CHECK (owner_partition BETWEEN 0 AND 4095),
  role text NOT NULL CHECK (role IN ('member','entry','label','session','copy','output','follow')),
  reason text NOT NULL CHECK (reason IN ('foreign-owner','frozen-output','public-output','owner-unready')),
  locator jsonb NOT NULL CHECK (octet_length(locator::text) <= 2048),
  resolved boolean NOT NULL DEFAULT false,
  PRIMARY KEY(partition_no,job_id,job_epoch,effect_key,owner_id,role,reason),
  CHECK (partition_no = ((get_byte(uuid_send(job_id),10)*256+get_byte(uuid_send(job_id),11)) >> 4)),
  CHECK (owner_partition = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4))
);
CREATE INDEX identity_epoch_participant_handoff_pending
  ON library.identity_epoch_participant_handoff(partition_no,job_id,job_epoch,effect_key)
  WHERE NOT resolved;

-- migrate:down
DROP INDEX library.identity_epoch_participant_handoff_pending;
DROP TABLE library.identity_epoch_participant_handoff;
DROP INDEX library.identity_epoch_participant_scope_pending;
DROP INDEX library.identity_epoch_participant_scope_owner;
DROP TABLE library.identity_epoch_participant_scope;
DROP INDEX library.owner_identity_candidate_order;
DROP TABLE library.owner_identity_candidate;
DROP INDEX library.owner_identity_candidate_support_original;
DROP TABLE library.owner_identity_candidate_support;
DROP INDEX library.follow_count_source_identity;
ALTER TABLE library.identity_epoch_participant_work
  DROP COLUMN disposition,
  DROP COLUMN plan_key,
  DROP COLUMN source_id,
  DROP COLUMN source_route,
  DROP COLUMN handed_off,
  DROP COLUMN follow_partition,
  DROP COLUMN follow_complete,
  DROP COLUMN follow_after;
ALTER TABLE library.identity_epoch_participant_work
  DROP CONSTRAINT identity_epoch_participant_work_role_check,
  ADD CONSTRAINT identity_epoch_participant_work_role_check
    CHECK (role IN ('member','entry','label','session','copy','output'));
