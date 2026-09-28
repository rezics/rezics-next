-- Feed projection and vote commands append bounded, immutable notification
-- facts in the same Access transaction as their source. The producer rechecks
-- follows, author authority and current disclosure before publishing an item.
ALTER TABLE access.notification_producer_event DROP CONSTRAINT notification_producer_event_kind_check;
ALTER TABLE access.notification_producer_event ADD CONSTRAINT notification_producer_event_kind_check
  CHECK (kind IN ('submission_decision', 'moderation_outcome', 'realm_role_change',
    'realm_membership_change', 'review_created', 'review_helpful_milestone', 'realm_invitation',
    'chapter_published', 'feed_post_vote'));

ALTER TABLE access.notification_display_context DROP CONSTRAINT notification_display_context_kind_check;
ALTER TABLE access.notification_display_context ADD CONSTRAINT notification_display_context_kind_check
  CHECK (kind IN ('reply', 'submission_decision', 'moderation_outcome', 'realm_role_change',
    'follow', 'claim_correction', 'review', 'review_helpful', 'realm_invitation',
    'chapter', 'post_vote'));

CREATE TABLE access.chapter_notification_event (
  id uuid PRIMARY KEY,
  activity text NOT NULL UNIQUE,
  work text NOT NULL,
  author text NOT NULL,
  occurrence text NOT NULL,
  content_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE access.feed_post_vote_event (
  id uuid PRIMARY KEY,
  target text NOT NULL,
  author text NOT NULL,
  voter text NOT NULL,
  voter_principal uuid NOT NULL REFERENCES access.principal(id),
  vote_revision uuid NOT NULL UNIQUE,
  work text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
