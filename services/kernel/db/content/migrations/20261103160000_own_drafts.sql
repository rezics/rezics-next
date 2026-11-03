-- migrate:up
-- Locator metadata only. Native posts and revisions remain the document authority.
ALTER TABLE content.post ADD COLUMN draft_locator_pending boolean NOT NULL DEFAULT true;
CREATE INDEX post_pending_draft_locator_idx ON content.post(author_account_id,route,post_id)
  WHERE draft_locator_pending AND visibility='draft' AND availability='available';
ALTER TABLE content.author_item
  ADD COLUMN draft_state text NOT NULL DEFAULT 'unknown'
    CHECK (draft_state IN ('unknown', 'draft', 'other')),
  ADD COLUMN draft_revision_id uuid,
  ADD COLUMN draft_language text CHECK (octet_length(draft_language) <= 256);

CREATE INDEX author_item_draft_page_idx
  ON content.author_item(route, author_account_id, created_at DESC, item_id)
  INCLUDE (thread_id, draft_revision_id, draft_language)
  WHERE item_kind = 'post' AND draft_state = 'draft';

CREATE TABLE content.own_draft_progress (
  singleton integer PRIMARY KEY CHECK (singleton = 0),
  after_route integer NOT NULL CHECK (after_route BETWEEN 0 AND 65535),
  after_thread uuid NOT NULL,
  after_post uuid NOT NULL,
  complete boolean NOT NULL DEFAULT false
);
INSERT INTO content.own_draft_progress(singleton, after_route, after_thread, after_post)
VALUES (0, 0, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');

CREATE OR REPLACE FUNCTION content.guard_author_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.author_account_id, NEW.item_kind, NEW.item_id, NEW.thread_id, NEW.thread_kind, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.route, OLD.author_account_id, OLD.item_kind, OLD.item_id, OLD.thread_id, OLD.thread_kind, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position)
     OR (ROW(NEW.source_epoch, NEW.source_position) = ROW(OLD.source_epoch, OLD.source_position)
         AND NOT (OLD.draft_state = 'unknown' AND NEW.draft_state <> 'unknown')) THEN
    RAISE EXCEPTION 'Author item identity, creation time and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: private locator state and bounded repair progress are retained.
