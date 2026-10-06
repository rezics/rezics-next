-- Accumulated public counts cannot recheck an unbounded prefix of Works.
-- Read-gate and moderation changes invalidate their cut atomically instead.
CREATE TABLE access.disclosure_revision (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO access.disclosure_revision DEFAULT VALUES;

CREATE FUNCTION access.advance_disclosure_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb;
BEGIN
  IF TG_OP <> 'TRUNCATE' THEN
    old_row := to_jsonb(OLD); new_row := to_jsonb(NEW);
    IF TG_OP = 'UPDATE' AND new_row IS NOT DISTINCT FROM old_row THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME = 'scope_gate' THEN
      IF NOT (coalesce(old_row->>'id','') LIKE 'work:read:%'
        OR coalesce(new_row->>'id','') LIKE 'work:read:%') THEN RETURN NULL; END IF;
      -- Missing and open gates have the same public disclosure meaning.
      IF TG_OP = 'INSERT' AND (new_row->>'open')::boolean
        OR TG_OP = 'DELETE' AND (old_row->>'open')::boolean THEN RETURN NULL; END IF;
      IF TG_OP = 'UPDATE' AND (old_row->>'id',old_row->>'open')
        IS NOT DISTINCT FROM (new_row->>'id',new_row->>'open') THEN RETURN NULL; END IF;
    ELSIF TG_TABLE_NAME = 'governance_enforcement' THEN
      IF NOT (coalesce(old_row->>'effect' = 'disclosure' AND old_row->>'state' = 'restricted',false)
        OR coalesce(new_row->>'effect' = 'disclosure' AND new_row->>'state' = 'restricted',false)) THEN RETURN NULL; END IF;
    END IF;
  END IF;
  -- One bump covers all changes in the transaction; savepoint rollback restores
  -- both this mark and the revision. Ordinary library/progress writes never bump it.
  IF current_setting('rezics.disclosure_revision_changed',true) = 'on' THEN RETURN NULL; END IF;
  UPDATE access.disclosure_revision SET revision = revision + 1 WHERE id;
  PERFORM set_config('rezics.disclosure_revision_changed','on',true);
  RETURN NULL;
END $$;

DO $$ DECLARE source text; BEGIN
  FOREACH source IN ARRAY ARRAY['scope_gate','governance_enforcement','recovery_fence'] LOOP
    EXECUTE format('CREATE TRIGGER disclosure_revision_changed AFTER INSERT OR UPDATE OR DELETE
      ON access.%I FOR EACH ROW EXECUTE FUNCTION access.advance_disclosure_revision()',source);
    EXECUTE format('CREATE TRIGGER disclosure_revision_truncated AFTER TRUNCATE
      ON access.%I FOR EACH STATEMENT EXECUTE FUNCTION access.advance_disclosure_revision()',source);
  END LOOP;
END $$;
