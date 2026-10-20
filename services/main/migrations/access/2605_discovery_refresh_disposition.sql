-- Keep failed populations and their checkpoints. A source change rearms the
-- existing queue entry; no second queue or operator data rewrite is needed.
ALTER TABLE access.discovery_refresh
    ADD COLUMN quarantine_basis jsonb,
    ADD COLUMN quarantine_reason text CHECK (quarantine_reason IN ('basis-invalid','basis-unavailable','inactive')),
    ADD COLUMN last_error text CHECK (length(last_error) <= 512),
    ADD CONSTRAINT discovery_refresh_quarantine_reason CHECK
        ((quarantine_basis IS NULL) = (quarantine_reason IS NULL));

CREATE INDEX discovery_refresh_work_due ON access.discovery_refresh (priority,due_at,scope_key)
    WHERE quarantine_basis IS NULL;
CREATE INDEX discovery_refresh_probe_due ON access.discovery_refresh (due_at,scope_key)
    WHERE quarantine_basis IS NOT NULL;

-- One durable fleet-wide probe allowance, shared by every worker process and
-- every quarantined population, bounds idle graph reads as the catalogue grows.
ALTER TABLE access.discovery_refresh_catalog
    ADD COLUMN probe_due_at timestamptz NOT NULL DEFAULT clock_timestamp();
