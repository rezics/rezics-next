INSERT INTO commerce.subject_offer_reference
(route, subject_id, offer_id, original_subject_id, source_revision, identity_epoch, listed)
VALUES (:route::integer, :subject::uuid, :offer::uuid, :original::uuid, :revision::integer, :epoch::bigint, :listed::boolean)
ON CONFLICT (route, subject_id, offer_id) DO UPDATE SET
 source_revision = EXCLUDED.source_revision, identity_epoch = EXCLUDED.identity_epoch, listed = EXCLUDED.listed,
 version = commerce.subject_offer_reference.version + 1
WHERE commerce.subject_offer_reference.original_subject_id = EXCLUDED.original_subject_id
  AND commerce.subject_offer_reference.source_revision <= EXCLUDED.source_revision
  AND commerce.subject_offer_reference.version = :version::bigint
RETURNING version::text AS version;
