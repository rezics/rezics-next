-- Private person-level relationships and activity votes. These are Access-only
-- commands: the head, aggregate and immutable receipt commit together.
CREATE TABLE access.follow_inventory (
  principal_id uuid PRIMARY KEY REFERENCES access.principal(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  active_count integer NOT NULL DEFAULT 0 CHECK (active_count BETWEEN 0 AND 1000)
);
CREATE TABLE access.follow (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  target text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('realm', 'zone', 'work', 'agent')),
  acting_subject text NOT NULL REFERENCES access.authority_subject(id),
  following boolean NOT NULL,
  revision uuid NOT NULL,
  PRIMARY KEY (principal_id, target)
);
CREATE INDEX follow_navigation ON access.follow (principal_id, kind, target) WHERE following;
CREATE INDEX follow_page ON access.follow (principal_id, target) WHERE following;
CREATE INDEX follow_public_count ON access.follow (target, principal_id) WHERE following;
CREATE TABLE access.follow_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);

-- The projection stores references, never title/body/profile copies. Its
-- checkpoint cannot pass the acknowledged Main outbox relay position.
CREATE TABLE access.feed_checkpoint (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  data_epoch text NOT NULL,
  sequence numeric NOT NULL CHECK (sequence >= 0),
  after_id text NOT NULL DEFAULT '',
  rebuild_epoch text,
  rebuild_after text NOT NULL DEFAULT '',
  revision uuid NOT NULL
);
CREATE TABLE access.feed_item (
  data_epoch text NOT NULL,
  id text NOT NULL,
  sequence numeric NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN ('work', 'contribution', 'adoption', 'decision', 'discussion', 'reply', 'collection')),
  occurred_at timestamptz NOT NULL,
  time_basis text NOT NULL CHECK (time_basis IN ('revision', 'relay')),
  score integer NOT NULL DEFAULT 0,
  best_key double precision NOT NULL,
  realm text,
  group_bucket text NOT NULL,
  group_key text NOT NULL,
  group_leader boolean NOT NULL,
  group_members text[] NOT NULL CHECK (cardinality(group_members) BETWEEN 1 AND 4),
  sort_time timestamptz NOT NULL,
  PRIMARY KEY (data_epoch, id)
);
CREATE INDEX feed_new ON access.feed_item (data_epoch, sort_time DESC, id DESC) WHERE group_leader;
CREATE INDEX feed_top ON access.feed_item (data_epoch, score DESC, sort_time DESC, id DESC) WHERE group_leader;
CREATE INDEX feed_best ON access.feed_item (data_epoch, best_key DESC, id DESC) WHERE group_leader;
CREATE INDEX feed_group_open ON access.feed_item (data_epoch, group_bucket, id DESC)
  WHERE group_leader AND cardinality(group_members) < 4;
CREATE TABLE access.feed_vote (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  target text NOT NULL,
  acting_subject text NOT NULL REFERENCES access.authority_subject(id),
  value integer NOT NULL CHECK (value IN (-1, 0, 1)),
  revision uuid NOT NULL,
  PRIMARY KEY (principal_id, target)
);
CREATE TABLE access.feed_vote_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE INDEX feed_vote_target ON access.feed_vote (target, principal_id);
-- Account deletion cascades private heads; keep every retained score coherent.
CREATE FUNCTION access.feed_vote_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.feed_checkpoint SET revision = gen_random_uuid() WHERE id;
  UPDATE access.feed_item SET score = score - OLD.value,
    best_key = sign(score - OLD.value) * log(1 + abs(score - OLD.value))
      + extract(epoch FROM occurred_at) / 86400
    WHERE id = OLD.target;
  RETURN OLD;
END $$;
CREATE INDEX feed_item_identity ON access.feed_item (id);
CREATE TRIGGER feed_vote_deleted AFTER DELETE ON access.feed_vote
  FOR EACH ROW EXECUTE FUNCTION access.feed_vote_deleted();
CREATE FUNCTION access.home_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'home command receipts are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER follow_receipt_immutable BEFORE UPDATE ON access.follow_receipt
  FOR EACH ROW EXECUTE FUNCTION access.home_receipt_immutable();
CREATE TRIGGER feed_vote_receipt_immutable BEFORE UPDATE ON access.feed_vote_receipt
  FOR EACH ROW EXECUTE FUNCTION access.home_receipt_immutable();
