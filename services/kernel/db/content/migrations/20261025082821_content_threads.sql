-- migrate:up
CREATE SCHEMA content;

-- Boards and their semantic concepts are separate identities. External references
-- (board, account and subject IDs) deliberately have no cross-partition foreign keys.
CREATE TABLE content.board (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  title text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private', 'taken_down')),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, board_id),
  CHECK (route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11))
);

CREATE TABLE content.thread (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  author_account_id uuid NOT NULL,
  board_id uuid NOT NULL,
  title text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private', 'taken_down')),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, thread_id),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11))
);

CREATE TABLE content.post (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  post_id uuid NOT NULL,
  reply_to_post_id uuid,
  author_account_id uuid NOT NULL,
  head_revision_id uuid NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private', 'taken_down')),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, post_id),
  UNIQUE (route, thread_id, post_id),
  FOREIGN KEY (route, thread_id) REFERENCES content.thread (route, thread_id),
  FOREIGN KEY (route, thread_id, reply_to_post_id) REFERENCES content.post (route, thread_id, post_id),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (route = get_byte(uuid_send(reply_to_post_id), 10) * 256 + get_byte(uuid_send(reply_to_post_id), 11)),
  CHECK (route = get_byte(uuid_send(head_revision_id), 10) * 256 + get_byte(uuid_send(head_revision_id), 11)),
  CHECK (reply_to_post_id <> post_id)
);

-- Bodies are canonical UTF-8 document bytes. Semantic validation of documents,
-- SPDX expressions and subject references belongs to the document adapter.
CREATE TABLE content.revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  post_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  body bytea COMPRESSION lz4,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  search_text text,
  licence text NOT NULL,
  subject_ids uuid[] NOT NULL,
  board_id uuid NOT NULL,
  availability text NOT NULL CHECK (availability IN ('available', 'erased')),
  recorded_transaction_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (route, revision_id),
  UNIQUE (route, thread_id, post_id, revision_id),
  FOREIGN KEY (route, thread_id, post_id) REFERENCES content.post (route, thread_id, post_id),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CONSTRAINT revision_body_size_limit CHECK (octet_length(body) <= 2097152),
  CONSTRAINT revision_body_sha256_matches CHECK (body_sha256 = sha256(body)),
  CHECK ((availability = 'erased' AND body IS NULL AND search_text IS NULL)
      OR (availability = 'available' AND body IS NOT NULL AND search_text IS NOT NULL))
);

-- A first post and its revision are inserted in one caller-owned transaction.
ALTER TABLE content.post ADD CONSTRAINT post_head_revision_fk
  FOREIGN KEY (route, thread_id, post_id, head_revision_id)
  REFERENCES content.revision (route, thread_id, post_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION content.guard_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> column_name IS DISTINCT FROM to_jsonb(OLD) -> column_name THEN
      RAISE EXCEPTION 'Content identity and containment are immutable' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.visibility IS DISTINCT FROM OLD.visibility AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Visibility changes require an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER board_identity BEFORE UPDATE ON content.board
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'board_id', 'subject_id');
CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'author_account_id');
CREATE TRIGGER post_identity BEFORE UPDATE ON content.post
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'post_id', 'reply_to_post_id', 'author_account_id');

-- An edit appends a new exact revision ID. Erasure is the only in-place change:
-- it removes bytes and search text while keeping the original digest and metadata.
CREATE FUNCTION content.guard_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Revision identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.thread_id, NEW.post_id, NEW.revision_id, NEW.body_sha256,
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id, OLD.body_sha256,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR NEW.body IS NOT NULL OR NEW.search_text IS NOT NULL THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER revision_immutable BEFORE UPDATE OR DELETE ON content.revision
FOR EACH ROW EXECUTE FUNCTION content.guard_revision();

-- migrate:down
-- Forward only: content identities and exact revision history must survive rollback.
