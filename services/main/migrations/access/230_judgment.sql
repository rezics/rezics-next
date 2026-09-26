-- GOV09/GOV10: private principal identity is the counting identity. A persona
-- never creates a second vote. Fit and spoiler have independent head counters;
-- one immutable history family records both dimensions.
CREATE TABLE access.judgment_head (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  statement text NOT NULL CHECK (statement ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  context_key text NOT NULL CHECK (context_key = 'global'
    OR context_key ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  fit_value smallint CHECK (fit_value IN (-1, 1)),
  fit_revision bigint NOT NULL DEFAULT 0 CHECK (fit_revision >= 0),
  spoiler_value smallint CHECK (spoiler_value IN (0, 1, 2)),
  spoiler_revision bigint NOT NULL DEFAULT 0 CHECK (spoiler_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, statement, context_key),
  CHECK (fit_revision <> 0 OR fit_value IS NULL),
  CHECK (spoiler_revision <> 0 OR spoiler_value IS NULL)
);
CREATE INDEX judgment_head_target ON access.judgment_head (statement, context_key);

CREATE TABLE access.judgment_aggregate (
  statement text NOT NULL CHECK (statement ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  context_key text NOT NULL CHECK (context_key = 'global'
    OR context_key ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  fit_negative bigint NOT NULL DEFAULT 0 CHECK (fit_negative >= 0),
  fit_positive bigint NOT NULL DEFAULT 0 CHECK (fit_positive >= 0),
  spoiler_none bigint NOT NULL DEFAULT 0 CHECK (spoiler_none >= 0),
  spoiler_minor bigint NOT NULL DEFAULT 0 CHECK (spoiler_minor >= 0),
  spoiler_major bigint NOT NULL DEFAULT 0 CHECK (spoiler_major >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (statement, context_key)
);

CREATE TABLE access.judgment_receipt (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  statement text NOT NULL,
  context_key text NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('fit', 'spoiler')),
  revision bigint NOT NULL CHECK (revision > 0),
  value smallint CHECK (value IN (-1, 0, 1, 2)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  FOREIGN KEY (principal_id, statement, context_key)
    REFERENCES access.judgment_head(principal_id, statement, context_key),
  CHECK (dimension <> 'fit' OR value IS NULL OR value IN (-1, 1)),
  CHECK (dimension <> 'spoiler' OR value IS NULL OR value IN (0, 1, 2))
);

CREATE TABLE access.judgment_revision (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  statement text NOT NULL,
  context_key text NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('fit', 'spoiler')),
  revision bigint NOT NULL CHECK (revision > 0),
  value smallint CHECK (value IN (-1, 0, 1, 2)),
  previous_value smallint CHECK (previous_value IN (-1, 0, 1, 2)),
  receipt_id uuid NOT NULL UNIQUE REFERENCES access.judgment_receipt(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, statement, context_key, dimension, revision),
  FOREIGN KEY (principal_id, statement, context_key)
    REFERENCES access.judgment_head(principal_id, statement, context_key),
  CHECK (dimension <> 'fit' OR ((value IS NULL OR value IN (-1, 1))
    AND (previous_value IS NULL OR previous_value IN (-1, 1)))),
  CHECK (dimension <> 'spoiler' OR ((value IS NULL OR value IN (0, 1, 2))
    AND (previous_value IS NULL OR previous_value IN (0, 1, 2))))
);
CREATE INDEX judgment_revision_target ON access.judgment_revision
  (statement, context_key, principal_id, dimension, revision DESC);

CREATE FUNCTION access.reject_judgment_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable judgment history' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER judgment_revision_immutable BEFORE UPDATE OR DELETE
  ON access.judgment_revision FOR EACH ROW
  EXECUTE FUNCTION access.reject_judgment_history_mutation();
CREATE TRIGGER judgment_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.judgment_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_judgment_history_mutation();
