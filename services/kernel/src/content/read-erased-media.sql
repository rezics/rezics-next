-- Immutable cleanup facts only, after independently anchoring this partition.
-- Publication holds the media row lock through all puts and terminal commit;
-- an active snapshot is fenced without waiting for or authorizing that work.
SELECT erased, state
FROM content.media
WHERE route = :route::integer AND media_id = :media_id::uuid;
