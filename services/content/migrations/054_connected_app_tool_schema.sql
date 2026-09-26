-- Main-side MCP observations and the exact tool schemas an Account consent
-- covered. Account remains the only consent owner: rows here reference its
-- oauthConsent id and rezicsGeneration and store no scope or consent state.
-- Admission still introspects Account for the current generation.
CREATE SCHEMA IF NOT EXISTS connected_app;

CREATE FUNCTION connected_app.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable connected-app record' USING ERRCODE = '23514';
END $$;

-- One observation is a bounded, paginated tools/list snapshot of one server
-- endpoint for one principal. It is evidence at observed_at, not a guarantee.
CREATE TABLE connected_app.server_observation (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  endpoint text NOT NULL CHECK (endpoint ~ '^https?://[^[:space:][:cntrl:]]+$'
    AND octet_length(endpoint) <= 2048),
  protocol_version text NOT NULL CHECK (protocol_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  server_info jsonb NOT NULL
    CHECK (jsonb_typeof(server_info) = 'object' AND octet_length(server_info::text) <= 4096),
  capabilities jsonb NOT NULL
    CHECK (jsonb_typeof(capabilities) = 'object' AND octet_length(capabilities::text) <= 16384),
  tools_sha256 text NOT NULL CHECK (tools_sha256 ~ '^[0-9a-f]{64}$'),
  page_count smallint NOT NULL CHECK (page_count BETWEEN 1 AND 64),
  tool_count smallint NOT NULL CHECK (tool_count BETWEEN 0 AND 1024),
  predecessor_id uuid,
  drift text NOT NULL CHECK (drift IN ('initial', 'unchanged', 'changed')),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (id, principal_id),
  UNIQUE (id, principal_id, endpoint),
  UNIQUE (predecessor_id),
  FOREIGN KEY (predecessor_id, principal_id, endpoint)
    REFERENCES connected_app.server_observation(id, principal_id, endpoint),
  CHECK ((predecessor_id IS NULL) = (drift = 'initial'))
);
CREATE UNIQUE INDEX server_observation_initial_idx
  ON connected_app.server_observation (principal_id, endpoint) WHERE predecessor_id IS NULL;
CREATE INDEX server_observation_endpoint_idx
  ON connected_app.server_observation (principal_id, endpoint, observed_at DESC, id);
CREATE TRIGGER connected_app_server_observation_immutable
  BEFORE UPDATE OR DELETE ON connected_app.server_observation
  FOR EACH ROW EXECUTE FUNCTION connected_app.no_mutation();
CREATE TRIGGER connected_app_server_observation_open AFTER INSERT ON connected_app.server_observation
  FOR EACH ROW EXECUTE FUNCTION pkg.open_aggregate('app_observation', 'id');

-- Exact tools/list response pages, including the cursor chain.
CREATE TABLE connected_app.observation_page (
  observation_id uuid NOT NULL REFERENCES connected_app.server_observation(id),
  page_number smallint NOT NULL CHECK (page_number BETWEEN 1 AND 64),
  request_cursor text CHECK (octet_length(request_cursor) BETWEEN 1 AND 1024),
  next_cursor text CHECK (octet_length(next_cursor) BETWEEN 1 AND 1024),
  response_bytes bytea NOT NULL CHECK (octet_length(response_bytes) BETWEEN 2 AND 1048576),
  response_sha256 text NOT NULL,
  PRIMARY KEY (observation_id, page_number),
  CHECK (response_sha256 = encode(sha256(response_bytes), 'hex')),
  CHECK ((page_number = 1) = (request_cursor IS NULL))
);
CREATE TRIGGER connected_app_observation_page_immutable
  BEFORE UPDATE OR DELETE ON connected_app.observation_page
  FOR EACH ROW EXECUTE FUNCTION connected_app.no_mutation();
CREATE TRIGGER connected_app_observation_page_open BEFORE INSERT ON connected_app.observation_page
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('app_observation', 'observation_id');

-- One observed tool definition. definition_jcs_sha256 is SHA-256 over the
-- RFC 8785 canonical JSON of the definition parsed from the retained page;
-- validation records whether the input/output schemas were admitted.
CREATE TABLE connected_app.tool_schema (
  observation_id uuid NOT NULL,
  tool_name text NOT NULL CHECK (octet_length(tool_name) BETWEEN 1 AND 256
    AND tool_name !~ '[[:cntrl:]]'),
  page_number smallint NOT NULL,
  definition jsonb NOT NULL
    CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144),
  definition_jcs_sha256 text NOT NULL CHECK (definition_jcs_sha256 ~ '^[0-9a-f]{64}$'),
  schema_validation text NOT NULL CHECK (schema_validation IN ('valid', 'invalid', 'unsupported')),
  PRIMARY KEY (observation_id, tool_name),
  UNIQUE (observation_id, tool_name, definition_jcs_sha256, schema_validation),
  FOREIGN KEY (observation_id, page_number)
    REFERENCES connected_app.observation_page(observation_id, page_number)
);
CREATE TRIGGER connected_app_tool_schema_immutable
  BEFORE UPDATE OR DELETE ON connected_app.tool_schema
  FOR EACH ROW EXECUTE FUNCTION connected_app.no_mutation();
