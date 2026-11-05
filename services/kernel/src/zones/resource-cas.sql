WITH input AS (SELECT :visibility::text AS next_visibility)
UPDATE zones.zone SET
 revision = revision + 1, owner_id = :owner_id::nullable(uuid), state = :state::text, visibility = input.next_visibility,
 configuration = :configuration::nullable(jsonb), mounts = :mounts::nullable(uuid[]), release_digest = :release_digest::text,
 public_ever = public_ever OR input.next_visibility <> 'private',
 deleted_at = :deleted_at::nullable(timestamptz), restore_until = :restore_until::nullable(timestamptz),
 write_fenced = :write_fenced::boolean, withholding = :withholding::jsonb, held = :held::boolean,
 lifecycle_revision = lifecycle_revision + 1,
 updated_at = :at::timestamptz, transaction_id = :transaction_id::uuid
FROM input
WHERE route = :route::integer AND zone_id = :id::uuid AND revision = :revision::bigint
  AND lifecycle_revision = :lifecycle_revision::bigint
RETURNING route, zone_id AS id, revision::text AS revision, state, owner_id AS "ownerId", visibility,
configuration, mounts, release_digest AS "releaseDigest", public_ever AS "publicEver",
write_fenced AS "writeFenced", lifecycle_revision::text AS "lifecycleRevision", withholding, held,
deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil",
created_at::text AS "createdAt", updated_at::text AS "updatedAt",
creation_transaction_id AS "creationTransactionId", transaction_id AS "transactionId";
