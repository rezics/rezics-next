-- Saved graph layouts are presentation state, never relation truth. The body
-- (positions, display groups) is an ordinary Content variant whose immutable
-- revisions use model graph-layout-v1 and the existing draft head CAS,
-- receipt, sequence and outbox. This row only binds that variant to its
-- declarative view: profile, anchor resource and optional Context.
CREATE TABLE content.graph_layout (
  id text PRIMARY KEY CHECK (id ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  variant_id text NOT NULL UNIQUE REFERENCES content.variant(id),
  owner_subject text NOT NULL CHECK (owner_subject ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  view_profile text NOT NULL CHECK (view_profile ~ '^https://rezics[.]com/definition/[a-z0-9-]+-v[0-9]+$'),
  anchor text NOT NULL CHECK (anchor ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  context text CHECK (context ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  -- The draft.save receipt that created the first layout revision.
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX graph_layout_anchor_idx ON content.graph_layout (anchor, owner_subject, id);
CREATE INDEX graph_layout_owner_idx ON content.graph_layout (owner_subject, id);

CREATE FUNCTION content.graph_layout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'immutable graph layout binding' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content.variant v JOIN content.receipt r ON r.variant_id = v.id
      WHERE v.id = NEW.variant_id AND v.resource_id = NEW.id AND v.language_kind = 'zxx'
        AND v.direction = 'none' AND r.operation_id = NEW.operation_id
        AND r.action = 'draft.save' AND r.outcome = 'succeeded') THEN
    RAISE EXCEPTION 'graph layout requires its own non-linguistic variant and first save'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER graph_layout_guard BEFORE INSERT OR UPDATE OR DELETE ON content.graph_layout
  FOR EACH ROW EXECUTE FUNCTION content.graph_layout_guard();