CREATE TRIGGER connected_app_tool_schema_open BEFORE INSERT ON connected_app.tool_schema
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('app_observation', 'observation_id');

CREATE FUNCTION connected_app.check_observation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pages integer; tools integer; open_pages integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE next_cursor IS NULL) INTO pages, open_pages
    FROM connected_app.observation_page WHERE observation_id = NEW.id;
  SELECT count(*) INTO tools FROM connected_app.tool_schema WHERE observation_id = NEW.id;
  IF pages <> NEW.page_count OR tools <> NEW.tool_count OR open_pages <> 1
    OR EXISTS (SELECT 1 FROM connected_app.observation_page p
      WHERE p.observation_id = NEW.id AND p.next_cursor IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM connected_app.observation_page n WHERE n.observation_id = NEW.id
          AND n.page_number = p.page_number + 1 AND n.request_cursor = p.next_cursor))
    OR EXISTS (SELECT 1 FROM connected_app.observation_page p
      WHERE p.observation_id = NEW.id AND p.next_cursor IS NULL AND p.page_number <> NEW.page_count)
    OR (NEW.predecessor_id IS NOT NULL AND (NEW.drift = 'unchanged') <> (
      NEW.tools_sha256 = (SELECT tools_sha256 FROM connected_app.server_observation
        WHERE id = NEW.predecessor_id))) THEN
    RAISE EXCEPTION 'connected-app observation is incomplete' USING ERRCODE = '23514',
      CONSTRAINT = 'server_observation_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER connected_app_server_observation_complete
  AFTER INSERT ON connected_app.server_observation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION connected_app.check_observation_complete();

-- The tool ceiling approved under one exact Account consent generation for
-- one endpoint and credential audience. A generation has at most one ceiling
-- per endpoint, so widening or accepting a drifted schema needs Account
-- re-consent (a new generation) rather than an in-place edit.
CREATE TABLE connected_app.consent_ceiling (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  account_client_id text NOT NULL CHECK (octet_length(account_client_id) BETWEEN 1 AND 256),
  account_consent_id text NOT NULL CHECK (octet_length(account_consent_id) BETWEEN 1 AND 256),
  account_consent_generation uuid NOT NULL,
  endpoint text NOT NULL,
  resource text NOT NULL CHECK (resource ~ '^https?://[^[:space:][:cntrl:]]+$'
    AND octet_length(resource) <= 2048),
  observation_id uuid NOT NULL,
  tool_count smallint NOT NULL CHECK (tool_count BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (account_consent_id, account_consent_generation, endpoint),
  UNIQUE (id, observation_id),
  UNIQUE (id, account_consent_generation, resource),
  FOREIGN KEY (observation_id, principal_id, endpoint)
    REFERENCES connected_app.server_observation(id, principal_id, endpoint)
);
CREATE INDEX consent_ceiling_principal_idx
  ON connected_app.consent_ceiling (principal_id, endpoint, created_at DESC, id);
CREATE TRIGGER connected_app_consent_ceiling_immutable
  BEFORE UPDATE OR DELETE ON connected_app.consent_ceiling
  FOR EACH ROW EXECUTE FUNCTION connected_app.no_mutation();
CREATE TRIGGER connected_app_consent_ceiling_open AFTER INSERT ON connected_app.consent_ceiling
  FOR EACH ROW EXECUTE FUNCTION pkg.open_aggregate('app_ceiling', 'id');

CREATE TABLE connected_app.consent_ceiling_tool (
  ceiling_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  tool_name text NOT NULL,
  definition_jcs_sha256 text NOT NULL,
  schema_validation text NOT NULL DEFAULT 'valid' CHECK (schema_validation = 'valid'),
  PRIMARY KEY (ceiling_id, tool_name),
  UNIQUE (ceiling_id, tool_name, definition_jcs_sha256),
  FOREIGN KEY (ceiling_id, observation_id)
    REFERENCES connected_app.consent_ceiling(id, observation_id),
  FOREIGN KEY (observation_id, tool_name, definition_jcs_sha256, schema_validation)
    REFERENCES connected_app.tool_schema(observation_id, tool_name, definition_jcs_sha256, schema_validation)
);
CREATE TRIGGER connected_app_consent_ceiling_tool_immutable
  BEFORE UPDATE OR DELETE ON connected_app.consent_ceiling_tool
  FOR EACH ROW EXECUTE FUNCTION connected_app.no_mutation();
CREATE TRIGGER connected_app_consent_ceiling_tool_open BEFORE INSERT ON connected_app.consent_ceiling_tool
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('app_ceiling', 'ceiling_id');

CREATE FUNCTION connected_app.check_ceiling_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM connected_app.consent_ceiling_tool WHERE ceiling_id = NEW.id)
    <> NEW.tool_count THEN
    RAISE EXCEPTION 'connected-app consent ceiling is incomplete' USING ERRCODE = '23514',
      CONSTRAINT = 'consent_ceiling_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER connected_app_consent_ceiling_complete
  AFTER INSERT ON connected_app.consent_ceiling
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION connected_app.check_ceiling_complete();

