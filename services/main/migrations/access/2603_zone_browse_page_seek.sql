-- Candidate windows must keep their ordered index even when a small table's
-- estimates favor a bitmap scan and a sort of the whole Realm inventory.
CREATE FUNCTION access.seek_zone_browse_page(_realm text,_sort text,_key text,_work text,_nulls boolean,_limit integer)
RETURNS TABLE(work text,adopted_order text,updated_at text,word_count text)
LANGUAGE plpgsql STABLE SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
DECLARE predicate text; ordering text;
BEGIN
  IF _sort NOT IN ('newest','updated') OR _limit<1 OR _limit>64 THEN
    RAISE EXCEPTION 'invalid Zone browse seek';
  END IF;
  IF _sort='newest' THEN
    ordering:='entry.adopted_order DESC,entry.work DESC';
    predicate:=CASE WHEN _work IS NULL THEN '' ELSE 'AND (entry.adopted_order,entry.work)<($2::numeric,$3::text)' END;
  ELSIF _nulls THEN
    ordering:='entry.work DESC';
    predicate:='AND entry.updated_at IS NULL'||CASE WHEN _work IS NULL THEN '' ELSE ' AND entry.work<$3::text' END;
  ELSE
    ordering:='entry.updated_at DESC NULLS LAST,entry.work DESC';
    predicate:='AND entry.updated_at IS NOT NULL'||CASE WHEN _work IS NULL THEN '' ELSE ' AND (entry.updated_at,entry.work)<($2::timestamptz,$3::text)' END;
  END IF;
  RETURN QUERY EXECUTE format('SELECT entry.work,entry.adopted_order::text,
    to_char(entry.updated_at AT TIME ZONE ''UTC'',''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''),entry.word_count::text
    FROM access.zone_browse_entry entry WHERE entry.realm=$1 %s ORDER BY %s LIMIT $4',predicate,ordering)
    USING _realm,_key,_work,_limit;
END $$;
