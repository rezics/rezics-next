WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), destination AS MATERIALIZED (
  SELECT jsonb_build_object('provenance', 'legacy', 'releaseDigest', profile_migration_digest,
    'acceptingType', NULL, 'profileId', 'legacy-fixed-v1') AS pin
  FROM library.fact_source_head
  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
    AND profile_migration_digest IS NOT NULL
)
UPDATE library.copy
SET deletion_id = NULL, deleted_at = NULL, restore_until = NULL,
    library_profile_pin = COALESCE(library_profile_pin, (SELECT pin FROM destination)),
    kind_profile_pin = CASE WHEN library_profile_pin IS NULL
      THEN COALESCE(kind_profile_pin, (SELECT pin FROM destination)) ELSE kind_profile_pin END,
    status_profile_pin = CASE WHEN library_profile_pin IS NULL
      THEN COALESCE(status_profile_pin, (SELECT pin FROM destination)) ELSE status_profile_pin END,
    kind = CASE WHEN library_profile_pin IS NULL AND EXISTS (SELECT 1 FROM destination)
      THEN COALESCE(kind, 'legacy-unspecified') ELSE kind END,
    revision = revision + 1, transaction_id = :transaction_id::uuid
WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input) AND copy_id = :copy_id::uuid
  AND deletion_id = :deletion_id::uuid AND revision = :revision::integer
  AND :time::timestamptz < restore_until
RETURNING copy_id AS id;
