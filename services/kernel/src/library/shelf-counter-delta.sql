WITH native_input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :generation_id::uuid AS generation_id), deltas AS MATERIALIZED (
  SELECT bucket, type_id, sum(delta)::bigint AS delta
  FROM jsonb_to_recordset(:deltas::jsonb) AS d(bucket text, type_id uuid, delta bigint)
  GROUP BY bucket, type_id HAVING sum(delta) <> 0
), locked AS MATERIALIZED (
  SELECT c.bucket, c.type_id
  FROM library.shelf_count AS c
  WHERE c.route = (SELECT route FROM native_input) AND c.account_id = (SELECT account_id FROM native_input)
    AND c.generation_id = (SELECT generation_id FROM native_input)
    AND (c.bucket, c.type_id) IN (SELECT bucket, type_id FROM deltas)
  ORDER BY CASE WHEN c.bucket = 'all' AND c.type_id = '00000000-0000-0000-0000-000000000000'::uuid THEN 0 ELSE 1 END,
           c.bucket COLLATE "C", c.type_id
  FOR UPDATE
), updated AS (
  UPDATE library.shelf_count AS c SET n = c.n + d.delta
  FROM deltas AS d, locked AS l
  WHERE c.route = (SELECT route FROM native_input) AND c.account_id = (SELECT account_id FROM native_input) AND c.generation_id = (SELECT generation_id FROM native_input)
    AND c.bucket = d.bucket AND c.type_id = d.type_id AND (l.bucket, l.type_id) = (d.bucket, d.type_id)
  RETURNING c.bucket, c.type_id
)
INSERT INTO library.shelf_count(route, account_id, generation_id, bucket, type_id, n)
SELECT (SELECT route FROM native_input), (SELECT account_id FROM native_input), (SELECT generation_id FROM native_input), d.bucket, d.type_id, d.delta FROM deltas AS d
WHERE NOT EXISTS (SELECT FROM locked AS l WHERE (l.bucket, l.type_id) = (d.bucket, d.type_id))
ORDER BY CASE WHEN d.bucket = 'all' AND d.type_id = '00000000-0000-0000-0000-000000000000'::uuid THEN 0 ELSE 1 END,
         d.bucket COLLATE "C", d.type_id;
