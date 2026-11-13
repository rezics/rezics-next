-- migrate:up
-- A generation keeps every explicitly selected revision citeable, while the document pointer still names the live URL.
ALTER TABLE content.knowledge_publication
  ADD CONSTRAINT knowledge_publication_selection_identity_key
  UNIQUE (route, document_id, lifecycle_generation, revision_id, publication_id);

CREATE TABLE content.knowledge_publication_selection (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  document_id uuid NOT NULL,
  lifecycle_generation bigint NOT NULL CHECK (lifecycle_generation >= 0),
  revision_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  PRIMARY KEY (route, document_id, lifecycle_generation, revision_id),
  CONSTRAINT knowledge_publication_selection_publication_fk
    FOREIGN KEY (route, document_id, lifecycle_generation, revision_id, publication_id)
    REFERENCES content.knowledge_publication(route, document_id, lifecycle_generation, revision_id, publication_id),
  CHECK (route = get_byte(uuid_send(document_id), 10) * 256 + get_byte(uuid_send(document_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)),
  CHECK (route = get_byte(uuid_send(publication_id), 10) * 256 + get_byte(uuid_send(publication_id), 11))
);

-- The pointer is the only trustworthy evidence for an existing live selection. Historical rows may
-- belong to a generation closed by a withdrawal that predates this index and must not be resurrected.
INSERT INTO content.knowledge_publication_selection
  (route, document_id, lifecycle_generation, revision_id, publication_id)
SELECT d.route, d.document_id, d.lifecycle_generation, p.revision_id, p.publication_id
FROM content.knowledge_document d
JOIN content.knowledge_publication p
  ON p.route=d.route AND p.document_id=d.document_id
 AND p.publication_id=d.current_publication_id
 AND p.lifecycle_generation=d.lifecycle_generation
WHERE d.current_publication_id IS NOT NULL;

-- migrate:down
DROP TABLE content.knowledge_publication_selection;
ALTER TABLE content.knowledge_publication
  DROP CONSTRAINT knowledge_publication_selection_identity_key;
