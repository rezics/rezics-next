-- A private search read is registered before cross-owner work. The scope gate
-- serializes admission with strong closure across Main replicas. A delivery
-- remains pending until its owner explicitly records completion or abortion;
-- elapsed time alone cannot prove that response bytes stopped flowing.
CREATE TABLE access.search_read_lease (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    contribution text NOT NULL CHECK (contribution LIKE 'https://rezics.com/id/%'),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    representation_id uuid NOT NULL REFERENCES access.representation(id),
    grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    recovery_generation bigint NOT NULL CHECK (recovery_generation >= 0),
    subject_generation bigint NOT NULL CHECK (subject_generation >= 0),
    representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
    grant_generation bigint NOT NULL CHECK (grant_generation >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('admitted', 'delivering', 'delivered', 'aborted', 'expired')),
    delivery_started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT search_read_lease_scope CHECK (scope_id = 'contribution:read:' || contribution),
    CONSTRAINT search_read_lease_times CHECK (expires_at > created_at),
    CONSTRAINT search_read_lease_state CHECK (
      (state = 'admitted' AND delivery_started_at IS NULL AND finished_at IS NULL)
      OR (state = 'delivering' AND delivery_started_at IS NOT NULL AND finished_at IS NULL)
      OR (state IN ('delivered', 'aborted', 'expired') AND finished_at IS NOT NULL)
    )
);
CREATE INDEX search_read_pending_scope ON access.search_read_lease (scope_id, id)
    WHERE state IN ('admitted', 'delivering');
CREATE INDEX search_read_pending_principal ON access.search_read_lease (principal_id, id)
    WHERE state IN ('admitted', 'delivering');
CREATE INDEX search_read_delivering ON access.search_read_lease (id)
    WHERE state = 'delivering';
