-- migrate:up
-- Additive: no legacy placement, revision, receipt or publication is rewritten.
-- The sealed base revision is also the append stream identity. The empty base
-- descriptor is installed lazily under the ordinary catalogue head lock.
CREATE TABLE content.hosted_append_descriptor (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  base_revision_id uuid NOT NULL,
  base_placement_count bigint NOT NULL,
  base_root_count bigint NOT NULL,
  high_water bigint NOT NULL,
  PRIMARY KEY (route, catalogue_id, revision_id),
  CONSTRAINT hosted_append_descriptor_counts_key
    UNIQUE (route, catalogue_id, revision_id, base_placement_count, base_root_count),
  CONSTRAINT hosted_append_descriptor_revision_fk
    FOREIGN KEY (route, catalogue_id, revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  -- Repeated counts must agree with the retained sealed base. This also keeps
  -- the base alive while any immutable descriptor uses it.
  CONSTRAINT hosted_append_descriptor_base_fk
    FOREIGN KEY (route, catalogue_id, base_revision_id, base_placement_count, base_root_count)
    REFERENCES content.hosted_append_descriptor
      (route, catalogue_id, revision_id, base_placement_count, base_root_count),
  CONSTRAINT hosted_append_descriptor_counts_check CHECK (
    base_placement_count BETWEEN 0 AND 9007199254740991
    AND base_root_count BETWEEN 0 AND base_placement_count
    AND high_water BETWEEN -1 AND 9007199254740990
    AND base_placement_count + high_water + 1 <= 9007199254740991
    AND base_root_count + high_water + 1 <= 9007199254740991
  ),
  CONSTRAINT hosted_append_descriptor_base_check CHECK (
    (revision_id = base_revision_id) = (high_water = -1)
  )
);

CREATE TABLE content.hosted_append (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  append_offset bigint NOT NULL CHECK (append_offset BETWEEN 0 AND 9007199254740990),
  revision_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  target_revision_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  PRIMARY KEY (route, catalogue_id, stream_id, append_offset),
  CONSTRAINT hosted_append_occurrence_key UNIQUE (route, catalogue_id, stream_id, occurrence_id),
  CONSTRAINT hosted_append_revision_key UNIQUE (route, catalogue_id, revision_id),
  CONSTRAINT hosted_append_stream_fk FOREIGN KEY (route, catalogue_id, stream_id)
    REFERENCES content.hosted_append_descriptor(route, catalogue_id, revision_id),
  CONSTRAINT hosted_append_revision_fk FOREIGN KEY (route, catalogue_id, revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  CONSTRAINT hosted_append_occurrence_fk FOREIGN KEY (route, catalogue_id, occurrence_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id)
);

-- Full prefixes permit bounded retained-base, stream and occurrence cleanup
-- discovery. Deletion remains with the native lifecycle; there is no cascade.
CREATE INDEX hosted_append_descriptor_base_idx
  ON content.hosted_append_descriptor(route, catalogue_id, base_revision_id, revision_id);
CREATE INDEX hosted_append_occurrence_idx
  ON content.hosted_append(route, catalogue_id, occurrence_id, stream_id);
CREATE TRIGGER hosted_append_descriptor_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_append_descriptor
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();
CREATE TRIGGER hosted_append_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_append
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();

-- migrate:down
-- A deployed writer must first be retired. Once append data exists, dropping it
-- would silently turn exact drafts into empty legacy snapshots. Refuse rollback
-- even if a later replacement changed the head: retained drafts still use it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_append LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted append storage with retained append rows' USING ERRCODE = '23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_append;
DROP TABLE content.hosted_append_descriptor;
