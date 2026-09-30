CREATE FUNCTION access.identity_merge_command_key(task text, owner text, item text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'merge:' || encode(sha256(convert_to('[' || to_json(task)::text || ',' ||
    to_json(owner)::text || ',' || to_json(item)::text || ']', 'UTF8')), 'hex')
$$;

CREATE TABLE access.identity_merge_item (
  task_key text NOT NULL,
  owner text NOT NULL,
  item_key text COLLATE "C" NOT NULL CHECK (length(item_key) BETWEEN 1 AND 512),
  page integer NOT NULL,
  expected_head text,
  before_state text NOT NULL CHECK (octet_length(before_state) <= 65536),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (task_key, owner, item_key),
  FOREIGN KEY (task_key, owner, page) REFERENCES access.identity_merge_page(task_key, owner, page)
);
CREATE INDEX identity_merge_item_page ON access.identity_merge_item(task_key, owner, page, item_key);
CREATE TABLE access.identity_merge_item_outcome (
  task_key text NOT NULL,
  owner text NOT NULL,
  item_key text COLLATE "C" NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('moved','history','retained','ambiguous')),
  command_key text NOT NULL UNIQUE,
  receipt text NOT NULL CHECK (length(receipt) BETWEEN 1 AND 512),
  after_head text,
  after_state text NOT NULL CHECK (octet_length(after_state) <= 65536),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_key, owner, item_key),
  FOREIGN KEY (task_key, owner, item_key) REFERENCES access.identity_merge_item(task_key, owner, item_key),
  CHECK (outcome <> 'moved' OR after_head IS NOT NULL),
  CHECK (command_key = access.identity_merge_command_key(task_key,owner,item_key))
);
CREATE INDEX identity_merge_outcome_compensation ON access.identity_merge_item_outcome(task_key, owner, item_key)
  WHERE outcome IN ('moved','history');
CREATE INDEX identity_merge_outcome_ambiguity ON access.identity_merge_item_outcome(task_key, owner, item_key)
  WHERE outcome = 'ambiguous';
CREATE TABLE access.identity_merge_completion (
  task_key text PRIMARY KEY REFERENCES access.identity_merge_task(task_key),
  receipt text NOT NULL CHECK (length(receipt) BETWEEN 1 AND 512),
  command_key text NOT NULL UNIQUE,
  result text NOT NULL CHECK (octet_length(result) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (command_key = access.identity_merge_command_key(task_key,'identity-merge','$finalize'))
);
CREATE FUNCTION access.identity_merge_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM access.identity_merge_task WHERE task_key = NEW.task_key FOR UPDATE;
  IF EXISTS (SELECT 1 FROM access.identity_merge_task t, jsonb_array_elements(t.handlers) h
    WHERE t.task_key = NEW.task_key AND NOT EXISTS (SELECT 1 FROM access.identity_merge_page p
      WHERE p.task_key = t.task_key AND p.owner = h->>'owner' AND p.exhausted))
    OR EXISTS (SELECT 1 FROM access.identity_merge_item i WHERE i.task_key = NEW.task_key
      AND NOT EXISTS (SELECT 1 FROM access.identity_merge_item_outcome o
        WHERE (o.task_key,o.owner,o.item_key) = (i.task_key,i.owner,i.item_key))) THEN
    RAISE EXCEPTION 'merge reconciliation is incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION access.identity_merge_append_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM access.identity_merge_task WHERE task_key = NEW.task_key FOR UPDATE;
  IF EXISTS (SELECT 1 FROM access.identity_merge_completion WHERE task_key = NEW.task_key) THEN
    RAISE EXCEPTION 'merge task already completed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION access.identity_merge_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE page_row access.identity_merge_page%ROWTYPE;
BEGIN
  PERFORM 1 FROM access.identity_merge_task WHERE task_key = NEW.task_key FOR UPDATE;
  SELECT * INTO page_row FROM access.identity_merge_page
    WHERE task_key = NEW.task_key AND owner = NEW.owner AND page = NEW.page;
  IF page_row.page IS NULL OR page_row.after_key IS NOT NULL AND NEW.item_key <= page_row.after_key COLLATE "C"
    OR page_row.next_key IS NOT NULL AND NEW.item_key > page_row.next_key COLLATE "C"
    OR (SELECT count(*) FROM access.identity_merge_item
      WHERE task_key = NEW.task_key AND owner = NEW.owner AND page = NEW.page) >= 32 THEN
    RAISE EXCEPTION 'merge item is outside the retained owner page' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_merge_item_guard BEFORE INSERT ON access.identity_merge_item
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_append_guard();
CREATE TRIGGER identity_merge_item_page_guard BEFORE INSERT ON access.identity_merge_item
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_item_guard();
CREATE TRIGGER identity_merge_outcome_guard BEFORE INSERT ON access.identity_merge_item_outcome
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_append_guard();
CREATE TRIGGER identity_merge_page_completed_guard BEFORE INSERT ON access.identity_merge_page
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_append_guard();
CREATE TRIGGER identity_merge_completion_guard BEFORE INSERT ON access.identity_merge_completion
  FOR EACH ROW EXECUTE FUNCTION access.identity_merge_completion_guard();
CREATE TRIGGER identity_merge_item_immutable BEFORE UPDATE OR DELETE ON access.identity_merge_item
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER identity_merge_outcome_immutable BEFORE UPDATE OR DELETE ON access.identity_merge_item_outcome
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER identity_merge_completion_immutable BEFORE UPDATE OR DELETE ON access.identity_merge_completion
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
