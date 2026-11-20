/* semantic.privacy-role */
WITH input AS (SELECT $5::text[] AS text_keys,$6::jsonb AS withdrawals,$7::bigint AS covered,$14::text AS release), population AS MATERIALIZED (
  -- The binding reader has compared the complete child scopes in this transaction.
  -- The native parent function also checks the live target, release family, sealed
  -- repair, prepared observation, home-4095 baseline and active owner epoch.
  SELECT 0 AS partition_no,p.registration AS coverage_registration,p.bootstrap AS coverage_bootstrap,
    p.generation,p.coverage_keys || i.text_keys || $12::text[] AS pending_keys,i.withdrawals AS book_withdrawals,
    least(i.covered,coalesce($8::bigint,i.covered)) AS since
  FROM input i CROSS JOIN LATERAL semantic.public_filter_published_coverage($1,$2,$3,$4,i.text_keys) p
  JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(0,$9,$10)
  WHERE s.owner_epoch=$11 AND s.route_digest=$13 AND p.generation >= i.covered AND i.covered >= p.covered_generation
    AND (EXISTS (SELECT 1 FROM semantic.definition_release WHERE route=0 AND digest=i.release)
      OR EXISTS (SELECT 1 FROM semantic.release_composite WHERE digest=i.release))
    -- A withdrawn ID can be completely absent from the PIT. Its original home
    -- still participates in the independent start and final owner checks.
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(i.withdrawals) w(home integer,epoch integer,route integer,id uuid,visibility text,revision text)
      LEFT JOIN LATERAL (
        SELECT epoch,write_state FROM core.partition WHERE partition_no=w.home LIMIT 1
      ) owner ON true
      LEFT JOIN LATERAL (
        SELECT owner_epoch,population_fenced FROM semantic.public_filter_privacy_head WHERE partition_no=w.home LIMIT 1
      ) n ON true
      LEFT JOIN LATERAL (
        SELECT visibility,security_revision FROM semantic.subject WHERE (route,subject_id)=(w.route,w.id) LIMIT 1
      ) s ON true
      WHERE owner.write_state IS DISTINCT FROM 'active' OR owner.epoch IS DISTINCT FROM w.epoch
        OR n.owner_epoch IS DISTINCT FROM w.epoch OR n.population_fenced IS DISTINCT FROM false
        OR s.visibility IS DISTINCT FROM w.visibility OR s.security_revision::text IS DISTINCT FROM w.revision
    )
), pending AS MATERIALIZED (
  -- The exact complete compiler closure is persisted by the original definition
  -- writer. LIMIT precedes every receiver-summary or own-row lookup.
  SELECT partition_no FROM semantic.public_filter_privacy_pending
  WHERE live AND input_key=ANY((SELECT pending_keys FROM population)::text[]) LIMIT 1
), fenced AS MATERIALIZED (
  SELECT partition_no FROM semantic.public_filter_privacy_head
  WHERE population_fenced AND NOT EXISTS(SELECT 1 FROM pending) LIMIT 1
), behind AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch FROM population b
  CROSS JOIN LATERAL (
    SELECT source_home,source_epoch FROM semantic.public_filter_effective_homes(
      b.coverage_registration,b.coverage_bootstrap,NULL,CASE WHEN b.book_withdrawals IS NULL THEN 1 ELSE 9 END) h
    WHERE semantic.public_filter_book_withdrawal_covers(h,b.coverage_bootstrap,b.book_withdrawals) IS NOT TRUE
    ORDER BY source_home LIMIT 1
  ) h WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
), changed AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch FROM population b
  CROSS JOIN LATERAL (
    SELECT source_home,source_epoch FROM search.public_filter_coverage_home h
    WHERE (h.partition_no,h.registration)=(b.partition_no,b.coverage_registration)
      AND h.last_change_generation>b.since
    ORDER BY last_change_generation,source_home LIMIT 1
  ) h WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
    AND NOT EXISTS(SELECT 1 FROM behind)
), heads AS MATERIALIZED (
  SELECT 'pending'::text AS phase,h.source_home,h.source_epoch,
    n.owner_epoch AS current_epoch,n.position::text,n.population_fenced
  FROM behind h LEFT JOIN LATERAL (
    SELECT owner_epoch,position,population_fenced FROM semantic.public_filter_privacy_head WHERE partition_no=h.source_home LIMIT 1
  ) n ON true
  UNION ALL
  SELECT 'changed',h.source_home,h.source_epoch,n.owner_epoch,n.position::text,n.population_fenced
  FROM changed h LEFT JOIN LATERAL (
    SELECT owner_epoch,position,population_fenced FROM semantic.public_filter_privacy_head WHERE partition_no=h.source_home LIMIT 1
  ) n ON true
)
SELECT p.coverage_registration,p.coverage_bootstrap,p.generation,
  EXISTS(SELECT 1 FROM pending) AS pending,EXISTS(SELECT 1 FROM fenced) AS fenced,
  coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM heads h),'[]'::jsonb) AS heads
FROM population p
