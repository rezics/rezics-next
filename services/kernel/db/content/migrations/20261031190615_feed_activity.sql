-- migrate:up
CREATE TABLE content.feed_activity (
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  target_type text NOT NULL CHECK(target_type IN ('subject','collection','space')),
  target_id uuid NOT NULL,
  activity_id text NOT NULL CHECK(octet_length(activity_id)<=512),
  occurred_at timestamptz NOT NULL,
  activity jsonb NOT NULL,
  PRIMARY KEY(route,target_type,target_id,activity_id),
  CHECK(route=get_byte(uuid_send(target_id),10)*256+get_byte(uuid_send(target_id),11))
);
CREATE INDEX feed_activity_recent ON content.feed_activity(route,target_type,target_id,occurred_at DESC,activity_id DESC);
CREATE INDEX feed_activity_expiry ON content.feed_activity(partition_no,occurred_at,route,target_type,target_id,activity_id);
CREATE TABLE content.feed_inbox (
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  account_id uuid NOT NULL,
  activity_id text NOT NULL CHECK(octet_length(activity_id)<=512),
  occurred_at timestamptz NOT NULL,
  activity jsonb NOT NULL,
  PRIMARY KEY(route,account_id,activity_id),
  CHECK(route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))
);
CREATE INDEX feed_inbox_recent ON content.feed_inbox(route,account_id,occurred_at DESC,activity_id DESC);
CREATE INDEX feed_inbox_expiry ON content.feed_inbox(partition_no,occurred_at,route,account_id,activity_id);
COMMENT ON TABLE content.feed_activity IS 'Body-free retained candidate references. The original owner and current follow authorize every read.';
COMMENT ON TABLE content.feed_inbox IS 'Private recent candidate inbox, capped at 2000 references and read only within 30 days. No discovery authority.';
-- migrate:down
DROP TABLE content.feed_inbox;
DROP TABLE content.feed_activity;
