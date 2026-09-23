-- Latest captured cross-owner recovery cut, retained outside restored owners.
CREATE TABLE relay.recovery_coverage_head (
    consumer text PRIMARY KEY REFERENCES relay.checkpoint(consumer),
    coverage_digest text NOT NULL CHECK (coverage_digest ~ '^[0-9a-f]{64}$'),
    generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
