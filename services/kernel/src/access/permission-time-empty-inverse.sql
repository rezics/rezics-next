-- A complete empty inverse needs no role evidence. A nonempty or unknown range takes the full preparation path.
WITH member AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS id)
SELECT COALESCE(NULLIF(:at::text, '')::timestamptz, clock_timestamp())::text AS at,
       clock_timestamp()::text AS "databaseAt",
       (EXISTS (
         SELECT 1 FROM access.membership_inverse_coverage
         WHERE route = member.route AND account_id = member.id AND complete
       ) AND NOT EXISTS (
         SELECT 1 FROM access.membership_inverse
         WHERE route = member.route AND account_id = member.id
       )) AS "emptyInverse"
FROM member;
