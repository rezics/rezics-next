-- migrate:up
-- Accounts selected invocation associations. SDK execution ownership remains SDK-owned.
CREATE TABLE core.operational_work_selection (
  partition_no integer NOT NULL,
  workflow_id text COLLATE "C" NOT NULL CHECK(octet_length(workflow_id)<=256),
  function_id integer NOT NULL CHECK(function_id BETWEEN 0 AND 63),
  custody_id uuid NOT NULL,
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535 AND partition_no=(route >> 4)),
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  attempt_generation bigint NOT NULL CHECK(attempt_generation>0),
  restore_generation uuid NOT NULL,
  deadline bigint NOT NULL CHECK(deadline>0),
  original_digest bytea NOT NULL CHECK(octet_length(original_digest)=32),
  selected_tuple jsonb NOT NULL CHECK(octet_length(selected_tuple::text)<=2097152),
  result jsonb CHECK(result IS NULL OR (octet_length(result::text)<=4096 AND result->>'kind' IN ('complete','continue','failure','obsolete'))),
  PRIMARY KEY(partition_no,workflow_id,function_id),
  FOREIGN KEY(partition_no,custody_id) REFERENCES core.operational_work_original(partition_no,custody_id),
  FOREIGN KEY(partition_no,route,owner_account_id,collection_id,episode_id)
    REFERENCES core.operational_work_episode(partition_no,route,owner_account_id,collection_id,episode_id)
);
CREATE TABLE core.operational_work_selected_continuation (
  partition_no integer NOT NULL,
  workflow_id text COLLATE "C" NOT NULL CHECK(octet_length(workflow_id)<=256),
  custody_id uuid NOT NULL,
  parent_workflow_id text COLLATE "C" NOT NULL,
  parent_function_id integer NOT NULL,
  route integer NOT NULL,
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  sdk_input_digest bytea NOT NULL CHECK(octet_length(sdk_input_digest)=32),
  sdk_creator text NOT NULL CHECK(octet_length(sdk_creator)<=256),
  PRIMARY KEY(partition_no,workflow_id),
  FOREIGN KEY(partition_no,parent_workflow_id,parent_function_id)
    REFERENCES core.operational_work_selection(partition_no,workflow_id,function_id),
  FOREIGN KEY(partition_no,custody_id) REFERENCES core.operational_work_original(partition_no,custody_id)
);
CREATE FUNCTION core.operational_work_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'selected operational association is permanent' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='operational_work_selection' THEN
    IF OLD.result IS NULL AND NEW.result IS NOT NULL AND
       (to_jsonb(OLD)-'result')=(to_jsonb(NEW)-'result') THEN RETURN NEW; END IF;
  END IF;
  IF OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'selected operational association is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_selection_guard BEFORE UPDATE OR DELETE ON core.operational_work_selection
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_selection_guard();
CREATE TRIGGER operational_work_selection_no_truncate BEFORE TRUNCATE ON core.operational_work_selection
  FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_selection_guard();
CREATE TRIGGER operational_work_selected_continuation_guard BEFORE UPDATE OR DELETE ON core.operational_work_selected_continuation
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_selection_guard();
CREATE TRIGGER operational_work_selected_continuation_no_truncate BEFORE TRUNCATE ON core.operational_work_selected_continuation
  FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_selection_guard();
CREATE FUNCTION core.operational_work_selected_continuation_bound() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent core.operational_work_selection;
BEGIN
  SELECT * INTO parent FROM core.operational_work_selection
    WHERE partition_no=NEW.partition_no AND workflow_id=NEW.parent_workflow_id AND function_id=NEW.parent_function_id FOR SHARE;
  IF NOT FOUND OR parent.result->>'kind' IS DISTINCT FROM 'continue' OR
     parent.result->>'continuation' IS DISTINCT FROM NEW.workflow_id OR
     (parent.custody_id,parent.route,parent.owner_account_id,parent.collection_id,parent.episode_id) IS DISTINCT FROM
     (NEW.custody_id,NEW.route,NEW.owner_account_id,NEW.collection_id,NEW.episode_id) THEN
    RAISE EXCEPTION 'selected continuation lacks atomic parent result' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER operational_work_selected_continuation_bound AFTER INSERT ON core.operational_work_selected_continuation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.operational_work_selected_continuation_bound();
ALTER TABLE core.operational_work_selection ENABLE ALWAYS TRIGGER operational_work_selection_guard;
ALTER TABLE core.operational_work_selection ENABLE ALWAYS TRIGGER operational_work_selection_no_truncate;
ALTER TABLE core.operational_work_selected_continuation ENABLE ALWAYS TRIGGER operational_work_selected_continuation_guard;
ALTER TABLE core.operational_work_selected_continuation ENABLE ALWAYS TRIGGER operational_work_selected_continuation_no_truncate;
ALTER TABLE core.operational_work_selected_continuation ENABLE ALWAYS TRIGGER operational_work_selected_continuation_bound;

-- migrate:down
-- Forward only: once-only spending and uncertain commit reconciliation cannot be undone.
