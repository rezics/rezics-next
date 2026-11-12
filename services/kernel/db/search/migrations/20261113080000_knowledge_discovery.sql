-- migrate:up
-- Only explicitly selected public identities enter this derived index. No bodies, account locators,
-- private heads, notebook ancestry or permission decisions are retained here.
CREATE TABLE search.knowledge_discovery_subject (
  subject_id uuid PRIMARY KEY,
  sequence bigint NOT NULL CHECK (sequence >= 0)
);
CREATE TABLE search.knowledge_discovery_association (
  subject_id uuid NOT NULL,
  document_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  published_at timestamptz NOT NULL CHECK (isfinite(published_at)),
  sequence bigint NOT NULL CHECK (sequence > 0),
  PRIMARY KEY (subject_id, publication_id),
  UNIQUE (subject_id, sequence)
);
CREATE INDEX knowledge_discovery_publication_page ON search.knowledge_discovery_association
  (subject_id, published_at DESC, document_id, publication_id);
-- Bootstrap only the already explicit current selections, once during installation. Runtime population
-- follows native publication effects and never enumerates notebooks or account homes.
INSERT INTO search.knowledge_discovery_association
  (subject_id,document_id,publication_id,revision_id,published_at,sequence)
SELECT p.subject_id,p.document_id,p.publication_id,p.revision_id,p.published_at,
       row_number() OVER (PARTITION BY p.subject_id ORDER BY p.published_at,p.document_id,p.publication_id)
FROM content.knowledge_publication p
JOIN content.knowledge_document d ON d.route=p.route AND d.document_id=p.document_id
  AND d.current_publication_id=p.publication_id;
INSERT INTO search.knowledge_discovery_subject(subject_id,sequence)
SELECT subject_id,max(sequence) FROM search.knowledge_discovery_association GROUP BY subject_id;
CREATE TABLE search.knowledge_discovery_installation (
  version integer PRIMARY KEY CHECK (version=1)
);
INSERT INTO search.knowledge_discovery_installation VALUES (1);
CREATE TABLE search.knowledge_discovery_preparation (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state jsonb NOT NULL CHECK (octet_length(state::text) <= 16384),
  expires_at bigint NOT NULL
);
CREATE INDEX knowledge_discovery_preparation_expiry ON search.knowledge_discovery_preparation(expires_at,id);
CREATE INDEX knowledge_discovery_preparation_subject ON search.knowledge_discovery_preparation(subject_id,expires_at,id);

-- migrate:down
DROP TABLE search.knowledge_discovery_preparation;
DROP TABLE search.knowledge_discovery_installation;
DROP TABLE search.knowledge_discovery_association;
DROP TABLE search.knowledge_discovery_subject;
