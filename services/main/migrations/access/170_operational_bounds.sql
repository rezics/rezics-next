-- IAM35: the operational bounds under which Access interprets saved grants.
-- A profile identity names immutable numeric bounds; one activation row names
-- the profile every Main process enforces. Main activates its requested profile
-- at startup. `restricted` records the saved rows that exceed an activated
-- reduction; those operations stay typed unavailable until the rows migrate.
CREATE TABLE access.operational_bounds_profile (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]*$'),
    acting_contexts integer NOT NULL CHECK (acting_contexts > 0),
    group_depth integer NOT NULL CHECK (group_depth > 0),
    groups_per_scope integer NOT NULL CHECK (groups_per_scope > 0),
    memberships_per_scope integer NOT NULL CHECK (memberships_per_scope > 0),
    member_groups_per_agent integer NOT NULL CHECK (member_groups_per_agent > 0),
    private_groups_per_principal integer NOT NULL CHECK (private_groups_per_principal > 0),
    roles_per_principal integer NOT NULL CHECK (roles_per_principal > 0),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION access.reject_operational_bounds_profile_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access operational bounds profile' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER operational_bounds_profile_immutable BEFORE UPDATE OR DELETE
    ON access.operational_bounds_profile FOR EACH ROW
    EXECUTE FUNCTION access.reject_operational_bounds_profile_change();

CREATE TABLE access.operational_bounds_activation (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    profile_id text NOT NULL REFERENCES access.operational_bounds_profile(id),
    state text NOT NULL CHECK (state IN ('active', 'restricted')),
    violations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(violations) = 'array'),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state = 'active') = (violations = '[]'::jsonb))
);

-- The bounds Access code enforced before this migration.
INSERT INTO access.operational_bounds_profile (id, acting_contexts, group_depth,
    groups_per_scope, memberships_per_scope, member_groups_per_agent,
    private_groups_per_principal, roles_per_principal)
VALUES ('access-operational-bounds-v1', 50, 32, 256, 1024, 16, 16, 16);
INSERT INTO access.operational_bounds_activation (profile_id, state)
VALUES ('access-operational-bounds-v1', 'active');
