-- Same native owner lock as ordinary cleanup; generation is current, not the old capture generation.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :incarnation::text AS incarnation, :account_id::uuid AS account_id,
         :purge_after::nullable(timestamptz) AS purge_after, :time::timestamptz AS at
), stored AS MATERIALIZED (
  SELECT c.curator_account_id::text AS "accountId",
         c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text AS incarnation,
         c.source_generation::text AS generation, c.state, c.membership_kind AS kind, c.builtin_kind AS builtin,
         c.visibility, c.deletion_id::text AS "deletionId", c.revision,
         c.purge_after = i.purge_after AS "deadlineMatches",
         c.deleted_at IS NOT NULL AND c.purge_after = c.deleted_at + interval '720 hours'
           AND c.purge_after <= i.at AS due,
         EXISTS (SELECT 1 FROM library.collection_source_output o
                 WHERE o.route = c.route AND o.collection_id = c.collection_id)
         OR c.visibility = 'public' OR c.listing_ever_public OR EXISTS (
           SELECT 1 FROM library.collection_listing_history h
           WHERE h.route = c.route AND h.collection_id = c.collection_id
         ) AS "publicCustody"
  FROM library.collection c CROSS JOIN input i
  WHERE c.route = i.route AND c.collection_id = i.collection_id
    AND c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text = i.incarnation
  FOR UPDATE OF c
), logical AS MATERIALIZED (
  SELECT h.account_id::text, i.incarnation, h.generation::text, 'active', 'dynamic', 'everything', 'private',
         NULL::text, 0, NULL::boolean, false, false
  FROM library.fact_source_head h CROSS JOIN input i
  WHERE h.route = i.route AND h.account_id = i.account_id
    AND library.everything_source_id(h.account_id) = i.collection_id
    AND i.incarnation = i.collection_id::text || ':everything'
  FOR UPDATE OF h
)
SELECT * FROM stored UNION ALL SELECT * FROM logical;
