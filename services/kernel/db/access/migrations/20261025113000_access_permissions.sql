-- migrate:up
-- Permission subjects are references, never foreign keys to another anchor.
-- The route is always the protected resource's route, including projected Realm bans.
CREATE TABLE access.resource_grant (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  resource_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  subject_role text NOT NULL DEFAULT '' CHECK (subject_role IN ('', 'owner', 'member')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'),
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)
    AND (lower_inf(valid) OR lower_inc(valid)) AND NOT upper_inc(valid)),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, resource_id, subject_id, subject_role, action, valid WITHOUT OVERLAPS),
  CHECK (route = get_byte(uuid_send(resource_id), 10) * 256 + get_byte(uuid_send(resource_id), 11))
);

CREATE TABLE access.resource_denial (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  resource_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  subject_role text NOT NULL DEFAULT '' CHECK (subject_role IN ('', 'owner', 'member')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'),
  reason text NOT NULL CHECK (reason IN ('resource', 'suspension', 'realm_ban')),
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)
    AND (lower_inf(valid) OR lower_inc(valid)) AND NOT upper_inc(valid)),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, resource_id, subject_id, subject_role, action, reason, valid WITHOUT OVERLAPS),
  CHECK (route = get_byte(uuid_send(resource_id), 10) * 256 + get_byte(uuid_send(resource_id), 11))
);

-- Only a principal-authenticated command may create an assignment. This data layer
-- provides no mutation adapter; command integration must bind principal_id to its actor.
CREATE TABLE access.principal_assignment (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  principal_id uuid NOT NULL,
  request_id uuid NOT NULL,
  assigned_actor_id uuid NOT NULL,
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)
    AND (lower_inf(valid) OR lower_inc(valid)) AND NOT upper_inc(valid)),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, principal_id, request_id),
  CHECK (route = get_byte(uuid_send(principal_id), 10) * 256 + get_byte(uuid_send(principal_id), 11))
);

-- migrate:down
-- Forward only: authoritative permission and assignment history must not be rolled back.
