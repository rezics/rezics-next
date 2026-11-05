-- Keep a live CAS fence: deleting a moved locator would let an older writer recreate it.
UPDATE commerce.subject_offer_reference
SET listed = false, identity_epoch = :epoch::bigint,
 source_revision = greatest(source_revision, :revision::integer), version = version + 1
WHERE route = :route::integer AND subject_id = :subject::uuid AND offer_id = :offer::uuid
 AND original_subject_id = :original::uuid AND version = :version::bigint;
