-- migrate:up
-- A moderation decision may name one immutable Post revision. The separate
-- policy ledger retains each decision and reversal while at most one is live.
ALTER TABLE content.moderation_decision
  ADD COLUMN revision_id uuid,
  ADD CONSTRAINT moderation_decision_revision_target_check
    CHECK (revision_id IS NULL OR target_kind = 'post'),
  ADD CONSTRAINT moderation_decision_revision_fk
    FOREIGN KEY (route, revision_id) REFERENCES content.revision (route, revision_id),
  ADD CONSTRAINT moderation_decision_revision_identity_key
    UNIQUE (route, decision_id, revision_id, target_id);

CREATE TABLE content.post_revision_restriction (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  decision_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  post_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('public', 'hard')),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  restricted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lifted_at timestamptz,
  PRIMARY KEY (route, decision_id),
  FOREIGN KEY (route, thread_id, post_id, revision_id)
    REFERENCES content.revision (route, thread_id, post_id, revision_id),
  FOREIGN KEY (route, decision_id, revision_id, post_id)
    REFERENCES content.moderation_decision (route, decision_id, revision_id, target_id),
  CHECK (route = get_byte(uuid_send(decision_id), 10) * 256 + get_byte(uuid_send(decision_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11))
);

CREATE UNIQUE INDEX post_revision_restriction_live_revision_key
  ON content.post_revision_restriction (route, revision_id) WHERE lifted_at IS NULL;
CREATE INDEX post_revision_restriction_decision_idx
  ON content.post_revision_restriction (route, decision_id, revision_id);

-- migrate:down
-- Forward only: moderation evidence and exact-version denials are retained.
