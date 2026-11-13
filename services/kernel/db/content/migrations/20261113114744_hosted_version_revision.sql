-- migrate:up
-- Each external Book revision names one exact generation sequence; compatibility revisions have no row here.
ALTER TABLE content.hosted_structure_revision
  ADD CONSTRAINT hosted_structure_revision_identity_kind_key
    UNIQUE (route,catalogue_id,revision_id,kind);

CREATE TABLE content.hosted_version_revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  catalogue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  revision_kind text NOT NULL CHECK (revision_kind IN ('structure','publication')),
  generation_id uuid NOT NULL,
  generation_kind text NOT NULL CHECK (generation_kind IN ('draft','candidate')),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  PRIMARY KEY (route,catalogue_id,revision_id),
  UNIQUE (route,catalogue_id,generation_id,sequence),
  FOREIGN KEY (route,catalogue_id,revision_id,revision_kind)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id,kind),
  CHECK ((revision_kind='structure' AND generation_kind='draft')
      OR (revision_kind='publication' AND generation_kind='candidate')),
  CHECK (route = get_byte(uuid_send(catalogue_id),10) * 256 + get_byte(uuid_send(catalogue_id),11)),
  CHECK (route = get_byte(uuid_send(revision_id),10) * 256 + get_byte(uuid_send(revision_id),11)),
  CHECK (route = get_byte(uuid_send(generation_id),10) * 256 + get_byte(uuid_send(generation_id),11))
);

-- The temporal store owner adds the exact snapshot and generation-kind foreign keys with its producer migration.
CREATE TRIGGER hosted_version_revision_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_version_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();

-- migrate:down
DROP TABLE content.hosted_version_revision;
ALTER TABLE content.hosted_structure_revision
  DROP CONSTRAINT hosted_structure_revision_identity_kind_key;
