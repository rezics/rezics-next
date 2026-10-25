WITH authority AS MATERIALIZED (
  SELECT :at::timestamptz AS at
)
SELECT authority.at::text AS at,
       EXISTS (
         SELECT 1
         FROM access.exposure_opening opening
         WHERE opening."group" = :group
           AND opening.valid @> authority.at
       ) AS open
FROM authority;
