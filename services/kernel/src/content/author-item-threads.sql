-- Split the mixed-direction keyset into two disjoint index seeks. Their combined
-- limit is the scan budget, even when many rows share the cursor's timestamp.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :author_account_id::uuid AS author_account_id,
         :has_after::boolean AS has_after, :after_at::timestamptz AS after_at,
         :after_item_id::uuid AS after_item_id, :limit::integer AS page_limit, :kind::text AS kind
), tied AS MATERIALIZED (
  SELECT candidate.item_id, candidate.thread_id, candidate.created_at
  FROM content.author_item AS candidate CROSS JOIN input
  WHERE candidate.route = input.route AND candidate.author_account_id = input.author_account_id
    AND candidate.item_kind = 'thread' AND candidate.thread_kind = input.kind
    AND input.has_after AND candidate.created_at = input.after_at
    AND candidate.item_id > input.after_item_id
  ORDER BY candidate.item_id
  LIMIT (SELECT page_limit FROM input)
), older AS (
  SELECT candidate.item_id, candidate.thread_id, candidate.created_at
  FROM content.author_item AS candidate CROSS JOIN input
  WHERE candidate.route = input.route AND candidate.author_account_id = input.author_account_id
    AND candidate.item_kind = 'thread' AND candidate.thread_kind = input.kind
    AND candidate.created_at < input.after_at
  ORDER BY candidate.created_at DESC, candidate.item_id
  LIMIT ((SELECT page_limit FROM input) - (SELECT count(*) FROM tied))
)
SELECT item_id, thread_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM (SELECT * FROM tied UNION ALL SELECT * FROM older) AS page
ORDER BY page.created_at DESC, item_id;
