-- SYS01: the private Account principal link and cross-owner operation live only
-- in Access. The public graph receipt contains the operation UUID, never this row.
CREATE TABLE access.agent_provision (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    agent_id text NOT NULL UNIQUE CHECK (agent_id ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
    agent_kind text NOT NULL CHECK (agent_kind IN ('person', 'organization', 'service')),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    state text NOT NULL DEFAULT 'planned' CHECK (state IN
      ('planned', 'graph_committed', 'active', 'compensating', 'compensated')),
    graph_data_epoch text,
    graph_sequence numeric CHECK (graph_sequence >= 0 AND graph_sequence = trunc(graph_sequence)),
    representation_id uuid UNIQUE REFERENCES access.representation(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (principal_id, idempotency_key),
    CHECK ((graph_data_epoch IS NULL) = (graph_sequence IS NULL)),
    CHECK (state NOT IN ('graph_committed', 'active') OR graph_sequence IS NOT NULL),
    CHECK (state <> 'active' OR representation_id IS NOT NULL)
);
CREATE INDEX agent_provision_pending ON access.agent_provision (created_at, id)
    WHERE state IN ('planned', 'graph_committed', 'compensating');

CREATE FUNCTION access.agent_provision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.id, OLD.principal_id, OLD.idempotency_key,
      OLD.request_digest, OLD.agent_id, OLD.agent_kind, OLD.display_name,
      OLD.principal_epoch, OLD.created_at) IS DISTINCT FROM
      (NEW.id, NEW.principal_id, NEW.idempotency_key,
      NEW.request_digest, NEW.agent_id, NEW.agent_kind, NEW.display_name,
      NEW.principal_epoch, NEW.created_at) OR OLD.state IN ('active', 'compensated') THEN
    RAISE EXCEPTION 'immutable Agent provision identity or terminal outcome' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state = 'planned' AND NEW.state IN ('planned', 'graph_committed', 'compensating'))
    OR (OLD.state = 'graph_committed' AND NEW.state IN ('graph_committed', 'active', 'compensating'))
    OR (OLD.state = 'compensating' AND NEW.state IN ('compensating', 'compensated'))) THEN
    RAISE EXCEPTION 'invalid Agent provision transition' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER agent_provision_guard BEFORE UPDATE OR DELETE ON access.agent_provision
    FOR EACH ROW EXECUTE FUNCTION access.agent_provision_guard();
