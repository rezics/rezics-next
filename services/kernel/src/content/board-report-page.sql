WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :board_id::uuid AS board_id,
         :created_at::timestamptz AS after_at, :report_id::uuid AS after_id,
         :oldest::boolean AS oldest, :limit::integer AS page_limit
)
SELECT * FROM (
(SELECT candidate.report_route, candidate.report_id, candidate.target_kind, candidate.target_id,
        to_char(candidate.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
 FROM content.board_report_candidate AS candidate
 WHERE candidate.route = (SELECT route FROM input) AND candidate.board_id = (SELECT board_id FROM input)
   AND NOT (SELECT oldest FROM input)
   AND (candidate.created_at, candidate.report_id) < ((SELECT after_at FROM input), (SELECT after_id FROM input))
 ORDER BY candidate.created_at DESC, candidate.report_id DESC
 LIMIT (SELECT page_limit FROM input))
UNION ALL
(SELECT candidate.report_route, candidate.report_id, candidate.target_kind, candidate.target_id,
        to_char(candidate.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
 FROM content.board_report_candidate AS candidate
 WHERE candidate.route = (SELECT route FROM input) AND candidate.board_id = (SELECT board_id FROM input)
   AND (SELECT oldest FROM input)
   AND (candidate.created_at, candidate.report_id) > ((SELECT after_at FROM input), (SELECT after_id FROM input))
 ORDER BY candidate.created_at ASC, candidate.report_id ASC
 LIMIT (SELECT page_limit FROM input))
) AS candidates
ORDER BY CASE WHEN (SELECT oldest FROM input) THEN candidates.created_at END ASC,
         CASE WHEN NOT (SELECT oldest FROM input) THEN candidates.created_at END DESC,
         CASE WHEN (SELECT oldest FROM input) THEN candidates.report_id END ASC,
         CASE WHEN NOT (SELECT oldest FROM input) THEN candidates.report_id END DESC;
