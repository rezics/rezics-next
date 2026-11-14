-- One bounded exact owner episode. More than one origin for the same preparation is ambiguous.
-- Bound the indexed episode keys BEFORE eligibility joins/filters, including
-- invalidated rows. Ambiguous retained keys cannot select a different original.
WITH input AS (
  SELECT :route::integer AS route, :owner_account_id::uuid AS owner_account_id,
         :collection_id::uuid AS collection_id, :preparation_id::uuid AS preparation_id,
         :deadline_at::text::bigint AS deadline_at
), candidates AS MATERIALIZED (
  SELECT candidate.reference_id
  FROM library.collection_kind_consent_consumer AS candidate CROSS JOIN input
  WHERE candidate.route=input.route AND candidate.owner_account_id=input.owner_account_id
    AND candidate.collection_id=input.collection_id AND candidate.preparation_id=input.preparation_id
  ORDER BY candidate.reference_id LIMIT 2
)
SELECT consumer.reference_id AS "referenceId",
       consumer.origin_id AS "originId",
       original.audience,
       original.expires_at::text AS "expiresAt",
       consumer.source_generation::text AS "sourceGeneration",
       consumer.capture_generation::text AS "captureGeneration",
       consumer.source_capture AS "sourceCapture",
       consumer.enrollment_generation::text AS "enrollmentGeneration",
       consumer.catalogue_root AS "catalogueRoot",
       consumer.restore_generation::text AS "restoreGeneration",
       consumer.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
         AND original.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
         AND observation.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid AS committed,
       collection.source_generation::text AS "currentSourceGeneration",
       collection.state AS "collectionState"
FROM input CROSS JOIN candidates AS episode
JOIN library.collection_kind_consent_consumer AS consumer
  ON (consumer.route,consumer.reference_id)=(input.route,episode.reference_id)
JOIN library.collection AS collection
  ON (collection.route,collection.collection_id,collection.curator_account_id)=
     (consumer.route,consumer.collection_id,consumer.owner_account_id)
JOIN library.collection_kind_audience_origin AS original
  ON (original.route,original.origin_id,original.owner_account_id,original.collection_id,original.preparation_id)=
     (consumer.route,consumer.origin_id,consumer.owner_account_id,consumer.collection_id,consumer.preparation_id)
JOIN library.collection_kind_observation AS observation
  ON (observation.route,observation.collection_id,observation.audience)=
     (original.route,original.collection_id,original.audience)
WHERE consumer.route=input.route
  AND (SELECT count(*) FROM candidates)=1
  AND consumer.owner_account_id=input.owner_account_id
  AND consumer.collection_id=input.collection_id
  AND consumer.preparation_id=input.preparation_id
  AND consumer.invalidated=false AND NOT original.cancelled
  AND original.source_generation=consumer.source_generation
  AND original.source_capture=consumer.source_capture
  AND original.deadline_at=input.deadline_at
  AND original.expires_at>clock_timestamp()
  AND observation.generation=consumer.preparation_id
  AND observation.account_id=consumer.owner_account_id
  AND observation.source_generation=consumer.source_generation
  AND observation.capture=consumer.source_capture
  AND collection.state='active'
  AND collection.source_generation=consumer.source_generation
ORDER BY consumer.reference_id
LIMIT 2
FOR UPDATE OF consumer,collection,original,observation;
