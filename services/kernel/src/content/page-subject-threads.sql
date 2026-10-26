WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :place_id::uuid AS place_id,
         :kind::text AS kind,
         :has_after::boolean AS has_after,
         :after_at::timestamptz AS after_at,
         :after_thread_id::uuid AS after_thread_id,
         :limit::integer AS page_limit
)
SELECT candidate.thread_id,
       to_char(candidate.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at
FROM input
JOIN content.subject_thread AS candidate
  ON candidate.route = input.route
 AND candidate.subject_id = input.subject_id
 AND candidate.place_id = input.place_id
 AND candidate.kind = input.kind
WHERE NOT input.has_after
   OR candidate.last_activity_at < input.after_at
   OR (candidate.last_activity_at = input.after_at AND candidate.thread_id > input.after_thread_id)
ORDER BY candidate.last_activity_at DESC, candidate.thread_id ASC
LIMIT (SELECT page_limit FROM input);
