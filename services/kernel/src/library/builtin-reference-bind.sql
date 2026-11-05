WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id,
         :source_revision::integer AS source_revision, :source_transaction_id::uuid AS source_transaction_id,
         :collection_id::uuid AS collection_id, :profile_id::text AS profile_id,
         :state_set_id::text AS state_set_id, :state_id::text AS state_id, :release_digest::text AS release_digest
), source AS MATERIALIZED (
  SELECT entry.route, entry.account_id, entry.subject_id, entry.revision, entry.transaction_id,
         input.collection_id, input.profile_id, input.state_set_id, input.state_id, input.release_digest
  FROM library.entry AS entry JOIN input USING (route, account_id, subject_id)
  WHERE entry.revision = input.source_revision AND entry.transaction_id = input.source_transaction_id
    AND entry.state = input.state_id
    AND entry.library_profile_pin ->> 'releaseDigest' = input.release_digest
    AND entry.library_profile_pin ->> 'profileId' = input.profile_id
  FOR UPDATE OF entry
), reference AS (
  INSERT INTO library.builtin_collection_reference AS current
    (route, collection_id, account_id, profile_id, state_set_id, state_id)
  SELECT route, collection_id, account_id, profile_id, state_set_id, state_id
  FROM source
  ON CONFLICT (route, collection_id) DO UPDATE SET collection_id = EXCLUDED.collection_id
  WHERE (current.account_id, current.profile_id, current.state_set_id, current.state_id)
      = (EXCLUDED.account_id, EXCLUDED.profile_id, EXCLUDED.state_set_id, EXCLUDED.state_id)
  RETURNING route, collection_id, account_id, profile_id, state_set_id, state_id
), support AS (
  INSERT INTO library.builtin_state_reference_source
    (route, account_id, subject_id, collection_id, source_revision, source_transaction_id, release_digest)
  SELECT source.route, source.account_id, source.subject_id, reference.collection_id,
         source.revision, source.transaction_id, source.release_digest
  FROM source JOIN reference USING (route, account_id)
  ON CONFLICT (route, account_id, subject_id) DO UPDATE
  SET collection_id = EXCLUDED.collection_id, source_revision = EXCLUDED.source_revision,
      source_transaction_id = EXCLUDED.source_transaction_id, release_digest = EXCLUDED.release_digest
  RETURNING route, collection_id
)
SELECT reference.route, reference.collection_id AS "collectionId", reference.account_id AS "accountId",
       reference.profile_id AS "profileId", reference.state_set_id AS "stateSetId", reference.state_id AS "stateId"
FROM reference JOIN support USING (route, collection_id);
