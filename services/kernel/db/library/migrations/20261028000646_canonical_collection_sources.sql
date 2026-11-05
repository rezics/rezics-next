-- migrate:up
-- This fence starts unobserved: zero alone never certifies canonical coverage.
-- Native source mutation hooks and compatibility/readiness checks belong to the runtime owner.
ALTER TABLE library.collection
  ADD COLUMN source_generation bigint NOT NULL DEFAULT 0 CHECK (source_generation >= 0);

CREATE TABLE library.canonical_source_state (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  ready_generation uuid,
  ready_basis text CHECK (octet_length(convert_to(ready_basis, 'UTF8')) BETWEEN 1 AND 256),
  working_generation uuid,
  working_basis text CHECK (octet_length(convert_to(working_basis, 'UTF8')) BETWEEN 1 AND 256),
  after_subject_id uuid,
  after_driver text COLLATE "C" CHECK (after_driver IN ('member', 'entry', 'label', 'session', 'copy', 'output')),
  after_fact_id uuid,
  source_exhausted boolean NOT NULL DEFAULT false,
  pending_mapping boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, collection_id),
  FOREIGN KEY (route, collection_id) REFERENCES library.collection (route, collection_id) ON DELETE NO ACTION,
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK ((ready_generation IS NULL) = (ready_basis IS NULL)),
  CHECK ((working_generation IS NULL) = (working_basis IS NULL)),
  CHECK ((after_subject_id IS NULL) = (after_driver IS NULL)),
  CHECK ((after_subject_id IS NULL) = (after_fact_id IS NULL))
);

-- Generations outlive pointer changes. No state-row FK or cascading header delete may erase them.
-- Purge must page through all old, abandoned and private child generations before erasing the header.
-- The runtime admits only complete current source/identity coverage, with no pending mapping even at EOF;
-- after readiness recovers it may have to restart an EOF build at the same basis in bounded steps.
CREATE TABLE library.canonical_source_fact (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  basis_digest text NOT NULL CHECK (octet_length(convert_to(basis_digest, 'UTF8')) BETWEEN 1 AND 256),
  canonical_subject_id uuid NOT NULL,
  stored_subject_id uuid NOT NULL,
  driver text COLLATE "C" NOT NULL CHECK (driver IN ('member', 'entry', 'label', 'session', 'copy', 'output')),
  fact_id uuid NOT NULL,
  PRIMARY KEY (route, collection_id, generation, basis_digest,
               canonical_subject_id, stored_subject_id, driver, fact_id),
  UNIQUE (route, collection_id, generation, basis_digest, stored_subject_id, driver, fact_id),
  FOREIGN KEY (route, collection_id) REFERENCES library.collection (route, collection_id) ON DELETE NO ACTION,
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11))
);

-- Ordinary transactional native DDL: ALTER TABLE and DROP INDEX take ACCESS EXCLUSIVE locks;
-- CREATE INDEX scans existing members and blocks writes while building. This is not an online rebuild.
-- Keep the existing prefix access path and add the occurrence tie-break for strict duplicate-run resumes.
DROP INDEX library.collection_member_subject;
CREATE INDEX collection_member_subject ON library.collection_member (route, collection_id, subject_id, member_id);

-- migrate:down
-- Forward only: canonical generations and their cleanup obligations must not be discarded by rollback.
