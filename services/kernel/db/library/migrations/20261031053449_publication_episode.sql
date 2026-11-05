-- migrate:up
-- First owner write can pin Everything meaning without changing its stable identity.
ALTER TABLE library.collection DROP CONSTRAINT collection_builtin_identity_check;
ALTER TABLE library.collection
  ADD CONSTRAINT collection_builtin_identity_check CHECK (
    CASE membership_kind
      WHEN 'curated' THEN
        builtin_kind IS NULL AND builtin_release_digest IS NULL AND
        builtin_profile_id IS NULL AND builtin_state_set_id IS NULL AND builtin_state_id IS NULL
      WHEN 'dynamic' THEN
        CASE builtin_kind
          WHEN 'everything' THEN
            (builtin_release_digest IS NULL OR (octet_length(builtin_release_digest)=71 AND
              builtin_release_digest COLLATE "C" ~ '\Asha256:[0-9a-f]{64}\Z')) AND
            builtin_profile_id IS NULL AND builtin_state_set_id IS NULL AND builtin_state_id IS NULL
          WHEN 'state' THEN
            builtin_release_digest IS NOT NULL AND builtin_profile_id IS NOT NULL AND
            builtin_state_set_id IS NOT NULL AND builtin_state_id IS NOT NULL AND
            octet_length(builtin_release_digest) = 71 AND
            builtin_release_digest COLLATE "C" ~ '\Asha256:[0-9a-f]{64}\Z' AND
            octet_length(builtin_profile_id) BETWEEN 1 AND 64 AND
            builtin_profile_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z' AND
            octet_length(builtin_state_set_id) BETWEEN 1 AND 64 AND
            builtin_state_set_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z' AND
            octet_length(builtin_state_id) BETWEEN 1 AND 64 AND
            builtin_state_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'
          ELSE
            -- Erased private references do not establish a ready membership source.
            builtin_kind IS NULL AND builtin_release_digest IS NULL AND
            builtin_profile_id IS NULL AND builtin_state_set_id IS NULL AND builtin_state_id IS NULL
        END
      ELSE false
    END
  );
-- A whole-query build has no cardinality until the actual Source proves exhaustion.
ALTER TABLE library.collection_source_output ALTER COLUMN expected_members DROP NOT NULL;
ALTER TABLE library.collection_source_output ADD CONSTRAINT collection_output_complete_cardinality
  CHECK(state<>'complete' OR expected_members IS NOT NULL);
CREATE TABLE library.collection_publication_operation (
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
  publication_id uuid NOT NULL,
  source_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  record jsonb NOT NULL CHECK(octet_length(record::text)<=65536),
  source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
  commitment text NOT NULL CHECK(commitment ~ '^[0-9a-f]{64}$'),
  creation_storage_key text NOT NULL CHECK(octet_length(creation_storage_key)<=255),
  creation_key text GENERATED ALWAYS AS (record->'creation'->>'idempotencyKey') STORED NOT NULL,
  PRIMARY KEY(route,publication_id),
  UNIQUE(route,source_id),
  UNIQUE(route,owner_account_id,creation_key),
  CHECK(route=get_byte(uuid_send(publication_id),10)*256+get_byte(uuid_send(publication_id),11)),
  CHECK(route=get_byte(uuid_send(source_id),10)*256+get_byte(uuid_send(source_id),11)),
  CHECK(route=get_byte(uuid_send(collection_id),10)*256+get_byte(uuid_send(collection_id),11)),
  CHECK(route=get_byte(uuid_send(owner_account_id),10)*256+get_byte(uuid_send(owner_account_id),11))
);
CREATE INDEX collection_publication_operation_owner ON library.collection_publication_operation(route,owner_account_id,publication_id);
CREATE INDEX collection_publication_operation_collection ON library.collection_publication_operation(route,collection_id,publication_id);
CREATE TABLE library.collection_publication_source (
  route integer NOT NULL,
  source_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  bytes text NOT NULL CHECK(octet_length(bytes)<=16384),
  PRIMARY KEY(route,source_id),
  FOREIGN KEY(route,publication_id) REFERENCES library.collection_publication_operation(route,publication_id),
  FOREIGN KEY(route,source_id) REFERENCES library.collection_publication_operation(route,source_id)
);
CREATE TABLE library.collection_publication_episode (
  route integer NOT NULL,
  publication_id uuid NOT NULL,
  source_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'staging' CHECK(phase IN ('staging','awaiting_activation','refused','complete')),
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  PRIMARY KEY(route,publication_id),
  FOREIGN KEY(route,publication_id) REFERENCES library.collection_publication_operation(route,publication_id),
  FOREIGN KEY(route,source_id) REFERENCES library.collection_publication_source(route,source_id)
);
CREATE UNIQUE INDEX collection_publication_episode_pending ON library.collection_publication_episode(route,collection_id)
  WHERE phase IN ('staging','awaiting_activation');
