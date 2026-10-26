-- Keep containment as a row filter so the open-key index supplies the point read.
SELECT lower(valid) AS since, reservation_id::text AS "reservationId"
FROM community.realm_member
WHERE route = :route::integer
  AND realm_id = :realm_id::uuid
  AND account_id = :account_id::uuid
  AND (valid @> :at::timestamptz) IS TRUE
  AND upper_inf(valid);
