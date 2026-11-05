-- migrate:up
ALTER TABLE library.collection_source_output
  ADD COLUMN output_mode text NOT NULL DEFAULT 'selected' CHECK(output_mode IN ('selected','whole_query')),
  ALTER COLUMN expected_members DROP NOT NULL;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='library.collection_source_output'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%expected_members%'
  LOOP EXECUTE format('ALTER TABLE library.collection_source_output DROP CONSTRAINT %I',item.conname); END LOOP;
END; $$;
ALTER TABLE library.collection_source_output
  ADD CONSTRAINT collection_output_cardinality CHECK (
    (expected_members IS NOT NULL AND expected_members>=0 AND written_members<=expected_members)
    OR (output_mode='whole_query' AND expected_members IS NULL AND state<>'complete')),
  ADD CONSTRAINT collection_output_complete_cardinality CHECK (
    state<>'complete' OR (expected_members IS NOT NULL AND written_members=expected_members));

-- Confidential publication progress, under the existing retained output. No AST, actor, credential or grant.
CREATE TABLE library.collection_publication_staging (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  publication_id uuid NOT NULL,
  account_id uuid NOT NULL,
  definition_digest text NOT NULL CHECK(definition_digest ~ '^[0-9a-f]{64}$'),
  binding jsonb NOT NULL CHECK(octet_length(binding::text)<=16384),
  scope_basis jsonb NOT NULL CHECK(octet_length(scope_basis::text)<=8192),
  canonical_generation uuid NOT NULL,
  canonical_basis_digest text NOT NULL CHECK(canonical_basis_digest ~ '^[0-9a-f]{64}$'),
  fact_fence bigint NOT NULL CHECK(fact_fence>=0),
  public_inputs boolean NOT NULL,
  frontier jsonb NOT NULL CHECK(octet_length(frontier::text)<=4096),
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  evidence_count bigint NOT NULL DEFAULT 0 CHECK(evidence_count>=0),
  evidence_fence bigint NOT NULL DEFAULT 0 CHECK(evidence_fence>=0),
  PRIMARY KEY(route,collection_id,generation),
  UNIQUE(route,collection_id,publication_id),
  FOREIGN KEY(route,collection_id,generation)
    REFERENCES library.collection_source_output(route,collection_id,generation)
);
CREATE INDEX collection_publication_staging_account
  ON library.collection_publication_staging(route,account_id,collection_id,generation);
CREATE TABLE library.collection_publication_staging_evidence (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  subject_id uuid NOT NULL,
  included boolean NOT NULL,
  evidence jsonb NOT NULL CHECK(octet_length(evidence::text)<=16384),
  PRIMARY KEY(route,collection_id,generation,subject_id),
  FOREIGN KEY(route,collection_id,generation)
    REFERENCES library.collection_publication_staging(route,collection_id,generation)
);
CREATE FUNCTION library.track_publication_staging_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE library.collection_publication_staging SET evidence_count=evidence_count-1,evidence_fence=evidence_fence+1
    WHERE route=OLD.route AND collection_id=OLD.collection_id AND generation=OLD.generation;
  END IF;
  IF TG_OP<>'DELETE' THEN
    UPDATE library.collection_publication_staging SET evidence_count=evidence_count+1,evidence_fence=evidence_fence+1
    WHERE route=NEW.route AND collection_id=NEW.collection_id AND generation=NEW.generation;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER publication_staging_evidence AFTER INSERT OR UPDATE OR DELETE
ON library.collection_publication_staging_evidence
FOR EACH ROW EXECUTE FUNCTION library.track_publication_staging_evidence();

-- A committed native receipt, independent from public activation and its ordinary command/write basis.
CREATE TABLE library.collection_publication_staging_seal (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  version bigint NOT NULL,
  member_fence bigint NOT NULL,
  members bigint NOT NULL,
  evidence_count bigint NOT NULL,
  evidence_fence bigint NOT NULL,
  owner_epoch integer NOT NULL,
  position bigint NOT NULL CHECK(position>0),
  native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY(route,collection_id,generation),
  FOREIGN KEY(route,collection_id,generation)
    REFERENCES library.collection_publication_staging(route,collection_id,generation)
);
CREATE TRIGGER publication_staging_seal_immutable BEFORE UPDATE
ON library.collection_publication_staging_seal
FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();
-- No cascade, TTL, reclaim, disposition or terminal completion is implied by these records.

-- migrate:down
DROP TABLE library.collection_publication_staging_seal;
DROP TABLE library.collection_publication_staging_evidence;
DROP FUNCTION library.track_publication_staging_evidence();
DROP TABLE library.collection_publication_staging;
-- Unknown-size generations cannot be reinterpreted as selected empty generations.
ALTER TABLE library.collection_source_output ALTER COLUMN expected_members SET NOT NULL;
ALTER TABLE library.collection_source_output DROP CONSTRAINT collection_output_cardinality,
  DROP CONSTRAINT collection_output_complete_cardinality, DROP COLUMN output_mode;
ALTER TABLE library.collection_source_output ADD CHECK(expected_members>=0),
  ADD CHECK(written_members<=expected_members), ADD CHECK(state<>'complete' OR written_members=expected_members);
