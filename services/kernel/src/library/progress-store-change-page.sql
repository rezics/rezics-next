WITH args AS (
  SELECT :route::integer AS route,
         :session_id::uuid AS session_id,
         :after_change_no::integer AS after_change_no,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
)
SELECT change.route,
       change.session_id AS "sessionId",
       change.change_no AS "changeNo",
       change.intent,
       change.recorded_at::text AS "recordedAt",
       change.transaction_id AS "transactionId"
FROM library.progress_change AS change
CROSS JOIN args
WHERE change.route = args.route
  AND change.session_id = args.session_id
  AND (NOT args.has_cursor OR change.change_no > args.after_change_no)
ORDER BY change.change_no
LIMIT (SELECT page_limit FROM args);