CREATE INDEX collection_publication_episode_owner ON library.collection_publication_episode(route,owner_account_id,publication_id);
CREATE FUNCTION library.publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'collection_publication_immutable'; END; $$;
CREATE TRIGGER collection_publication_operation_immutable BEFORE UPDATE ON library.collection_publication_operation
  FOR EACH ROW EXECUTE FUNCTION library.publication_immutable();
CREATE TRIGGER collection_publication_source_immutable BEFORE UPDATE ON library.collection_publication_source
  FOR EACH ROW EXECUTE FUNCTION library.publication_immutable();
CREATE FUNCTION library.check_publication_episode_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_publication_operation o
    JOIN library.collection_publication_source s
      ON (s.route,s.source_id,s.publication_id,s.transaction_id)=(o.route,o.source_id,o.publication_id,o.transaction_id)
    JOIN library.collection_publication_episode e
      ON (e.route,e.publication_id,e.source_id,e.collection_id,e.owner_account_id)=
         (o.route,o.publication_id,o.source_id,o.collection_id,o.owner_account_id)
    JOIN core.receipt r ON r.partition_no=(o.route >> 4) AND r.principal_kind='account' AND r.principal_id=o.owner_account_id
      AND r.command_kind='library.collection.publication.begin' AND r.idempotency_key=o.creation_storage_key
    JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    JOIN library.collection c ON (c.route,c.collection_id)=(o.route,o.collection_id)
    JOIN library.collection_source_output g ON g.route=o.route AND g.collection_id=o.collection_id
      AND g.generation=(s.bytes::jsonb->'output'->>'generation')::uuid
    WHERE o.route=NEW.route AND o.publication_id=NEW.publication_id
      AND o.native_xid=pg_current_xact_id() AND o.xmin=s.xmin AND o.xmin=e.xmin AND o.xmin=r.xmin AND o.xmin=b.xmin AND o.xmin=g.xmin
      AND r.transaction_id=o.transaction_id AND r.payload_state='present' AND r.position=b.position AND r.epoch=b.epoch
      AND encode(r.request_digest,'hex')=o.record->'creation'->>'requestDigest'
      AND r.response->>'durableInitiator'=o.commitment
      AND o.record->>'recordedTransactionId'=o.transaction_id::text AND o.record->>'sourceDigest'=o.source_digest
      AND o.record->'operation'=jsonb_build_object('route',o.route,'id',o.publication_id,'kind','library.collection.publication.begin','sourceId',o.source_id)
      AND o.record->>'initiatorAccountId'=o.owner_account_id::text
      AND o.record->'actor'->>'accountId'=o.owner_account_id::text
      AND o.record->'creation'->>'commandKind'='library.collection.publication.begin'
      AND o.record->'creation'->'target'=jsonb_build_object('route',o.route,'id',o.collection_id)
      AND b.principal_kind='account' AND b.principal_id=o.owner_account_id AND b.position>0
      AND b.client_id=o.record->'actor'->>'clientId' AND b.requested_by IS NOT DISTINCT FROM (o.record->'actor'->>'requestedBy')
      AND c.curator_account_id=o.owner_account_id AND c.state='active' AND c.membership_kind='dynamic'
      AND g.account_id=o.owner_account_id AND g.state='building' AND g.expected_members IS NULL
      AND g.source_generation=c.source_generation AND e.phase='staging'
      AND s.bytes::jsonb->'locator'=jsonb_build_object('route',o.route,'ownerAccountId',o.owner_account_id,'collectionId',o.collection_id,'publicationId',o.publication_id)
      AND s.bytes::jsonb->'target'=jsonb_build_object('kind','collection_output','route',o.route,'collectionId',o.collection_id,'visibility',s.bytes::jsonb->'target'->>'visibility')
      AND s.bytes::jsonb->'target'->>'visibility' IN ('public','unlisted')
      AND s.bytes::jsonb->'input'->>'kind'='private_working_source'
      AND s.bytes::jsonb->'input'->'identity'->>'scope'='private_builtin'
      AND (s.bytes::jsonb->'rule'->>'collectionRevision')::integer=c.revision
      AND (s.bytes::jsonb->'rule'->>'sourceGeneration')::bigint=c.source_generation
  ) THEN RAISE EXCEPTION 'collection_publication_uncommitted'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER collection_publication_commit AFTER INSERT ON library.collection_publication_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_publication_episode_commit();
-- migrate:down
-- The accepted built-in release pin remains valid; never discard accepted meaning on downgrade.
DROP TRIGGER collection_publication_commit ON library.collection_publication_operation;
DROP FUNCTION library.check_publication_episode_commit();
DROP TABLE library.collection_publication_episode;
DROP TABLE library.collection_publication_source;
DROP TABLE library.collection_publication_operation;
DROP FUNCTION library.publication_immutable();
ALTER TABLE library.collection_source_output DROP CONSTRAINT collection_output_complete_cardinality;
-- Downgrade refuses an unfinished whole-query build rather than inventing its cardinality.
ALTER TABLE library.collection_source_output ALTER COLUMN expected_members SET NOT NULL;
