-- migrate:up
-- A builtin recipient is explicitly discriminated and has no identity anchor.
-- The nil UUID is a storage sentinel for non-null native temporal keys only.
ALTER TABLE access.resource_grant
  ADD COLUMN subject_kind text NOT NULL DEFAULT 'identity'
    CHECK (subject_kind IN ('identity', 'active_accounts')),
  ADD CONSTRAINT resource_grant_subject_check CHECK (
    (subject_kind = 'identity' AND subject_id <> '00000000-0000-0000-0000-000000000000') OR
    (subject_kind = 'active_accounts' AND subject_id = '00000000-0000-0000-0000-000000000000' AND subject_role = '')
  ),
  DROP CONSTRAINT resource_grant_pkey,
  ADD PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, action, valid WITHOUT OVERLAPS);

CREATE TABLE access.resource_role_grant (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  resource_id uuid NOT NULL,
  subject_kind text NOT NULL DEFAULT 'identity' CHECK (subject_kind IN ('identity', 'active_accounts')),
  subject_id uuid NOT NULL,
  subject_role text NOT NULL DEFAULT '' CHECK (subject_role IN ('', 'owner', 'member')),
  grant_role text NOT NULL CHECK (grant_role ~ '^[a-z][a-z0-9_.-]*$'),
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)
    AND (lower_inf(valid) OR lower_inc(valid)) AND NOT upper_inc(valid)),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid WITHOUT OVERLAPS),
  CHECK (route = get_byte(uuid_send(resource_id), 10) * 256 + get_byte(uuid_send(resource_id), 11)),
  CHECK (
    (subject_kind = 'identity' AND subject_id <> '00000000-0000-0000-0000-000000000000') OR
    (subject_kind = 'active_accounts' AND subject_id = '00000000-0000-0000-0000-000000000000' AND subject_role = '')
  )
);

-- Initialization markers share the new resource's transaction and partition.
-- They survive grant revocation, preventing a second initial-owner installation.
CREATE TABLE access.resource_initialization (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  resource_id uuid NOT NULL,
  resource_type text NOT NULL,
  creator_id uuid NOT NULL,
  initialized_at timestamptz NOT NULL,
  PRIMARY KEY (route, resource_id),
  CHECK (route = get_byte(uuid_send(resource_id), 10) * 256 + get_byte(uuid_send(resource_id), 11))
);
CREATE TABLE access.standing_parent_installation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  resource_id uuid NOT NULL,
  actions text[] NOT NULL CHECK (cardinality(actions) > 0),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, resource_id),
  CHECK (route = get_byte(uuid_send(resource_id), 10) * 256 + get_byte(uuid_send(resource_id), 11))
);

-- migrate:down
-- Forward only: authoritative recipient and role history must be retained.
