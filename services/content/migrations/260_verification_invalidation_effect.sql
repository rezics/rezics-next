-- A paged invalidation records each target effect once, even when another
-- event becomes the target's latest demand before an older page is retried.
CREATE TABLE verification.invalidation_effect (
  invalidation_id uuid NOT NULL REFERENCES verification.invalidation(id),
  target verification.iri NOT NULL,
  context verification.iri NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (invalidation_id, target, context),
  FOREIGN KEY (target, context) REFERENCES verification.summary_head(target, context)
);
CREATE INDEX invalidation_effect_target ON verification.invalidation_effect (target, context);
CREATE TRIGGER verification_invalidation_effect_immutable BEFORE UPDATE OR DELETE
  ON verification.invalidation_effect FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();
