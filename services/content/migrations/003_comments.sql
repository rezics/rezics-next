ALTER TABLE content.receipt DROP CONSTRAINT receipt_action_check;
ALTER TABLE content.receipt ADD CONSTRAINT receipt_action_check
  CHECK (action IN ('draft.save', 'publication.prepare', 'publication.settle', 'comment.create'));

CREATE TABLE content.comment (
  id uuid PRIMARY KEY,
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  revision_id uuid NOT NULL REFERENCES content.revision(id),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 300),
  variant_id text NOT NULL REFERENCES content.variant(id),
  author text NOT NULL CHECK (length(author) BETWEEN 1 AND 300),
  exact text NOT NULL CHECK (length(exact) BETWEEN 1 AND 4096),
  prefix text NOT NULL CHECK (length(prefix) <= 32),
  suffix text NOT NULL CHECK (length(suffix) <= 32),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8192),
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_epoch, sequence),
  FOREIGN KEY (data_epoch, sequence) REFERENCES content.receipt(data_epoch, sequence)
);
CREATE INDEX comment_revision_idx ON content.comment (revision_id, id);
CREATE TRIGGER comment_immutable BEFORE UPDATE OR DELETE ON content.comment
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
