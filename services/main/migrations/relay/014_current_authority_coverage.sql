-- One current, separately retained authority capture across all consumers.
-- Per-consumer heads remain the recovery evidence; this pointer prevents an
-- older consumer's unchanged head from authorizing an obsolete Access restore.
CREATE TABLE relay.current_authority_coverage (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    consumer text NOT NULL REFERENCES relay.recovery_coverage_head(consumer),
    coverage_digest text NOT NULL CHECK (coverage_digest ~ '^[0-9a-f]{64}$'),
    coverage_generation bigint NOT NULL CHECK (coverage_generation >= 1),
    captured_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

INSERT INTO relay.current_authority_coverage
    (id, consumer, coverage_digest, coverage_generation, captured_at)
SELECT true, consumer, coverage_digest, generation, captured_at
FROM relay.recovery_coverage_head ORDER BY captured_at DESC, consumer DESC LIMIT 1;

CREATE FUNCTION relay.advance_current_authority_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rezics-relay-authority-coverage', 0));
  INSERT INTO relay.current_authority_coverage
      (id, consumer, coverage_digest, coverage_generation, captured_at)
  VALUES (true, NEW.consumer, NEW.coverage_digest, NEW.generation, NEW.captured_at)
  ON CONFLICT (id) DO UPDATE SET
      consumer = EXCLUDED.consumer,
      coverage_digest = EXCLUDED.coverage_digest,
      coverage_generation = EXCLUDED.coverage_generation,
      captured_at = EXCLUDED.captured_at,
      revision = relay.current_authority_coverage.revision + 1;
  RETURN NULL;
END $$;
CREATE TRIGGER current_authority_coverage_advance
    AFTER INSERT OR UPDATE OF coverage_digest, generation, captured_at
    ON relay.recovery_coverage_head FOR EACH ROW
    EXECUTE FUNCTION relay.advance_current_authority_coverage();
