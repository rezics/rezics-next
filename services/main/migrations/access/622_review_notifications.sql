-- Review facts join the serialized, commit-ordered Access producer log.
ALTER TABLE access.notification_producer_event DROP CONSTRAINT notification_producer_event_kind_check;
ALTER TABLE access.notification_producer_event ADD CONSTRAINT notification_producer_event_kind_check
  CHECK (kind IN ('submission_decision', 'moderation_outcome', 'realm_role_change',
    'realm_membership_change', 'review_created', 'review_helpful_milestone'));
ALTER TABLE access.notification_display_context DROP CONSTRAINT notification_display_context_kind_check;
ALTER TABLE access.notification_display_context ADD CONSTRAINT notification_display_context_kind_check
  CHECK (kind IN ('reply', 'submission_decision', 'moderation_outcome', 'realm_role_change',
    'follow', 'claim_correction', 'review', 'review_helpful'));

CREATE TABLE access.reader_review_milestone (
  review_id uuid NOT NULL REFERENCES access.reader_review(id) ON DELETE CASCADE,
  milestone integer NOT NULL CHECK (milestone IN (5, 10, 25, 50, 100)),
  event_id uuid NOT NULL UNIQUE REFERENCES access.reader_review_event(id) ON DELETE CASCADE,
  PRIMARY KEY (review_id, milestone)
);
CREATE FUNCTION access.notify_reader_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _count integer;
BEGIN
  IF NEW.kind = 'created' THEN
    PERFORM access.append_notification_producer_event('review_created', NEW.id);
  ELSIF NEW.kind = 'helpful-changed' THEN
    SELECT helpful_count INTO _count FROM access.reader_review WHERE id = NEW.review_id;
    IF _count IN (5, 10, 25, 50, 100) THEN
      INSERT INTO access.reader_review_milestone (review_id, milestone, event_id)
        VALUES (NEW.review_id, _count, NEW.id) ON CONFLICT (review_id, milestone) DO NOTHING;
      IF FOUND THEN
        PERFORM access.append_notification_producer_event('review_helpful_milestone', NEW.id);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notify_reader_review AFTER INSERT ON access.reader_review_event
  FOR EACH ROW EXECUTE FUNCTION access.notify_reader_review();
