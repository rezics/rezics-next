-- migrate:up
CREATE INDEX bulk_target_erasure_owner ON library.bulk_target (route, account_id, operation_id, ordinal);
CREATE INDEX bulk_effect_erasure_owner ON library.bulk_effect (route, account_id, operation_id, ordinal);
ALTER TABLE library.collection ALTER COLUMN curator_account_id DROP NOT NULL;
ALTER TABLE library.collection ADD CONSTRAINT collection_deidentified_public CHECK
  (curator_account_id IS NOT NULL OR (state='active' AND visibility='public'));

CREATE FUNCTION library.guard_retained_collection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.curator_account_id IS NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Deidentified public contribution is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_retained_immutable BEFORE UPDATE ON library.collection
  FOR EACH ROW EXECUTE FUNCTION library.guard_retained_collection();
CREATE FUNCTION library.guard_retained_collection_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_route integer;
  parent_id uuid;
  curator uuid;
BEGIN
  IF TG_OP='DELETE' THEN parent_route:=OLD.route; parent_id:=OLD.collection_id;
  ELSE parent_route:=NEW.route; parent_id:=NEW.collection_id; END IF;
  SELECT curator_account_id INTO curator FROM library.collection
    WHERE route=parent_route AND collection_id=parent_id FOR SHARE;
  IF FOUND AND curator IS NULL THEN
    RAISE EXCEPTION 'Deidentified public contribution is immutable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER collection_member_retained_immutable BEFORE INSERT OR UPDATE OR DELETE ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.guard_retained_collection_member();

-- migrate:down
DROP TRIGGER collection_member_retained_immutable ON library.collection_member;
DROP FUNCTION library.guard_retained_collection_member();
DROP TRIGGER collection_retained_immutable ON library.collection;
DROP FUNCTION library.guard_retained_collection();
ALTER TABLE library.collection DROP CONSTRAINT collection_deidentified_public;
-- Deidentified contributions cannot regain an account identity on downgrade.
DROP INDEX library.bulk_effect_erasure_owner;
DROP INDEX library.bulk_target_erasure_owner;
