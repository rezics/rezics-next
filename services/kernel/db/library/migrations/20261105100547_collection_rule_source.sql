-- migrate:up
ALTER TABLE library.collection ADD COLUMN rule_source text;
UPDATE library.collection SET rule_source = 'owner' WHERE rule_filter IS NOT NULL;
ALTER TABLE library.collection
  ADD CONSTRAINT collection_saved_rule_source CHECK (
    (rule_filter IS NULL AND rule_source IS NULL)
    OR (rule_filter IS NOT NULL AND rule_source IS NOT NULL AND rule_source IN ('owner', 'catalogue'))
  );

CREATE OR REPLACE FUNCTION library.minimize_collection_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.curator_account_id IS NULL THEN
    NEW.rule_filter := NULL;
    NEW.rule_sort := NULL;
    NEW.rule_source := NULL;
    NEW.rule_release_digest := NULL;
    NEW.rule_revision := 0;
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: dropping this column would discard the retained source meaning of saved catalogue rules.
