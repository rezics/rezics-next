-- Public card metadata is an explicit Work-owner disclosure. Native captures stay in Content.
CREATE TABLE access.mod_work_binding (
  work text PRIMARY KEY CHECK (work ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  resolution_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  card jsonb NOT NULL CHECK (jsonb_typeof(card) = 'object'),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, resolution_id)
);

CREATE FUNCTION access.mod_work_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mod Work binding is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER mod_work_binding_immutable BEFORE UPDATE OR DELETE ON access.mod_work_binding
  FOR EACH ROW EXECUTE FUNCTION access.mod_work_binding_immutable();
