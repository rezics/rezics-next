-- Topic-local recency, shared by readers. Never copy posts into reader inboxes.
ALTER TABLE access.feed_item ADD COLUMN target_indexed boolean NOT NULL DEFAULT false;
ALTER TABLE access.feed_item ADD COLUMN work text;
CREATE INDEX feed_target_backfill ON access.feed_item(data_epoch,id) WHERE NOT target_indexed;
CREATE INDEX feed_work_history ON access.feed_item(data_epoch,work,id);
CREATE INDEX feed_group_leader ON access.feed_item(data_epoch,group_key) WHERE group_leader;
CREATE TABLE access.feed_target (
  data_epoch text NOT NULL,
  target text NOT NULL,
  id text NOT NULL,
  sort_time timestamptz NOT NULL,
  kind text NOT NULL,
  work text,
  direct boolean NOT NULL DEFAULT false,
  author boolean NOT NULL DEFAULT false,
  PRIMARY KEY(data_epoch,target,id),
  FOREIGN KEY(data_epoch,id) REFERENCES access.feed_item(data_epoch,id) ON DELETE CASCADE
);
CREATE INDEX feed_target_recency ON access.feed_target(data_epoch,target,sort_time DESC,id DESC);
CREATE INDEX feed_target_kind_recency ON access.feed_target(data_epoch,target,kind,sort_time DESC,id DESC);
CREATE INDEX feed_target_authors ON access.feed_target(data_epoch,work,id) WHERE author;
CREATE TABLE access.feed_target_checkpoint (
  data_epoch text PRIMARY KEY,
  sequence numeric NOT NULL DEFAULT 0,
  after_event text NOT NULL DEFAULT '',
  revision uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE access.feed_author_dirty (
  data_epoch text NOT NULL,
  work text NOT NULL,
  after_id text NOT NULL DEFAULT '',
  PRIMARY KEY(data_epoch,work)
);
