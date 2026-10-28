SELECT route, zone_id AS id, revision::text AS revision, state, owner_id AS "ownerId", visibility,
configuration, mounts, release_digest AS "releaseDigest", public_ever AS "publicEver",
write_fenced AS "writeFenced", lifecycle_revision::text AS "lifecycleRevision", withholding, held,
deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil",
created_at::text AS "createdAt", updated_at::text AS "updatedAt",
creation_transaction_id AS "creationTransactionId", transaction_id AS "transactionId" FROM zones.zone
WHERE route = :route::integer AND zone_id = :id::uuid;
