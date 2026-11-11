-- Knowledge notebooks own private documents in the account home. Public selection is explicit and points at
-- one immutable canonical revision; the current pointer remains the final authority when Search is stale.
-- migrate:up
CREATE TABLE content.knowledge_structure_revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  notebook_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, notebook_id, revision_id),
  CHECK (route = get_byte(uuid_send(notebook_id), 10) * 256 + get_byte(uuid_send(notebook_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11))
);

CREATE TABLE content.knowledge_notebook (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  notebook_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  structure_revision_id uuid NOT NULL,
  created_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, notebook_id),
  CONSTRAINT knowledge_notebook_structure_revision_fk FOREIGN KEY (route, notebook_id, structure_revision_id)
    REFERENCES content.knowledge_structure_revision(route, notebook_id, revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (route = get_byte(uuid_send(notebook_id), 10) * 256 + get_byte(uuid_send(notebook_id), 11)),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11))
);
ALTER TABLE content.knowledge_structure_revision
  ADD CONSTRAINT knowledge_structure_revision_notebook_fk
  FOREIGN KEY (route, notebook_id) REFERENCES content.knowledge_notebook(route, notebook_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX knowledge_notebook_owner_page
  ON content.knowledge_notebook(route, owner_account_id, created_at DESC, notebook_id);

CREATE TABLE content.knowledge_document (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  document_id uuid NOT NULL,
  notebook_id uuid NOT NULL,
  head_revision_id uuid NOT NULL,
  current_publication_id uuid,
  created_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, document_id),
  UNIQUE (route, notebook_id, document_id),
  CONSTRAINT knowledge_document_notebook_fk FOREIGN KEY (route, notebook_id) REFERENCES content.knowledge_notebook(route, notebook_id),
  CHECK (route = get_byte(uuid_send(document_id), 10) * 256 + get_byte(uuid_send(document_id), 11))
);

CREATE TABLE content.knowledge_revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 512),
  language text CHECK (language IS NULL OR char_length(language) BETWEEN 1 AND 64),
  canonical_bytes bytea NOT NULL CHECK (octet_length(canonical_bytes) <= 2097152),
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  licence text NOT NULL CHECK (char_length(licence) BETWEEN 1 AND 128),
  subject_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(subject_ids) <= 64),
  author_account_id uuid,
  recorded_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, document_id, revision_id),
  FOREIGN KEY (route, document_id) REFERENCES content.knowledge_document(route, document_id),
  CHECK (route = get_byte(uuid_send(document_id), 10) * 256 + get_byte(uuid_send(document_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11))
);
ALTER TABLE content.knowledge_document
  ADD CONSTRAINT knowledge_document_head_revision_fk
  FOREIGN KEY (route, document_id, head_revision_id)
    REFERENCES content.knowledge_revision(route, document_id, revision_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE content.knowledge_publication (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  document_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  recorded_transaction_id uuid NOT NULL,
  published_at timestamptz NOT NULL CHECK (isfinite(published_at)),
  PRIMARY KEY (route, document_id, publication_id),
  CONSTRAINT knowledge_publication_document_fk FOREIGN KEY (route, document_id) REFERENCES content.knowledge_document(route, document_id),
  CONSTRAINT knowledge_publication_revision_fk FOREIGN KEY (route, document_id, revision_id)
    REFERENCES content.knowledge_revision(route, document_id, revision_id),
  CHECK (route = get_byte(uuid_send(document_id), 10) * 256 + get_byte(uuid_send(document_id), 11)),
  CHECK (route = get_byte(uuid_send(publication_id), 10) * 256 + get_byte(uuid_send(publication_id), 11))
);
ALTER TABLE content.knowledge_document
  ADD CONSTRAINT knowledge_document_current_publication_fk
  FOREIGN KEY (route, document_id, current_publication_id)
    REFERENCES content.knowledge_publication(route, document_id, publication_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX knowledge_publication_subject_page
  ON content.knowledge_publication(route, subject_id, published_at DESC, document_id, publication_id);

CREATE TABLE content.knowledge_placement (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  notebook_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  document_id uuid NOT NULL,
  parent_id uuid,
  position bigint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (route, notebook_id, placement_id),
  UNIQUE (route, notebook_id, document_id),
  UNIQUE NULLS NOT DISTINCT (route, notebook_id, parent_id, position),
  CONSTRAINT knowledge_placement_notebook_fk FOREIGN KEY (route, notebook_id) REFERENCES content.knowledge_notebook(route, notebook_id),
  CONSTRAINT knowledge_placement_document_fk FOREIGN KEY (route, notebook_id, document_id) REFERENCES content.knowledge_document(route, notebook_id, document_id),
  CONSTRAINT knowledge_placement_parent_fk FOREIGN KEY (route, notebook_id, parent_id)
    REFERENCES content.knowledge_placement(route, notebook_id, placement_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (route = get_byte(uuid_send(placement_id), 10) * 256 + get_byte(uuid_send(placement_id), 11))
);
CREATE INDEX knowledge_placement_children ON content.knowledge_placement(route, notebook_id, parent_id, position, placement_id);

CREATE FUNCTION content.guard_knowledge_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Knowledge revisions and publications are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER knowledge_structure_revision_immutable BEFORE UPDATE OR DELETE ON content.knowledge_structure_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_snapshot();
CREATE TRIGGER knowledge_revision_immutable BEFORE UPDATE OR DELETE ON content.knowledge_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_snapshot();
CREATE TRIGGER knowledge_publication_immutable BEFORE UPDATE OR DELETE ON content.knowledge_publication
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_snapshot();

-- migrate:down
DROP TRIGGER knowledge_publication_immutable ON content.knowledge_publication;
DROP TRIGGER knowledge_revision_immutable ON content.knowledge_revision;
DROP TRIGGER knowledge_structure_revision_immutable ON content.knowledge_structure_revision;
DROP FUNCTION content.guard_knowledge_snapshot();
DROP TABLE content.knowledge_placement;
ALTER TABLE content.knowledge_document DROP CONSTRAINT knowledge_document_current_publication_fk;
DROP TABLE content.knowledge_publication;
ALTER TABLE content.knowledge_document DROP CONSTRAINT knowledge_document_head_revision_fk;
DROP TABLE content.knowledge_revision;
DROP TABLE content.knowledge_document;
ALTER TABLE content.knowledge_structure_revision DROP CONSTRAINT knowledge_structure_revision_notebook_fk;
DROP TABLE content.knowledge_notebook;
DROP TABLE content.knowledge_structure_revision;
