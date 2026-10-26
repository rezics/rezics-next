-- unbound: Global partition only: one exact group/time temporal primary-key seek.
WITH authority AS MATERIALIZED (
  SELECT :at::timestamptz AS at
)
SELECT authority.at::text AS at,
       EXISTS (
         SELECT 1
         FROM access.exposure_opening opening
         WHERE opening.route = 0 AND opening."group" = :group
           AND opening.valid @> authority.at
       ) AS open
FROM authority;
