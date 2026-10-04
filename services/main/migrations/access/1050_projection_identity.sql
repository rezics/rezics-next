-- One identity per subject and sorted frame set. `key` is the SHA-256 of the
-- subject and frames joined by newlines, so many principals meeting the same
-- subject in the same frame at once reserve one UUID: the first insert wins and
-- the rest adopt it. The row is written by the admitted command that creates the
-- graph Resource, and records that admission; it is never edited or removed.
CREATE TABLE access.projection_identity (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  projection uuid NOT NULL UNIQUE,
  subject text NOT NULL CHECK (subject ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  frames text[] NOT NULL CHECK (cardinality(frames) BETWEEN 1 AND 8
    AND array_position(frames, NULL) IS NULL AND NOT subject = ANY(frames)),
  admission_id uuid NOT NULL REFERENCES access.admission(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT projection_identity_key CHECK (key = encode(sha256(convert_to(
    subject || E'\n' || array_to_string(frames, E'\n'), 'UTF8')), 'hex'))
);

-- A subject's projections page by keyset in time order (UUIDv7), whatever their number.
CREATE INDEX projection_identity_subject ON access.projection_identity (subject, projection);

CREATE FUNCTION access.reject_projection_identity_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Projection identities are append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER projection_identity_immutable BEFORE UPDATE OR DELETE
  ON access.projection_identity FOR EACH ROW
  EXECUTE FUNCTION access.reject_projection_identity_mutation();
