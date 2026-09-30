-- Orchestration only. Owner receipts remain the source of truth for effects.
-- No grants, controller bindings or creator rights are transferred here.
CREATE TABLE access.identity_merge_task (
  task_key text PRIMARY KEY,
  application uuid NOT NULL UNIQUE REFERENCES access.editorial_application(id),
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  data_epoch text NOT NULL CHECK (length(data_epoch) BETWEEN 1 AND 512),
  handlers jsonb NOT NULL CHECK (jsonb_typeof(handlers) = 'array'
    AND jsonb_array_length(handlers) BETWEEN 1 AND 32),
  original_key text UNIQUE REFERENCES access.identity_merge_task(task_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((plan->>'operation') IN ('merge','unmerge')),
  CHECK (((plan->>'operation') = 'unmerge') = (original_key IS NOT NULL)),
  CHECK ((plan->'source'->>'resource') <> (plan->'survivor'->>'resource'))
);

CREATE FUNCTION access.identity_merge_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The lifecycle creates this immutable application only after its approval
  -- checks. Native owner admission must still recheck current review authority.
  IF NOT EXISTS (
    SELECT 1 FROM access.editorial_application a
    JOIN access.editorial_proposal p ON p.id = a.proposal
    JOIN access.editorial_revision r ON r.proposal = a.proposal AND r.n = a.revision
    WHERE a.id = NEW.application AND p.kind = 'merge' AND a.required = 2
      AND a.operation_key = NEW.task_key AND r.candidate_digest = NEW.candidate_digest
      AND r.candidate::jsonb = NEW.plan
      AND p.resource = NEW.plan->'source'->>'resource'
      AND NOT EXISTS (SELECT 1 FROM access.editorial_application_outcome o WHERE o.application = a.id)
      AND NOT EXISTS (SELECT 1 FROM access.editorial_decision d WHERE d.proposal = a.proposal)
  ) THEN RAISE EXCEPTION 'merge task differs from editorial application' USING ERRCODE = '23514'; END IF;
  IF NEW.original_key IS NOT NULL AND (NEW.original_key IS DISTINCT FROM NEW.plan->>'original'
    OR NOT EXISTS (SELECT 1 FROM access.identity_merge_task original
      WHERE original.task_key = NEW.original_key AND original.plan->>'operation' = 'merge'
        AND EXISTS (SELECT 1 FROM access.identity_merge_completion done WHERE done.task_key = original.task_key)
        AND original.plan->'source'->>'resource' = NEW.plan->'source'->>'resource'
        AND original.plan->'survivor'->>'resource' = NEW.plan->'survivor'->>'resource'
        AND original.data_epoch = NEW.data_epoch AND original.handlers = NEW.handlers)) THEN
    RAISE EXCEPTION 'unmerge task names another merge' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_merge_task_guard BEFORE INSERT ON access.identity_merge_task
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_task_guard();
CREATE TRIGGER identity_merge_task_immutable BEFORE UPDATE OR DELETE ON access.identity_merge_task
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();

CREATE TABLE access.identity_merge_page (
  task_key text NOT NULL REFERENCES access.identity_merge_task(task_key),
  owner text NOT NULL CHECK (owner ~ '^[a-z][a-z0-9-]{0,63}$'),
  page integer NOT NULL CHECK (page > 0),
  after_key text,
  next_key text,
  exhausted boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_key, owner, page),
  CHECK (exhausted = (next_key IS NULL)),
  CHECK (after_key IS NULL OR length(after_key) BETWEEN 1 AND 512),
  CHECK (next_key IS NULL OR length(next_key) BETWEEN 1 AND 512),
  CHECK (after_key IS NULL OR next_key IS NULL OR next_key COLLATE "C" > after_key COLLATE "C")
);
CREATE FUNCTION access.identity_merge_page_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior access.identity_merge_page%ROWTYPE;
BEGIN
  PERFORM 1 FROM access.identity_merge_task WHERE task_key = NEW.task_key FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM access.identity_merge_task t,
    jsonb_array_elements(t.handlers) h WHERE t.task_key = NEW.task_key AND h->>'owner' = NEW.owner) THEN
    RAISE EXCEPTION 'merge page names an unbound owner' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO prior FROM access.identity_merge_page
    WHERE task_key = NEW.task_key AND owner = NEW.owner ORDER BY page DESC LIMIT 1;
  IF NEW.page <> coalesce(prior.page, 0) + 1 OR prior.exhausted
    OR NEW.after_key IS DISTINCT FROM prior.next_key THEN
    RAISE EXCEPTION 'merge page is stale' USING ERRCODE = '23514';
  END IF;
  IF prior.page IS NOT NULL AND EXISTS (SELECT 1 FROM access.identity_merge_item i
    WHERE i.task_key = NEW.task_key AND i.owner = NEW.owner AND i.page = prior.page
      AND NOT EXISTS (SELECT 1 FROM access.identity_merge_item_outcome o
        WHERE (o.task_key,o.owner,o.item_key) = (i.task_key,i.owner,i.item_key))) THEN
    RAISE EXCEPTION 'merge owner page still has pending deliveries' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_merge_page_guard BEFORE INSERT ON access.identity_merge_page
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_page_guard();
CREATE TRIGGER identity_merge_page_immutable BEFORE UPDATE OR DELETE ON access.identity_merge_page
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
