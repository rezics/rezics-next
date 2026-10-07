-- Seek replies in the existing projection, with the same score/time/placement
-- order as the thread renderer. Matching B-trees keep ORDER BY + LIMIT bounded:
-- https://www.postgresql.org/docs/current/indexes-ordering.html
CREATE FUNCTION access.realm_reply_time(_time timestamptz) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN round(extract(epoch FROM _time)*1000)::bigint;
CREATE FUNCTION access.realm_reply_best(_score integer,_time timestamptz) RETURNS double precision
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN -(sign(_score)*log(1+abs(_score::double precision))+access.realm_reply_time(_time)/86400000.0);

CREATE INDEX realm_reply_sibling_best ON access.realm_thread_reference
  (data_epoch,realm,parent,access.realm_reply_best(score,occurred_at),
    (-access.realm_reply_time(occurred_at)),placement COLLATE "C") INCLUDE(reply)
  WHERE active AND parent IS NOT NULL;
CREATE INDEX realm_reply_sibling_top ON access.realm_thread_reference
  (data_epoch,realm,parent,(-score::double precision),
    (-access.realm_reply_time(occurred_at)),placement COLLATE "C") INCLUDE(reply)
  WHERE active AND parent IS NOT NULL;
CREATE INDEX realm_reply_sibling_new ON access.realm_thread_reference
  (data_epoch,realm,parent,(-access.realm_reply_time(occurred_at)),placement COLLATE "C") INCLUDE(reply)
  WHERE active AND parent IS NOT NULL;

-- Unrelated admission-population rebuilds cannot become a readiness scan.
CREATE INDEX realm_reply_projection_pending ON access.realm_thread_dirty(data_epoch,kind,resource)
  WHERE kind <> 'population';
