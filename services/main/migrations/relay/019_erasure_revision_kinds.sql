-- The live erasure operation tombstones every revision kind reads already
-- honour. Keep every existing owner pair and add the graph revision kinds.
-- This stays in the erasure-journal series so it runs after 010 creates
-- relay.erasure_target, including the upgrade that applies that series onto
-- the earlier relay head.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint AS con
  WHERE con.conrelid = 'relay.erasure_target'::regclass
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%semantic_revision%'
    AND pg_get_constraintdef(con.oid) NOT LIKE '%text_contribution_draft%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'erasure target pair check is missing';
  END IF;
  EXECUTE format('ALTER TABLE relay.erasure_target DROP CONSTRAINT %I', constraint_name);
END $$;

ALTER TABLE relay.erasure_target ADD CONSTRAINT erasure_target_kind_owner
  CHECK ((target_kind, owner) IN (
    ('principal', 'access'),
    ('content_revision', 'content'),
    ('content_variant', 'content'),
    ('semantic_revision', 'graph'),
    ('resource', 'graph'),
    ('source_observation', 'source'),
    ('object', 'object'),
    ('text_contribution_draft', 'graph'),
    ('release_revision', 'graph'),
    ('work_head', 'graph'),
    ('composition_revision', 'graph')));