-- One tools/call attempt. Both composite keys share the definition digest:
-- the schema observed at admission must be the one the consent covered and
-- validated, and the forwarded credential audience is the ceiling resource.
-- Tool-level errors (isError) and JSON-RPC protocol errors stay distinct; a
-- lost response is uncertain until reconciled.
CREATE TABLE connected_app.invocation (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  ceiling_id uuid NOT NULL,
  account_consent_generation uuid NOT NULL,
  credential_audience text NOT NULL,
  observation_id uuid NOT NULL,
  tool_name text NOT NULL,
  definition_jcs_sha256 text NOT NULL,
  schema_validation text NOT NULL DEFAULT 'valid' CHECK (schema_validation = 'valid'),
  arguments_sha256 text NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted', 'sent', 'completed',
    'tool-error', 'protocol-error', 'cancel-requested', 'cancelled', 'uncertain')),
  result_sha256 text CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  protocol_error jsonb
    CHECK (jsonb_typeof(protocol_error) = 'object' AND octet_length(protocol_error::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  FOREIGN KEY (ceiling_id, tool_name, definition_jcs_sha256)
    REFERENCES connected_app.consent_ceiling_tool(ceiling_id, tool_name, definition_jcs_sha256),
  FOREIGN KEY (ceiling_id, account_consent_generation, credential_audience)
    REFERENCES connected_app.consent_ceiling(id, account_consent_generation, resource),
  FOREIGN KEY (observation_id, tool_name, definition_jcs_sha256, schema_validation)
    REFERENCES connected_app.tool_schema(observation_id, tool_name, definition_jcs_sha256, schema_validation),
  CHECK ((state IN ('completed', 'tool-error')) = (result_sha256 IS NOT NULL)),
  CHECK ((state = 'protocol-error') = (protocol_error IS NOT NULL))
);
CREATE INDEX invocation_principal_idx ON connected_app.invocation (principal_id, created_at DESC, id);
CREATE INDEX invocation_open_idx ON connected_app.invocation (state, updated_at)
  WHERE state IN ('admitted', 'sent', 'cancel-requested', 'uncertain');

-- The observation must be the invoking principal's latest one for the
-- ceiling's endpoint, so a newer drifted observation blocks older schemas.
CREATE FUNCTION connected_app.check_invocation_basis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM connected_app.consent_ceiling c
    JOIN connected_app.server_observation o ON o.id = NEW.observation_id
    WHERE c.id = NEW.ceiling_id AND c.principal_id = NEW.principal_id
      AND o.principal_id = NEW.principal_id AND o.endpoint = c.endpoint
      AND NOT EXISTS (SELECT 1 FROM connected_app.server_observation s
        WHERE s.predecessor_id = o.id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connected-app invocation basis differs' USING ERRCODE = '23514',
      CONSTRAINT = 'invocation_basis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connected_app_invocation_basis BEFORE INSERT ON connected_app.invocation
  FOR EACH ROW EXECUTE FUNCTION connected_app.check_invocation_basis();

CREATE FUNCTION connected_app.guard_invocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'connected-app invocations are retained' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.principal_id, OLD.idempotency_key, OLD.request_digest, OLD.ceiling_id,
      OLD.account_consent_generation, OLD.credential_audience, OLD.observation_id,
      OLD.tool_name, OLD.definition_jcs_sha256, OLD.arguments_sha256, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.principal_id, NEW.idempotency_key, NEW.request_digest, NEW.ceiling_id,
      NEW.account_consent_generation, NEW.credential_audience, NEW.observation_id,
      NEW.tool_name, NEW.definition_jcs_sha256, NEW.arguments_sha256, NEW.created_at)
    OR NOT (
      (OLD.state = 'admitted' AND NEW.state IN ('sent', 'cancelled'))
      OR (OLD.state = 'sent' AND NEW.state IN ('completed', 'tool-error', 'protocol-error',
        'cancel-requested', 'uncertain'))
      OR (OLD.state = 'cancel-requested' AND NEW.state IN ('cancelled', 'completed',
        'tool-error', 'protocol-error', 'uncertain'))
      OR (OLD.state = 'uncertain' AND NEW.state IN ('completed', 'tool-error',
        'protocol-error', 'cancelled'))) THEN
    RAISE EXCEPTION 'connected-app invocation transition is not allowed' USING ERRCODE = '23514',
      CONSTRAINT = 'invocation_transition';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER connected_app_invocation_guard BEFORE UPDATE OR DELETE ON connected_app.invocation
  FOR EACH ROW EXECUTE FUNCTION connected_app.guard_invocation();
