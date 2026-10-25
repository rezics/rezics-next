WITH args AS (
  SELECT :route::integer AS route,
         :session_id::uuid AS session_id,
         :after_unit_id::text AS after_unit_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
)
SELECT unit.route,
       unit.session_id AS "sessionId",
       unit.unit_id AS "unitId",
       unit.added_at::text AS "addedAt"
FROM library.progress_unit AS unit
CROSS JOIN args
WHERE unit.route = args.route
  AND unit.session_id = args.session_id
  AND (NOT args.has_cursor OR unit.unit_id > args.after_unit_id)
ORDER BY unit.unit_id
LIMIT (SELECT page_limit FROM args);
