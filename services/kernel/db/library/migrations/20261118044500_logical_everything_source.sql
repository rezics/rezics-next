-- migrate:up
-- The byte layout is builtinCollectionId(account, {kind:'everything'}): UUIDv8, RFC variant,
-- and the owner's two route bytes. The namespace is the binary account UUID.
CREATE FUNCTION library.everything_source_id(owner_id uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH seed AS (
    SELECT substring(sha256(uuid_send(owner_id) ||
      '["library.collection.builtin",1,"everything"]'::bytea) FROM 1 FOR 16) AS bytes
  )
  SELECT encode(set_byte(set_byte(set_byte(set_byte(bytes,
    6, (get_byte(bytes,6) & 15) | 128),
    8, (get_byte(bytes,8) & 63) | 128),
    10, get_byte(uuid_send(owner_id),10)),
    11, get_byte(uuid_send(owner_id),11)), 'hex')::uuid FROM seed
$$;

ALTER TABLE library.owner_index_control ADD COLUMN everything_id uuid
  GENERATED ALWAYS AS (library.everything_source_id(account_id)) STORED,
  ADD UNIQUE (route,everything_id);

-- A canonical row belongs either to its original stored Collection or to this owner's exact
-- logical Everything. Existing inserts and all other Collection kinds keep their physical FK.
ALTER TABLE library.canonical_source_scope
  DROP CONSTRAINT canonical_source_scope_route_collection_id_fkey,
  ADD COLUMN logical_owner_id uuid,
  ADD COLUMN stored_collection_id uuid GENERATED ALWAYS AS
    (CASE WHEN logical_owner_id IS NULL THEN collection_id END) STORED,
  ADD FOREIGN KEY (route,stored_collection_id) REFERENCES library.collection(route,collection_id),
  ADD FOREIGN KEY (route,logical_owner_id) REFERENCES library.owner_index_control(route,account_id),
  ADD CHECK (logical_owner_id IS NULL OR
    (collection_id=library.everything_source_id(logical_owner_id)
     AND identity->>'scope' IS NOT DISTINCT FROM 'private_builtin'
     AND identity->>'accountId' IS NOT DISTINCT FROM logical_owner_id::text));

ALTER TABLE library.canonical_source_generation
  DROP CONSTRAINT canonical_source_generation_route_collection_id_fkey,
  ADD COLUMN logical_owner_id uuid,
  ADD COLUMN stored_collection_id uuid GENERATED ALWAYS AS
    (CASE WHEN logical_owner_id IS NULL THEN collection_id END) STORED,
  ADD FOREIGN KEY (route,stored_collection_id) REFERENCES library.collection(route,collection_id),
  ADD FOREIGN KEY (route,logical_owner_id) REFERENCES library.owner_index_control(route,account_id),
  ADD CHECK (logical_owner_id IS NULL OR
    (collection_id=library.everything_source_id(logical_owner_id)
     AND basis->'authority'->>'kind' IS NOT DISTINCT FROM 'private_builtin'
     AND basis->'authority'->>'curatorAccountId' IS NOT DISTINCT FROM logical_owner_id::text));

-- A point lookup for current working authority. A real Collection (including a deleted one)
-- supersedes the logical source. Unknown legacy assignments cannot certify complete coverage.
CREATE VIEW library.logical_everything_source AS
SELECT c.route,c.account_id,c.everything_id AS collection_id,
       c.everything_id::text || ':everything' AS incarnation,h.generation
FROM library.owner_index_control c JOIN library.fact_source_head h USING (route,account_id)
WHERE c.phase='ready' AND c.personal_coverage_ready
  AND NOT EXISTS (SELECT 1 FROM library.collection s
    WHERE s.route=c.route AND s.collection_id=c.everything_id)
  AND NOT EXISTS (SELECT 1 FROM library.owner_index_label_repair r
    WHERE r.route=c.route AND r.account_id=c.account_id)
  AND NOT EXISTS (SELECT 1 FROM library.label_assignment a
    WHERE a.route=c.route AND a.account_id=c.account_id AND a.deleted_at IS NULL
      AND (a.slot_no IS NULL OR a.assignment_id IS NULL));

-- migrate:down
-- Forward only after logical Source capture has retained owner custody.
