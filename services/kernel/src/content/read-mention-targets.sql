WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :post_id::uuid AS post_id, :thread_id::uuid AS thread_id
), chain AS (
  SELECT p.post_id, p.reply_to_post_id, p.visibility, p.availability, 0 AS depth,
         ARRAY[p.post_id] AS seen
  FROM content.post p
  CROSS JOIN input
  WHERE p.route = input.route AND p.post_id = input.post_id
  UNION ALL
  SELECT parent.post_id, parent.reply_to_post_id, parent.visibility, parent.availability,
         chain.depth + 1, chain.seen || parent.post_id
  FROM chain
  CROSS JOIN input
  JOIN content.post parent ON parent.route = input.route AND parent.post_id = chain.reply_to_post_id
  WHERE chain.depth < 32 AND NOT parent.post_id = ANY(chain.seen)
)
SELECT 'thread'::text AS kind, t.thread_id::text AS id, t.visibility, t.availability,
       NULL::text AS reply_to_post_id, -1 AS depth
FROM content.thread t
JOIN input ON true
WHERE t.route = input.route AND t.thread_id = input.thread_id
UNION ALL
SELECT 'post'::text AS kind, chain.post_id::text AS id, chain.visibility, chain.availability,
       chain.reply_to_post_id::text, chain.depth
FROM chain
UNION ALL
SELECT 'board'::text AS kind, b.board_id::text AS id, b.visibility, 'available'::text AS availability,
       NULL::text AS reply_to_post_id, 33 AS depth
FROM content.thread t
JOIN input ON true
JOIN content.board b ON b.route = t.route AND b.board_id = t.board_id
WHERE t.route = input.route AND t.thread_id = input.thread_id
ORDER BY depth;
