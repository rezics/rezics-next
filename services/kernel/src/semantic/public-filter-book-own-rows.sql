/* semantic.own-rows */
WITH withdrawal AS (SELECT $5::jsonb AS proof), keys AS MATERIALIZED (
  SELECT * FROM unnest($1::uuid[],$2::integer[]) k(id,home)
), homes AS MATERIALIZED (
  SELECT k.home,n.owner_epoch,n.population_fenced,b.source_epoch,b.source_position
  FROM (SELECT DISTINCT home FROM keys) k
  LEFT JOIN LATERAL (
    SELECT b.source_epoch,b.source_position FROM search.public_filter_original_home(0,$3,$4,k.home) b LIMIT 1
  ) b ON true
  LEFT JOIN LATERAL (
    SELECT n.owner_epoch,n.population_fenced FROM semantic.public_filter_privacy_head n WHERE n.partition_no=k.home LIMIT 1
  ) n ON true
), subjects AS MATERIALIZED (
  SELECT k.id,k.home,v.route,v.position,v.owner_epoch,h.source_epoch,h.source_position,
    (SELECT proof FROM withdrawal) @> jsonb_build_array(jsonb_build_object('id',k.id)) AS withdrawn,
    h.population_fenced IS FALSE AND h.owner_epoch=h.source_epoch AS home_valid
  FROM keys k JOIN homes h ON h.home=k.home LEFT JOIN LATERAL (
    SELECT v.route,v.position,v.owner_epoch FROM semantic.public_filter_privacy_subject v
    WHERE (v.partition_no,v.subject_id)=(k.home,k.id) LIMIT 1
  ) v ON true
)
SELECT s.id,s.position>s.source_position AND (SELECT proof FROM withdrawal) IS NOT NULL AS check_birth,
  s.home_valid AND NOT coalesce(s.withdrawn,false) AND s.owner_epoch=s.source_epoch
    AND (s.position<=s.source_position OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset((SELECT proof FROM withdrawal)) w(home integer,epoch integer,"position" bigint,command bigint)
      JOIN semantic.subject original ON (original.route,original.subject_id)=(s.route,s.id)
      CROSS JOIN LATERAL (
        SELECT birth.epoch,birth.position FROM editorial.write_basis birth
        WHERE (birth.partition_no,birth.transaction_id)=(w.home,original.recorded_transaction_id) LIMIT 1
      ) birth
      WHERE (w.home,w.epoch,w.position)=(s.home,s.owner_epoch,s.position)
        AND birth.epoch=w.epoch AND birth.position>w.command
    )) AS admitted
FROM subjects s
