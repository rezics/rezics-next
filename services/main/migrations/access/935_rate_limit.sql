-- Existing principals start conservatively as newcomers; admission history is
-- not a reliable account creation time. Future inserts retain first-seen time.
ALTER TABLE access.principal ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE access.rate_limit_v1 (
    key text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
    family text NOT NULL CHECK (family IN ('write', 'upload', 'report', 'correspondence', 'search')),
    count integer NOT NULL CHECK (count > 0),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (key, family)
);
CREATE INDEX rate_limit_v1_expiry ON access.rate_limit_v1 (expires_at);
-- Supports a bounded principal -> represented Agent -> moderation-role lookup.
CREATE INDEX realm_admin_assignment_member_rate_limit ON access.realm_admin_assignment (member, valid_until);
