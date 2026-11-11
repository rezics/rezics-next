-- migrate:up
-- Hosted structures borrow their anchor Post's home and authority; they store no body copies.
CREATE TABLE content.hosted_catalogue (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  catalogue_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  head_revision_id uuid NOT NULL,
  publication_id uuid,
  PRIMARY KEY (route, catalogue_id),
  FOREIGN KEY (route, thread_id, catalogue_id) REFERENCES content.post(route, thread_id, post_id),
  CHECK (route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11))
);

CREATE TABLE content.hosted_structure_revision (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('structure', 'publication')),
  source_revision_id uuid,
  recorded_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id) REFERENCES content.hosted_catalogue(route, catalogue_id),
  FOREIGN KEY (route, catalogue_id, source_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  CHECK ((kind = 'structure') = (source_revision_id IS NULL)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11))
);
ALTER TABLE content.hosted_catalogue
  ADD FOREIGN KEY (route, catalogue_id, head_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id) DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY (route, catalogue_id, publication_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id) DEFERRABLE INITIALLY DEFERRED;

-- An occurrence cannot be recycled for another Post after removal.
CREATE TABLE content.hosted_occurrence (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('part', 'chapter')),
  thread_id uuid,
  post_id uuid,
  PRIMARY KEY (route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id) REFERENCES content.hosted_catalogue(route, catalogue_id),
  CHECK ((kind = 'part' AND thread_id IS NULL AND post_id IS NULL)
      OR (kind = 'chapter' AND thread_id IS NOT NULL AND post_id IS NOT NULL)),
  CHECK (thread_id IS NULL OR
    get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11) =
    get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(occurrence_id), 10) * 256 + get_byte(uuid_send(occurrence_id), 11))
);

CREATE TABLE content.hosted_placement (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  parent_id uuid,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 511),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 511),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  target_revision_id uuid,
  body_sha256 bytea,
  PRIMARY KEY (route, catalogue_id, revision_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, occurrence_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, revision_id, parent_id)
    REFERENCES content.hosted_placement(route, catalogue_id, revision_id, occurrence_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE NULLS NOT DISTINCT (route, catalogue_id, revision_id, parent_id, position),
  UNIQUE (route, catalogue_id, revision_id, ordinal),
  CHECK ((target_revision_id IS NULL AND body_sha256 IS NULL)
      OR (target_revision_id IS NOT NULL AND body_sha256 IS NOT NULL AND octet_length(body_sha256) = 32))
);
CREATE INDEX hosted_placement_navigation_idx
  ON content.hosted_placement(route, catalogue_id, revision_id, ordinal)
  WHERE target_revision_id IS NOT NULL;

CREATE FUNCTION content.guard_hosted_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hosted occurrence identities and snapshots are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER hosted_structure_immutable BEFORE UPDATE OR DELETE ON content.hosted_structure_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();
CREATE TRIGGER hosted_occurrence_immutable BEFORE UPDATE OR DELETE ON content.hosted_occurrence
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();
CREATE TRIGGER hosted_placement_immutable BEFORE UPDATE OR DELETE ON content.hosted_placement
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();

-- migrate:down
ALTER TABLE content.hosted_catalogue DROP CONSTRAINT hosted_catalogue_route_catalogue_id_head_revision_id_fkey;
ALTER TABLE content.hosted_catalogue DROP CONSTRAINT hosted_catalogue_route_catalogue_id_publication_id_fkey;
DROP TABLE content.hosted_placement;
DROP TABLE content.hosted_occurrence;
DROP TABLE content.hosted_structure_revision;
DROP TABLE content.hosted_catalogue;
DROP FUNCTION content.guard_hosted_snapshot();
