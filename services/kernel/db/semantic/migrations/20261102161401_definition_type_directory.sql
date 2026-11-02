-- migrate:up
CREATE TABLE semantic.definition_type_build (
  route integer NOT NULL CHECK (route = 0),
  catalogue text NOT NULL,
  after_release text NOT NULL DEFAULT '',
  after_key text NOT NULL DEFAULT '',
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,catalogue)
);
CREATE TABLE semantic.definition_type_entry (
  route integer NOT NULL CHECK (route = 0),
  catalogue text NOT NULL,
  id_key text NOT NULL,
  id json NOT NULL,
  release_digest text NOT NULL,
  body json NOT NULL,
  PRIMARY KEY (route,catalogue,id_key)
);
CREATE TABLE semantic.definition_type_edge (
  route integer NOT NULL CHECK (route = 0),
  catalogue text NOT NULL,
  locale text NOT NULL,
  parent_key text NOT NULL,
  chunk bytea NOT NULL CHECK (octet_length(chunk) BETWEEN 1 AND 128),
  node_key text NOT NULL,
  entry_key text,
  PRIMARY KEY (route,catalogue,locale,parent_key,chunk),
  UNIQUE (route,catalogue,locale,node_key)
);
CREATE TABLE semantic.definition_type_property (
  route integer NOT NULL CHECK (route = 0),
  release_digest text NOT NULL,
  id_key text NOT NULL,
  id json NOT NULL,
  body json NOT NULL,
  PRIMARY KEY (route,release_digest,id_key)
);
CREATE INDEX definition_type_member_page ON semantic.definition_catalogue_member(route,root_digest,category,release_digest,id_key);

-- migrate:down
DROP INDEX semantic.definition_type_member_page;
DROP TABLE semantic.definition_type_property;
DROP TABLE semantic.definition_type_edge;
DROP TABLE semantic.definition_type_entry;
DROP TABLE semantic.definition_type_build;
