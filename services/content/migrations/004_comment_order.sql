CREATE SEQUENCE content.comment_list_order_seq;
ALTER TABLE content.comment ADD COLUMN list_order bigint NOT NULL
  DEFAULT nextval('content.comment_list_order_seq');
ALTER SEQUENCE content.comment_list_order_seq OWNED BY content.comment.list_order;
CREATE UNIQUE INDEX comment_list_order_idx ON content.comment (list_order);
CREATE INDEX comment_revision_list_idx ON content.comment (revision_id, list_order);
