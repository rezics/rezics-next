SELECT digest, CASE WHEN digest = ANY(:missing::text[]) THEN body END AS body
FROM semantic.definition_release
WHERE route = 0 AND digest = ANY(:digests::text[])
  AND (NOT :require_active_home::boolean OR EXISTS (SELECT 1 FROM core.partition WHERE partition_no=0 AND write_state='active'));
