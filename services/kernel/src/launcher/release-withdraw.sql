-- unbound: a Global exact immutable release seek and at most one update.
WITH input AS MATERIALIZED (
    SELECT :package_id::text AS package_id, :release_id::text AS release_id, :at::timestamptz AS at
), retired AS (
    UPDATE launcher.release AS release SET withdrawn_at = input.at
    FROM input
    WHERE release.package_id = input.package_id AND release.id = input.release_id AND release.withdrawn_at IS NULL
    RETURNING release.id
)
SELECT EXISTS (SELECT 1 FROM retired) AS changed,
       EXISTS (
           SELECT 1 FROM launcher.release AS release
           JOIN input ON release.package_id = input.package_id AND release.id = input.release_id
       ) AS present;
