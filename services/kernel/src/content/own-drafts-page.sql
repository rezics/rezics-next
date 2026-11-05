-- Two disjoint prefix seeks spend a single raw budget, including timestamp ties.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
    :after_at::timestamptz AS after_at, :after_id::uuid AS after_id, :limit::integer AS page_limit
), tied AS MATERIALIZED (
  SELECT a.item_id,a.thread_id,a.created_at,a.draft_revision_id,a.draft_language
  FROM content.author_item a CROSS JOIN input i
  WHERE a.route=i.route AND a.author_account_id=i.account_id
    AND a.item_kind='post' AND a.draft_state='draft'
    AND a.created_at=i.after_at AND a.item_id>i.after_id
  ORDER BY a.item_id LIMIT (SELECT page_limit FROM input)
), older AS (
  SELECT a.item_id,a.thread_id,a.created_at,a.draft_revision_id,a.draft_language
  FROM content.author_item a CROSS JOIN input i
  WHERE a.route=i.route AND a.author_account_id=i.account_id
    AND a.item_kind='post' AND a.draft_state='draft' AND a.created_at<i.after_at
  ORDER BY a.created_at DESC,a.item_id
  LIMIT ((SELECT page_limit FROM input)-(SELECT count(*) FROM tied))
)
SELECT item_id,thread_id,draft_revision_id,draft_language,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM (SELECT * FROM tied UNION ALL SELECT * FROM older) page
ORDER BY created_at DESC,item_id;
