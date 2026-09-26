-- A provider redirect or merge is source evidence from one exact observation. It
-- relates two SourceRecords of the same provider namespace for source purposes only.
-- It never rewrites observations, supports, bindings, grants, ratings or content.
CREATE TABLE source.record_identity_change (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('redirect', 'merge')),
  from_record_id uuid NOT NULL REFERENCES source.record(id),
  to_record_id uuid NOT NULL REFERENCES source.record(id),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_record_id <> to_record_id),
  UNIQUE (observation_id, from_record_id)
);
CREATE INDEX record_identity_change_from_idx
  ON source.record_identity_change (principal_id, from_record_id, created_at, id);
CREATE INDEX record_identity_change_to_idx
  ON source.record_identity_change (principal_id, to_record_id, created_at, id);
CREATE TRIGGER source_record_identity_change_immutable
  BEFORE UPDATE OR DELETE ON source.record_identity_change
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- When the two records support different native targets, the source owner may only
-- propose a native identity correction for the target owner to decide (LIVE06).
CREATE TABLE source.identity_correction_proposal (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  change_id uuid NOT NULL REFERENCES source.record_identity_change(id),
  from_target text NOT NULL CHECK (from_target ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  to_target text NOT NULL CHECK (to_target ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  effect text NOT NULL CHECK (effect = 'proposal-only'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_target <> to_target),
  UNIQUE (change_id, from_target, to_target),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX identity_correction_proposal_target_idx
  ON source.identity_correction_proposal (from_target, id);
CREATE TRIGGER source_identity_correction_proposal_immutable
  BEFORE UPDATE OR DELETE ON source.identity_correction_proposal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_record_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source.observation o
      JOIN source.record f ON f.id = o.record_id
      JOIN source.record t ON t.id = NEW.to_record_id
      WHERE o.id = NEW.observation_id AND o.principal_id = NEW.principal_id
        AND f.id = NEW.from_record_id AND t.provider = f.provider AND t.namespace = f.namespace) THEN
    RAISE EXCEPTION 'identity change needs the principal''s observation of the redirected record'
      USING ERRCODE = '23514', CONSTRAINT = 'record_identity_change_evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_record_identity_change_check BEFORE INSERT ON source.record_identity_change
  FOR EACH ROW EXECUTE FUNCTION source.check_record_identity_change();

CREATE FUNCTION source.record_supports_target(owner uuid, source_record uuid, native_target text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM source.field_support s
      WHERE s.principal_id = owner AND s.target = native_target AND s.record_id = source_record)
    OR EXISTS (SELECT 1 FROM source.native_work_binding b
      JOIN source.native_work_proposal p ON p.id = b.proposal_id
      WHERE b.work = native_target AND b.principal_id = owner AND p.record_id = source_record)
    OR EXISTS (SELECT 1 FROM source.native_work_support_attachment a
      WHERE a.work = native_target AND a.principal_id = owner AND a.record_id = source_record)
$$;

CREATE FUNCTION source.check_identity_correction_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change source.record_identity_change;
BEGIN
  SELECT * INTO change FROM source.record_identity_change
    WHERE id = NEW.change_id AND principal_id = NEW.principal_id;
  IF NOT FOUND OR NOT source.record_supports_target(NEW.principal_id, change.from_record_id, NEW.from_target)
    OR NOT source.record_supports_target(NEW.principal_id, change.to_record_id, NEW.to_target) THEN
    RAISE EXCEPTION 'identity correction needs supported targets for both records'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_correction_supports';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_identity_correction_proposal_check BEFORE INSERT ON source.identity_correction_proposal
  FOR EACH ROW EXECUTE FUNCTION source.check_identity_correction_proposal();
