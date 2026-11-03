WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :session_id::uuid AS session_id
), owned AS MATERIALIZED (
  SELECT session_id
  FROM library.progress_session
  WHERE route = (SELECT route FROM input)
    AND session_id = (SELECT session_id FROM input)
    AND state <> 'retired' AND account_id = :account_id::uuid
), page AS MATERIALIZED (
  SELECT change.change_no, change.recorded_at
  FROM library.progress_change AS change
  WHERE change.route = (SELECT route FROM input)
    AND change.session_id = (SELECT session_id FROM input)
    AND EXISTS (SELECT 1 FROM owned)
    AND change.change_no > :after_change_no::bigint
  ORDER BY change.change_no
  LIMIT :page_limit::integer
)
SELECT EXISTS (SELECT 1 FROM owned) AS owned,
       count(*)::integer AS count,
       max(change_no) AS after,
       to_char(max(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastChangedAt"
FROM page;
