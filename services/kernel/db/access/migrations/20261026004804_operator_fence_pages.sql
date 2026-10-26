-- migrate:up
CREATE TABLE access.operator_fence_page (
  route integer NOT NULL,
  continuation_id uuid NOT NULL,
  page_key text NOT NULL CHECK (page_key ~ '^[0-9a-f]{64}$'),
  cursor text,
  next_cursor text,
  allowlist jsonb NOT NULL CHECK (access.committed_continuation_entries(allowlist, 0, 101, false)),
  PRIMARY KEY (route, continuation_id, page_key),
  FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation (route, continuation_id)
);
CREATE FUNCTION access.operator_fence_page_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Operator fence pages are immutable';
END;
$$;
CREATE TRIGGER operator_fence_page_immutable BEFORE UPDATE OR DELETE ON access.operator_fence_page
FOR EACH ROW EXECUTE FUNCTION access.operator_fence_page_immutable();
-- migrate:down
DROP TABLE access.operator_fence_page;
DROP FUNCTION access.operator_fence_page_immutable();
