-- migrate:up
-- Private rule bodies have one retained copy, on the owning Collection row. Receipts and work carry no AST.
ALTER TABLE library.collection
  ADD COLUMN rule_filter jsonb,
  ADD COLUMN rule_sort text,
  ADD COLUMN rule_release_digest text,
  ADD COLUMN rule_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT collection_saved_rule CHECK (
    (rule_filter IS NULL AND rule_sort IS NULL AND rule_release_digest IS NULL AND rule_revision = 0)
    OR (membership_kind = 'dynamic' AND builtin_kind IS NULL AND curator_account_id IS NOT NULL
        AND jsonb_typeof(rule_filter) = 'object' AND rule_sort = 'id'
        AND rule_release_digest COLLATE "C" ~ '\Asha256:[0-9a-f]{64}\Z'
        AND octet_length(rule_release_digest) = 71 AND rule_revision > 0
        AND rule_filter IS NOT NULL AND rule_sort IS NOT NULL AND rule_release_digest IS NOT NULL)
  );

-- Existing account retention may retain a public header after removing its curator. Never retain its private rule.
CREATE FUNCTION library.minimize_collection_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.curator_account_id IS NULL THEN
    NEW.rule_filter := NULL;
    NEW.rule_sort := NULL;
    NEW.rule_release_digest := NULL;
    NEW.rule_revision := 0;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_rule_minimization BEFORE UPDATE OF curator_account_id ON library.collection
FOR EACH ROW EXECUTE FUNCTION library.minimize_collection_rule();

-- migrate:down
-- Forward only: rolling back must not discard saved owner rules.
