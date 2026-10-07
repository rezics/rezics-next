-- Reader-owned order keys are authored only from an exact Structure revision.
-- Legacy rows stay unindexed; reads refuse unknown/stale order rather than scan.
ALTER TABLE structure.progress ADD COLUMN order_revision text,
  ADD COLUMN order_key text COLLATE "C", ADD COLUMN resume_eligible boolean,
  ADD CONSTRAINT progress_order_pair CHECK ((order_revision IS NULL) = (order_key IS NULL)),
  ADD CONSTRAINT progress_order_revision CHECK (order_revision IS NULL OR
    order_revision ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  ADD CONSTRAINT progress_order_key CHECK (order_key IS NULL OR length(order_key) BETWEEN 1 AND 1088);

CREATE TABLE structure.progress_reader (
  principal_issuer text NOT NULL, principal_subject text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (principal_issuer, principal_subject)
);
CREATE TABLE structure.progress_scope (
  principal_issuer text NOT NULL, principal_subject text NOT NULL, structure text NOT NULL,
  order_revision text, ready boolean NOT NULL, version bigint NOT NULL CHECK (version > 0),
  invalidations bigint NOT NULL DEFAULT 0, reindex_cursor jsonb, reindex_invalidations bigint,
  PRIMARY KEY (principal_issuer, principal_subject, structure)
);

CREATE FUNCTION structure.progress_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved structure.progress;
BEGIN
  IF TG_OP = 'DELETE' THEN saved := OLD; ELSE saved := NEW; END IF;
  -- Lock the reader before a scope, including multi-scope maintenance writes.
  INSERT INTO structure.progress_reader VALUES (saved.principal_issuer, saved.principal_subject, 1)
    ON CONFLICT (principal_issuer, principal_subject) DO UPDATE
      SET version = structure.progress_reader.version + 1;
  INSERT INTO structure.progress_scope
    (principal_issuer, principal_subject, structure, order_revision, ready, version)
    VALUES (saved.principal_issuer, saved.principal_subject, saved.structure, saved.order_revision, false, 1)
    ON CONFLICT (principal_issuer, principal_subject, structure) DO UPDATE SET
      version = structure.progress_scope.version + 1,
      invalidations = structure.progress_scope.invalidations + CASE WHEN TG_OP <> 'DELETE' AND saved.completed
        AND saved.resume_eligible IS DISTINCT FROM false AND (saved.order_key IS NULL OR
          saved.order_revision IS DISTINCT FROM coalesce(structure.progress_scope.order_revision, saved.order_revision))
        THEN 1 ELSE 0 END,
      order_revision = coalesce(structure.progress_scope.order_revision, EXCLUDED.order_revision),
      ready = structure.progress_scope.ready AND (TG_OP = 'DELETE' OR NOT saved.completed OR saved.resume_eligible IS FALSE OR
        (saved.order_key IS NOT NULL AND (structure.progress_scope.order_revision IS NULL OR
          structure.progress_scope.order_revision = saved.order_revision)));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER progress_order_changed AFTER INSERT OR UPDATE OR DELETE ON structure.progress
  FOR EACH ROW EXECUTE FUNCTION structure.progress_order_changed();
