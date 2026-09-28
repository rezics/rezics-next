-- Person settings travel with the controlled Agent. Access owns every choice
-- that changes disclosure or what Main may present to that person.
CREATE TABLE access.person_preferences (
  agent_id text PRIMARY KEY REFERENCES access.authority_subject(id),
  profile_visibility text NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'private')),
  follow_policy text NOT NULL DEFAULT 'everyone' CHECK (follow_policy IN ('everyone', 'nobody')),
  hide_reading_activity boolean NOT NULL DEFAULT false,
  content_languages text[] NOT NULL DEFAULT '{}',
  spoiler_policy text NOT NULL DEFAULT 'hide-unread' CHECK (spoiler_policy IN ('hide-unread', 'show')),
  adult_content boolean NOT NULL DEFAULT false,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(content_languages) <= 8)
);

CREATE TABLE access.person_preferences_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);

CREATE TABLE access.person_block (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  target_agent text NOT NULL REFERENCES access.authority_subject(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, target_agent)
);

CREATE TABLE access.person_block_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
