-- Scheduler receipts use an inactive, unrepresented service ledger identity.
INSERT INTO access.principal (id, account_issuer, account_subject, active)
VALUES ('00000000-0000-4000-8000-000000000380', 'urn:rezics:internal', 'discovery-refresh', false);

CREATE TABLE access.discovery_refresh (
    scope_key text PRIMARY KEY CHECK (length(scope_key) = 64),
    basis jsonb NOT NULL,
    generation_id uuid REFERENCES access.discovery_generation(generation_id),
    due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_epoch bigint NOT NULL DEFAULT 0,
    attempts bigint NOT NULL DEFAULT 0,
    last_outcome text,
    last_duration_ms integer CHECK (last_duration_ms >= 0)
);
CREATE INDEX discovery_refresh_due ON access.discovery_refresh (due_at, scope_key);

-- Enroll existing and subsequently activated bases, including private Mine.
CREATE FUNCTION access.enroll_discovery_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.family = 'discovery' THEN
        INSERT INTO access.discovery_refresh (scope_key, basis)
        SELECT NEW.scope_key, jsonb_build_object('scope', d.scope, 'realm', d.realm,
            'context', d.context, 'owner', d.principal_id)
        FROM access.discovery_generation d WHERE d.generation_id = NEW.active_generation
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER discovery_refresh_enrollment AFTER INSERT OR UPDATE ON access.derived_generation_head
    FOR EACH ROW EXECUTE FUNCTION access.enroll_discovery_refresh();
INSERT INTO access.discovery_refresh (scope_key, basis)
SELECT h.scope_key, jsonb_build_object('scope', d.scope, 'realm', d.realm,
    'context', d.context, 'owner', d.principal_id)
FROM access.derived_generation_head h JOIN access.discovery_generation d ON d.generation_id = h.active_generation
WHERE h.family = 'discovery';

-- Durable, bounded Context discovery; a process restart resumes the page.
CREATE TABLE access.discovery_refresh_catalog (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    checkpoint text NOT NULL DEFAULT '',
    due_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO access.discovery_refresh_catalog DEFAULT VALUES;

CREATE TABLE access.discovery_retirement (
    generation_id uuid PRIMARY KEY REFERENCES access.discovery_generation(generation_id)
);
CREATE FUNCTION access.retire_discovery_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.family = 'discovery' AND NEW.state IN ('cancelled', 'failed', 'expired') THEN
        INSERT INTO access.discovery_retirement VALUES (NEW.id) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER discovery_entry_retirement AFTER UPDATE OF state ON access.derived_generation
    FOR EACH ROW EXECUTE FUNCTION access.retire_discovery_entries();
INSERT INTO access.discovery_retirement
SELECT generation_id FROM access.discovery_generation d JOIN access.derived_generation g ON g.id = d.generation_id
WHERE g.state IN ('cancelled', 'failed', 'expired');
