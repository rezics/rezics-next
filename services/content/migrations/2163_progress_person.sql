-- migrate: progress-people
-- Access bindings are staged in a transaction-local table by the owner runner.
-- Missing/ambiguous bindings abort before any saved state is changed.
CREATE TEMP TABLE IF NOT EXISTS progress_person_binding (
  principal_issuer text NOT NULL, principal_subject text NOT NULL, agent text NOT NULL,
  PRIMARY KEY (principal_issuer,principal_subject)) ON COMMIT DROP;
LOCK TABLE structure.progress, structure.progress_command IN ACCESS EXCLUSIVE MODE;
ALTER TABLE structure.progress DISABLE TRIGGER progress_order_changed;
ALTER TABLE structure.progress_command DISABLE TRIGGER progress_command_immutable;
ALTER TABLE structure.progress ADD COLUMN agent text;
ALTER TABLE structure.progress_command ADD COLUMN agent text;
UPDATE structure.progress p SET agent = b.agent FROM pg_temp.progress_person_binding b
  WHERE p.principal_issuer = b.principal_issuer AND p.principal_subject = b.principal_subject;
UPDATE structure.progress_command p SET agent = b.agent FROM pg_temp.progress_person_binding b
  WHERE p.principal_issuer = b.principal_issuer AND p.principal_subject = b.principal_subject;
ALTER TABLE structure.progress ALTER COLUMN agent SET NOT NULL;
ALTER TABLE structure.progress_command ALTER COLUMN agent SET NOT NULL;
ALTER TABLE structure.progress ADD CONSTRAINT progress_person CHECK (agent ~ '^https://rezics\.com/id/[0-9a-f-]{36}$');
ALTER TABLE structure.progress_command ADD CONSTRAINT progress_command_person CHECK (agent ~ '^https://rezics\.com/id/[0-9a-f-]{36}$');

-- A Person's newest explicit state wins, including an incomplete state. Keep
-- every immutable command/event receipt, even when principals reused a key.
-- Advance merged versions beyond every old version to reject stale writers.
WITH ranked AS (
  SELECT ctid, row_number() OVER (PARTITION BY agent,structure,occurrence,selection_key
    ORDER BY updated_at DESC,principal_issuer,principal_subject) AS priority,
    count(*) OVER (PARTITION BY agent,structure,occurrence,selection_key) AS copies,
    max(version) OVER (PARTITION BY agent,structure,occurrence,selection_key) AS latest_version
  FROM structure.progress
)
UPDATE structure.progress p SET version = r.latest_version + (r.copies > 1)::integer
  FROM ranked r WHERE p.ctid = r.ctid AND r.priority = 1;
WITH ranked AS (
  SELECT ctid, row_number() OVER (PARTITION BY agent,structure,occurrence,selection_key
    ORDER BY updated_at DESC,principal_issuer,principal_subject) AS priority FROM structure.progress
)
DELETE FROM structure.progress p USING ranked r WHERE p.ctid = r.ctid AND r.priority > 1;

ALTER TABLE structure.progress DROP CONSTRAINT progress_pkey;
ALTER TABLE structure.progress DROP COLUMN principal_issuer, DROP COLUMN principal_subject;
ALTER TABLE structure.progress ADD PRIMARY KEY (agent,structure,occurrence,selection_key);
ALTER TABLE structure.progress_command DROP CONSTRAINT progress_command_pkey;
ALTER TABLE structure.progress_command ADD PRIMARY KEY (agent,principal_issuer,principal_subject,idempotency_key);
DROP INDEX structure.progress_command_first_finish_idx;
CREATE INDEX progress_command_first_finish_idx ON structure.progress_command (agent,structure,occurrence,result_completed);
CREATE INDEX progress_command_person_source ON structure.progress_command (agent,idempotency_key);
CREATE INDEX progress_latest ON structure.progress (agent,structure,updated_at DESC,occurrence DESC,selection_key);
CREATE INDEX progress_order_seek ON structure.progress
  (agent,structure,order_revision,order_key DESC,occurrence DESC,selection_key ASC)
  WHERE completed AND resume_eligible AND order_key IS NOT NULL;
