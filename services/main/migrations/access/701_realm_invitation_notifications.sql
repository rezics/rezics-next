-- Invitation creation joins the same serialized notification producer log.
-- The recipient's current representation and the pending invitation are
-- rechecked by the notification subject owner before inbox disclosure.
ALTER TABLE access.notification_producer_event DROP CONSTRAINT notification_producer_event_kind_check;
ALTER TABLE access.notification_producer_event ADD CONSTRAINT notification_producer_event_kind_check
  CHECK (kind IN ('submission_decision', 'moderation_outcome', 'realm_role_change',
    'realm_membership_change', 'review_created', 'review_helpful_milestone', 'realm_invitation'));
ALTER TABLE access.notification_display_context DROP CONSTRAINT notification_display_context_kind_check;
ALTER TABLE access.notification_display_context ADD CONSTRAINT notification_display_context_kind_check
  CHECK (kind IN ('reply', 'submission_decision', 'moderation_outcome', 'realm_role_change',
    'follow', 'claim_correction', 'review', 'review_helpful', 'realm_invitation'));

CREATE FUNCTION access.notify_realm_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM access.append_notification_producer_event('realm_invitation', NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER notification_realm_invitation AFTER INSERT ON access.realm_invitation
  FOR EACH ROW EXECUTE FUNCTION access.notify_realm_invitation();
