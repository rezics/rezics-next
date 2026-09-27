-- Person-scoped review heads and exact command receipts. The rating inventory
-- is the authority for the linked observation; the review retains its revision.
CREATE TABLE access.reader_review_collection (
  context text NOT NULL,
  work text NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (context, work)
);

CREATE TABLE access.reader_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  acting_subject text NOT NULL REFERENCES access.authority_subject(id),
  context text NOT NULL,
  realm text,
  work text NOT NULL,
  main_version text NOT NULL,
  rating_observation text NOT NULL,
  rating_revision text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 10),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' AND length(language) <= 35),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  spoiler boolean NOT NULL,
  started_on date,
  finished_on date,
  revision uuid NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  helpful_count integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, context, work),
  CHECK (started_on IS NULL OR finished_on IS NULL OR started_on <= finished_on)
);
CREATE INDEX reader_review_new ON access.reader_review
  (context, work, created_at DESC, id DESC) WHERE NOT deleted;
CREATE INDEX reader_review_helpful ON access.reader_review
  (context, work, helpful_count DESC, created_at DESC, id DESC) WHERE NOT deleted;
CREATE INDEX reader_review_quote ON access.reader_review
  (realm, helpful_count DESC, created_at DESC, id DESC) WHERE NOT deleted AND NOT spoiler;

CREATE TABLE access.reader_review_vote (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES access.reader_review(id) ON DELETE CASCADE,
  helpful boolean NOT NULL,
  revision uuid NOT NULL,
  PRIMARY KEY (principal_id, review_id)
);
CREATE INDEX reader_review_vote_review ON access.reader_review_vote (review_id) WHERE helpful;

CREATE TABLE access.reader_review_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);

-- A retained owner sequence for future feed, notification and ranking readers.
-- The durable revision contains no review text; consumers recheck disclosure.
CREATE TABLE access.reader_review_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES access.reader_review(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'edited', 'deleted', 'helpful-changed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reader_review_event_review ON access.reader_review_event (review_id, sequence DESC);

CREATE FUNCTION access.reader_review_vote_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.helpful THEN
    UPDATE access.reader_review SET helpful_count = helpful_count - 1 WHERE id = OLD.review_id;
    UPDATE access.reader_review_collection SET revision = gen_random_uuid()
      WHERE (context, work) = (SELECT context, work FROM access.reader_review WHERE id = OLD.review_id);
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER reader_review_vote_deleted AFTER DELETE ON access.reader_review_vote
  FOR EACH ROW EXECUTE FUNCTION access.reader_review_vote_deleted();

CREATE FUNCTION access.reader_review_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review command receipts are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER reader_review_receipt_immutable BEFORE UPDATE ON access.reader_review_receipt
  FOR EACH ROW EXECUTE FUNCTION access.reader_review_receipt_immutable();
