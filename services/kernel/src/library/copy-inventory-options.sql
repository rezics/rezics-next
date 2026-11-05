WITH RECURSIVE
input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :limit::integer AS max_options
),
kind_seed AS (
  SELECT copy.kind AS id,
         copy.copy_id AS "copyId",
         copy.kind AS "copyKind",
         copy.kind_profile_pin AS "profilePin",
         1 AS ordinal
  FROM library.copy AS copy
  CROSS JOIN input AS parameters
  WHERE copy.route = parameters.route
    AND copy.account_id = parameters.account_id
    AND copy.deletion_id IS NULL
    AND copy.kind IS NOT NULL
  ORDER BY copy.kind, copy.created_at, copy.copy_id
  LIMIT 1
),
kind_choices AS (
  SELECT * FROM kind_seed
  UNION ALL
  SELECT next.id, next."copyId", next."copyKind", next."profilePin", previous.ordinal + 1
  FROM kind_choices AS previous
  CROSS JOIN input AS parameters
  CROSS JOIN LATERAL (
    SELECT copy.kind AS id,
           copy.copy_id AS "copyId",
           copy.kind AS "copyKind",
           copy.kind_profile_pin AS "profilePin"
    FROM library.copy AS copy
    WHERE copy.route = parameters.route
      AND copy.account_id = parameters.account_id
      AND copy.deletion_id IS NULL
      AND copy.kind IS NOT NULL
      AND copy.kind > previous.id
    ORDER BY copy.kind, copy.created_at, copy.copy_id
    LIMIT 1
  ) AS next
  WHERE previous.ordinal < parameters.max_options
),
status_seed AS (
  SELECT copy.status AS id,
         copy.copy_id AS "copyId",
         copy.kind AS "copyKind",
         COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS "profilePin",
         1 AS ordinal
  FROM library.copy AS copy
  CROSS JOIN input AS parameters
  WHERE copy.route = parameters.route
    AND copy.account_id = parameters.account_id
    AND copy.deletion_id IS NULL
  ORDER BY copy.status, copy.created_at, copy.copy_id
  LIMIT 1
),
status_choices AS (
  SELECT * FROM status_seed
  UNION ALL
  SELECT next.id, next."copyId", next."copyKind", next."profilePin", previous.ordinal + 1
  FROM status_choices AS previous
  CROSS JOIN input AS parameters
  CROSS JOIN LATERAL (
    SELECT copy.status AS id,
           copy.copy_id AS "copyId",
           copy.kind AS "copyKind",
           COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS "profilePin"
    FROM library.copy AS copy
    WHERE copy.route = parameters.route
      AND copy.account_id = parameters.account_id
      AND copy.deletion_id IS NULL
      AND copy.status > previous.id
    ORDER BY copy.status, copy.created_at, copy.copy_id
    LIMIT 1
  ) AS next
  WHERE previous.ordinal < parameters.max_options
)
SELECT 'kind'::text AS dimension, id, "copyId", "copyKind", "profilePin"
FROM kind_choices
UNION ALL
SELECT 'status'::text AS dimension, id, "copyId", "copyKind", "profilePin"
FROM status_choices
ORDER BY dimension, id;
