-- migrate:up
-- Explicit membership publications. No predicate, personal fact, Access result or ready-empty sentinel.
CREATE TABLE library.collection_source_output (
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  source_generation bigint NOT NULL CHECK(source_generation >= 0),
  expected_members bigint NOT NULL CHECK(expected_members >= 0),
  written_members bigint NOT NULL DEFAULT 0 CHECK(written_members >= 0),
  after_subject_id uuid,
  state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','complete','cancelled')),
  PRIMARY KEY(route,collection_id,generation),
  FOREIGN KEY(route,collection_id) REFERENCES library.collection(route,collection_id),
  CHECK(route = get_byte(uuid_send(collection_id),10)*256 + get_byte(uuid_send(collection_id),11)),
  CHECK(written_members <= expected_members),
  CHECK((written_members=0) = (after_subject_id IS NULL)),
  CHECK(state <> 'complete' OR written_members=expected_members)
);
CREATE UNIQUE INDEX collection_source_output_building ON library.collection_source_output(route,collection_id)
  WHERE state='building';
CREATE TABLE library.collection_source_output_member (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  subject_id uuid NOT NULL,
  PRIMARY KEY(route,collection_id,generation,subject_id),
  FOREIGN KEY(route,collection_id,generation) REFERENCES library.collection_source_output(route,collection_id,generation)
);
CREATE TABLE library.collection_source_output_head (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  source_generation bigint NOT NULL CHECK(source_generation >= 0),
  PRIMARY KEY(route,collection_id),
  FOREIGN KEY(route,collection_id,generation) REFERENCES library.collection_source_output(route,collection_id,generation)
);
-- Nothing cascades. Withdrawing a pointer never proves release of source/receiving/control/reader custody.

-- migrate:down
-- Forward only. Retained Publication copies need the actual shared destination-disposition authority.
