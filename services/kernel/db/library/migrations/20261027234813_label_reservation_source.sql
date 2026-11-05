-- migrate:up
-- Keep legacy rows outside the reservation source until bounded migration and validation.
-- Add the nullable identity before its volatile default to avoid rewriting existing rows.
ALTER TABLE library.label_assignment
  ADD COLUMN assignment_id uuid;

ALTER TABLE library.label_assignment
  ALTER COLUMN assignment_id SET DEFAULT gen_random_uuid();

ALTER TABLE library.label_assignment
  ADD COLUMN slot_no smallint,
  ADD CONSTRAINT label_assignment_slot_range CHECK (slot_no IS NULL OR slot_no BETWEEN 0 AND 31),
  ADD CONSTRAINT label_assignment_deleted_slot CHECK (deleted_at IS NULL OR slot_no IS NULL),
  ADD CONSTRAINT label_assignment_reserved_identity CHECK (slot_no IS NULL OR assignment_id IS NOT NULL),
  ADD CONSTRAINT label_assignment_identity UNIQUE (route, account_id, assignment_id);

-- Reservations bound candidates, including those hidden by a deleted parent.
-- Current parent checks remain necessary; reservation membership establishes no positive fact.
CREATE UNIQUE INDEX label_assignment_reserved_slot
  ON library.label_assignment (route, account_id, subject_id, slot_no)
  WHERE slot_no IS NOT NULL;

-- The generic Collection label driver uses this same path over actual assignment rows.
CREATE INDEX label_assignment_reserved_source
  ON library.label_assignment (route, account_id, subject_id, assignment_id)
  INCLUDE (label_id, slot_no, revision, transaction_id)
  WHERE slot_no IS NOT NULL;

-- Shared mutation fence for entry, label, session and copy sources, not readiness evidence.
-- Actual producers, bounded legacy cutover and source adapters are still required.
-- No eager owner setup, writer or trigger is installed by this migration.
CREATE TABLE library.fact_source_head (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- migrate:down
-- Forward only: retained assignment identities and source fences must survive rollback.
