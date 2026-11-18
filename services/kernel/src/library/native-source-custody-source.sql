WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :incarnation::text AS incarnation, :account_id::uuid AS account_id, :retained::boolean AS retained
), stored AS MATERIALIZED (
  SELECT c.curator_account_id::text AS "accountId",
         c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text AS incarnation,
         c.source_generation::text AS generation, c.state, c.membership_kind AS kind, c.builtin_kind AS builtin,
         c.visibility, (c.rule_filter IS NOT NULL AND c.rule_sort = 'id' AND c.rule_release_digest IS NOT NULL) AS "ruleReady"
  FROM library.collection c CROSS JOIN input i
  WHERE c.route = i.route AND c.collection_id = i.collection_id
    AND c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text = i.incarnation
  FOR SHARE OF c
), logical AS MATERIALIZED (
  SELECT s.account_id::text, s.incarnation, s.generation::text, 'active', 'dynamic', 'everything', 'private', false
  FROM library.logical_everything_source s CROSS JOIN input i
  WHERE NOT i.retained AND s.route = i.route AND s.collection_id = i.collection_id AND s.incarnation = i.incarnation
  FOR SHARE OF s
), held_owner AS MATERIALIZED (
  -- Release/revalidate only an existing exact obligation after a source change or materialization.
  SELECT h.account_id::text, i.incarnation, h.generation::text, 'active', 'dynamic', 'everything', 'private', false
  FROM library.fact_source_head h CROSS JOIN input i
  WHERE i.retained AND h.route = i.route AND h.account_id = i.account_id
    AND library.everything_source_id(h.account_id) = i.collection_id
    AND i.incarnation = i.collection_id::text || ':everything'
  FOR SHARE OF h
)
SELECT * FROM stored UNION ALL SELECT * FROM logical UNION ALL SELECT * FROM held_owner;
