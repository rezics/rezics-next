-- migrate:up
-- Membership is a locator fact, never an authority for private structure heads.
ALTER TABLE content.author_item ADD COLUMN hosted_catalogue boolean NOT NULL DEFAULT false;
CREATE INDEX author_item_hosted_page_idx
  ON content.author_item(route,author_account_id,created_at DESC,item_id)
  INCLUDE (thread_id) WHERE item_kind='post' AND hosted_catalogue;

-- Existing catalogues are recovered in bounded primary-key pages. New ones leave
-- an indexed source obligation in the same transaction as their native creation.
ALTER TABLE content.post ADD COLUMN hosted_locator_pending boolean NOT NULL DEFAULT false;
CREATE INDEX post_hosted_pending_author_idx ON content.post(author_account_id,route,post_id)
  WHERE hosted_locator_pending;
CREATE INDEX post_hosted_pending_page_idx ON content.post(route,post_id)
  WHERE hosted_locator_pending;
CREATE FUNCTION content.mark_hosted_locator_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE content.post SET hosted_locator_pending=true
    WHERE route=NEW.route AND thread_id=NEW.thread_id AND post_id=NEW.catalogue_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hosted_locator_pending AFTER INSERT ON content.hosted_catalogue
  FOR EACH ROW EXECUTE FUNCTION content.mark_hosted_locator_pending();

-- Erasure delivery can remove the author locator. Restoration must leave a new
-- obligation even if its original catalogue creation was already acknowledged.
CREATE FUNCTION content.mark_restored_hosted_locator_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.availability='available' AND OLD.availability IS DISTINCT FROM NEW.availability
    AND EXISTS (SELECT 1 FROM content.hosted_catalogue
      WHERE route=NEW.route AND catalogue_id=NEW.post_id) THEN
    NEW.hosted_locator_pending=true;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER post_restored_hosted_locator BEFORE UPDATE OF availability ON content.post
  FOR EACH ROW EXECUTE FUNCTION content.mark_restored_hosted_locator_pending();

CREATE TABLE content.hosted_owned_progress (
  singleton integer PRIMARY KEY CHECK (singleton=0),
  after_route integer NOT NULL CHECK (after_route BETWEEN 0 AND 65535),
  after_catalogue uuid NOT NULL,
  complete boolean NOT NULL DEFAULT false
);
INSERT INTO content.hosted_owned_progress(singleton,after_route,after_catalogue)
  VALUES (0,0,'00000000-0000-0000-0000-000000000000');

CREATE OR REPLACE FUNCTION content.guard_author_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route,NEW.author_account_id,NEW.item_kind,NEW.item_id,NEW.thread_id,NEW.thread_kind,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.route,OLD.author_account_id,OLD.item_kind,OLD.item_id,OLD.thread_id,OLD.thread_kind,OLD.created_at)
     OR (OLD.hosted_catalogue AND NOT NEW.hosted_catalogue)
     OR ROW(NEW.source_epoch,NEW.source_position)<ROW(OLD.source_epoch,OLD.source_position)
     OR (ROW(NEW.source_epoch,NEW.source_position)=ROW(OLD.source_epoch,OLD.source_position)
         AND NOT (
           (OLD.draft_state='unknown' AND NEW.draft_state<>'unknown')
           OR (NOT OLD.hosted_catalogue AND NEW.hosted_catalogue
             AND ROW(NEW.draft_state,NEW.draft_revision_id,NEW.draft_language)
               IS NOT DISTINCT FROM ROW(OLD.draft_state,OLD.draft_revision_id,OLD.draft_language))
         )) THEN
    RAISE EXCEPTION 'Author item identity, creation time and source watermark cannot regress' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: locator facts and bounded recovery progress are retained.
