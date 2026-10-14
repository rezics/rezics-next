-- A page closes only the replies it selected, including bounded ancestor context.
-- Enumerating the whole opener population here made every continuation grow
-- with total thread size. Exact parent/work/placement probes retain removal fences.
DROP FUNCTION access.read_realm_thread_scope_cut(text,text,text,uuid,bigint,numeric,text);

CREATE FUNCTION access.read_realm_thread_scope_cut(
  _epoch text,_realm text,_replies text[],_content_epoch uuid,_content_sequence bigint,
  _main_sequence numeric,_population text DEFAULT NULL)
RETURNS TABLE(ready boolean)
LANGUAGE sql VOLATILE SET enable_bitmapscan=off SET enable_seqscan=off AS $$
  WITH fence AS MATERIALIZED (SELECT open FROM access.recovery_fence WHERE id FOR SHARE),
  dependencies AS MATERIALIZED (SELECT r.reply,r.work,r.parent,r.placement
    FROM unnest(_replies) AS selected(reply)
    CROSS JOIN LATERAL (SELECT reply,work,parent,placement FROM access.realm_thread_reference
      WHERE data_epoch=_epoch AND realm=_realm AND reply=selected.reply LIMIT 1) r
    WHERE (_population IS NULL OR EXISTS(SELECT 1 FROM access.realm_thread_population_admission a
        WHERE a.data_epoch=_epoch AND a.realm=_realm AND a.population=_population
          AND a.reply=r.reply AND a.admitted)))
  SELECT fence.open AND c.content_epoch=_content_epoch
    AND c.content_sequence<=_content_sequence AND c.sequence<=_main_sequence
    AND (s.realm IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access.feed_item
      WHERE data_epoch=_epoch AND realm=_realm AND kind IN ('reply','discussion')
        AND NOT realm_thread_indexed LIMIT 1))
    AND (_population IS NULL OR EXISTS(SELECT 1 FROM access.realm_thread_population p
      WHERE p.data_epoch=_epoch AND p.realm=_realm AND p.population=_population AND p.ready))
    AND NOT EXISTS(SELECT 1 FROM access.realm_thread_dirty
      WHERE data_epoch=_epoch AND kind='realm' AND resource=_realm AND effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='reply' AND d.resource=r.reply AND d.effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='placement' AND d.effect='removal' AND (
        (d.resource COLLATE "C">=_realm||'|'||r.reply AND d.resource COLLATE "C"<=_realm||'|'||r.reply||'|￿')
        OR (d.resource COLLATE "C">=_realm||'|'||r.parent AND d.resource COLLATE "C"<=_realm||'|'||r.parent||'|￿')))
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='work' AND d.resource=r.work AND d.effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.realm_thread_dirty d
      ON d.data_epoch=_epoch AND d.kind='parent' AND d.resource=r.parent AND d.effect='removal')
    AND NOT EXISTS(SELECT 1 FROM dependencies r JOIN access.feed_item f
      ON f.data_epoch=_epoch AND f.id=r.placement WHERE NOT f.realm_thread_indexed) AS ready
  FROM fence LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=_epoch
    LEFT JOIN access.realm_thread_state s ON s.data_epoch=_epoch AND s.realm=_realm;
$$;