CREATE INDEX progress_completed_seek ON structure.progress (agent,structure,occurrence,selection_key)
  WHERE completed AND resume_eligible IS DISTINCT FROM false;

-- Invalidate any pre-migration private continuation, including a reader with
-- many revisions on one cell. Its new clock exceeds every source clock.
CREATE TEMP TABLE progress_person_clock ON COMMIT DROP AS
  SELECT b.agent,sum(r.version)+1 AS version FROM structure.progress_reader r
  JOIN pg_temp.progress_person_binding b USING (principal_issuer,principal_subject) GROUP BY b.agent;

-- Order scopes and anchors are derivations, rebuilt from the retained states.
DROP TABLE structure.progress_anchor_scope, structure.progress_scope, structure.progress_reader;
CREATE TABLE structure.progress_reader (
  agent text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (agent)
);
CREATE TABLE structure.progress_scope (
  agent text NOT NULL, structure text NOT NULL,
  order_revision text, ready boolean NOT NULL, version bigint NOT NULL CHECK (version > 0),
  invalidations bigint NOT NULL DEFAULT 0, reindex_cursor jsonb, reindex_invalidations bigint,
  PRIMARY KEY (agent, structure)
);

CREATE OR REPLACE FUNCTION structure.progress_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved structure.progress;
BEGIN
  IF TG_OP = 'DELETE' THEN saved := OLD; ELSE saved := NEW; END IF;
  -- Lock the reader before a scope, including multi-scope maintenance writes.
  INSERT INTO structure.progress_reader VALUES (saved.agent, 1)
    ON CONFLICT (agent) DO UPDATE
      SET version = structure.progress_reader.version + 1;
  INSERT INTO structure.progress_scope
    (agent, structure, order_revision, ready, version)
    VALUES (saved.agent, saved.structure, saved.order_revision, false, 1)
    ON CONFLICT (agent, structure) DO UPDATE SET
      version = structure.progress_scope.version + 1,
      invalidations = structure.progress_scope.invalidations + CASE WHEN TG_OP <> 'DELETE' AND saved.completed
        AND saved.resume_eligible IS DISTINCT FROM false AND (saved.order_key IS NULL OR
          saved.order_revision IS DISTINCT FROM coalesce(structure.progress_scope.order_revision, saved.order_revision))
        THEN 1 ELSE 0 END,
      order_revision = coalesce(structure.progress_scope.order_revision, EXCLUDED.order_revision),
      ready = structure.progress_scope.ready AND (TG_OP = 'DELETE' OR NOT saved.completed OR saved.resume_eligible IS FALSE OR
        (saved.order_key IS NOT NULL AND (structure.progress_scope.order_revision IS NULL OR
          structure.progress_scope.order_revision = saved.order_revision)));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TABLE structure.progress_anchor_scope (
  agent text NOT NULL,
  structure text NOT NULL, parent text NOT NULL,
  revision text, parent_revision text, cursor jsonb,
  PRIMARY KEY (agent, structure, parent),
  CONSTRAINT progress_anchor_scope_basis CHECK ((revision IS NULL) = (parent_revision IS NULL))
);
CREATE INDEX progress_anchor_overflow ON structure.progress_anchor_scope
  (agent, structure) WHERE parent = '';

INSERT INTO structure.progress_reader (agent,version)
  SELECT agent,version FROM pg_temp.progress_person_clock;
INSERT INTO structure.progress_reader (agent,version)
  SELECT agent,max(version)+1 FROM structure.progress GROUP BY agent
  ON CONFLICT (agent) DO UPDATE SET version = greatest(structure.progress_reader.version, EXCLUDED.version);
INSERT INTO structure.progress_scope (agent,structure,ready,version)
  SELECT DISTINCT agent,structure,false,1 FROM structure.progress;
ALTER TABLE structure.progress ENABLE TRIGGER progress_order_changed;
ALTER TABLE structure.progress_command ENABLE TRIGGER progress_command_immutable;
