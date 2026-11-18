-- Bound the entire compact prefix or Global replacement selection BEFORE enumerating a key.
-- The outer row survives an empty selection. A slot beyond the allowance yields no head.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,:subject::uuid AS id,:slot::uuid AS slot,:width::integer AS width
), head AS MATERIALIZED (
  SELECT f.operation,f.log_seq,a.head,a.mode,a.selection,a.erasure_key,
         CASE WHEN f.operation='expand' THEN
           CASE WHEN a.mode='replace' THEN jsonb_array_length(a.selection) ELSE 0 END
         ELSE coalesce(f.log_seq,0) END AS raw_count
  FROM input i
  LEFT JOIN LATERAL (SELECT operation,log_seq FROM semantic.fact
    WHERE (route,subject_id,slot_id)=(i.route,i.id,i.slot) ORDER BY log_seq DESC LIMIT 1) f ON true
  LEFT JOIN LATERAL (SELECT head,mode,selection,erasure_key FROM semantic.adoption
    WHERE f.operation='expand' AND (route,subject_id,slot_id)=(i.route,i.id,i.slot)
      AND context_id='00000000-0000-8000-8000-000000000000' ORDER BY head DESC LIMIT 1) a ON true
), admitted AS MATERIALIZED (
  SELECT h.* FROM head h, input i WHERE h.raw_count <= i.width
)
SELECT h.operation AS slot_operation,h.log_seq,h.head,h.mode,h.erasure_key::text AS adoption_key,
       h.raw_count,raw.ordinal,raw.witness,raw.rank
FROM admitted h CROSS JOIN input i LEFT JOIN LATERAL (
  SELECT f.log_seq AS ordinal,f.statement_id AS witness,NULL::text AS rank
  FROM semantic.fact f WHERE h.operation <> 'expand' AND
    (f.route,f.subject_id,f.slot_id)=(i.route,i.id,i.slot) AND f.log_seq <= h.log_seq
  UNION ALL
  SELECT s.ordinal::integer,
         CASE WHEN octet_length(s.entry->>'candidate')=36
           AND s.entry->>'candidate' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (s.entry->>'candidate')::uuid END,
         CASE WHEN s.entry->>'rank' IN ('normal','preferred') THEN s.entry->>'rank' END
  FROM jsonb_array_elements(CASE WHEN h.operation='expand' AND h.mode='replace'
       THEN h.selection ELSE '[]'::jsonb END) WITH ORDINALITY s(entry,ordinal)
) raw ON true;
