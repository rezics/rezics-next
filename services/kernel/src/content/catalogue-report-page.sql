WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :created_at::timestamptz AS after_at,
         :report_id::uuid AS after_id, :oldest::boolean AS oldest, :limit::integer AS page_limit
)
SELECT * FROM (
(SELECT report_route, report_id, target_kind, subject_id AS target_id,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
 FROM content.catalogue_report_candidate
 WHERE route = (SELECT route FROM input) AND NOT (SELECT oldest FROM input)
   AND (created_at, report_id) < ((SELECT after_at FROM input), (SELECT after_id FROM input))
 ORDER BY created_at DESC, report_id DESC LIMIT (SELECT page_limit FROM input))
UNION ALL
(SELECT report_route, report_id, target_kind, subject_id AS target_id,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
 FROM content.catalogue_report_candidate
 WHERE route = (SELECT route FROM input) AND (SELECT oldest FROM input)
   AND (created_at, report_id) > ((SELECT after_at FROM input), (SELECT after_id FROM input))
 ORDER BY created_at ASC, report_id ASC LIMIT (SELECT page_limit FROM input))
) AS candidates
ORDER BY CASE WHEN (SELECT oldest FROM input) THEN created_at END ASC,
         CASE WHEN NOT (SELECT oldest FROM input) THEN created_at END DESC,
         CASE WHEN (SELECT oldest FROM input) THEN report_id END ASC,
         CASE WHEN NOT (SELECT oldest FROM input) THEN report_id END DESC;
