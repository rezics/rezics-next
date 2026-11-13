-- migrate:up
-- Maps each hosted structure revision to one immutable draft generation snapshot so point
-- commands can CAS the catalogue head without a second tree adapter.
CREATE TABLE content.hosted_version_revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  catalogue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  PRIMARY KEY (route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, generation_id, sequence)
    REFERENCES content.hosted_tree_snapshot_version(route, catalogue_id, generation_id, sequence),
  UNIQUE (route, catalogue_id, generation_id, sequence),
  CHECK (route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)),
  CHECK (route = get_byte(uuid_send(generation_id), 10) * 256 + get_byte(uuid_send(generation_id), 11))
);

-- migrate:down
DROP TABLE content.hosted_version_revision;
