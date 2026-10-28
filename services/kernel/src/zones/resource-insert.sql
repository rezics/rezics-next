WITH input AS (
  SELECT :visibility::text AS visibility, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
)
INSERT INTO zones.zone
(route, zone_id, revision, state, owner_id, visibility, configuration, mounts, release_digest,
 public_ever, created_at, updated_at, creation_transaction_id, transaction_id)
SELECT :route::integer, :id::uuid, 1, 'active', :owner_id::uuid, input.visibility, :configuration::jsonb,
 :mounts::uuid[], :release_digest::text, input.visibility <> 'private', input.at, input.at,
 input.transaction_id, input.transaction_id FROM input
RETURNING route, zone_id AS id, revision::text AS revision, state, owner_id AS "ownerId", visibility,
configuration, mounts, release_digest AS "releaseDigest", public_ever AS "publicEver",
write_fenced AS "writeFenced", lifecycle_revision::text AS "lifecycleRevision", withholding, held,
deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil",
created_at::text AS "createdAt", updated_at::text AS "updatedAt",
creation_transaction_id AS "creationTransactionId", transaction_id AS "transactionId";
