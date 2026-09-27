-- The origin is fixed by the admitted FIRST DRAFT, before reply identity or
-- Realm placement. Null is a separately public, pre-existing/global utterance.
ALTER TABLE content.reply_author ADD COLUMN origin_realm text
  CHECK (origin_realm ~ '^https://rezics\.com/id/[0-9a-f-]{36}$');
ALTER TABLE content.reply ADD COLUMN origin_realm text
  CHECK (origin_realm ~ '^https://rezics\.com/id/[0-9a-f-]{36}$');
CREATE INDEX reply_origin_page ON content.reply (origin_realm,root_target,root_revision,id);

CREATE FUNCTION content.guard_reply_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin text;
BEGIN
  SELECT origin_realm INTO origin FROM content.reply_author WHERE reply = NEW.id;
  IF NOT FOUND OR NEW.origin_realm IS DISTINCT FROM origin THEN
    RAISE EXCEPTION 'reply origin differs from its first draft' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_reply IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM content.reply p WHERE p.id = NEW.parent_reply
      AND p.origin_realm IS NOT DISTINCT FROM NEW.origin_realm
  ) THEN RAISE EXCEPTION 'reply parent belongs to another disclosure scope' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reply_origin_guard BEFORE INSERT ON content.reply
  FOR EACH ROW EXECUTE FUNCTION content.guard_reply_origin();
