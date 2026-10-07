-- Seek replies in the existing projection, with the same score/time/placement
-- order as the thread renderer. Matching B-trees keep ORDER BY + LIMIT bounded:
-- https://www.postgresql.org/docs/current/indexes-ordering.html
-- The thread reader uses UUIDv7 milliseconds and time zero for legacy IDs;
-- relay delivery timestamps belong to the feed, not this sibling order.
CREATE FUNCTION access.realm_reply_time(_placement text) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN CASE WHEN right(_placement,36) ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN ('x'||substr(right(_placement,36),1,8)||substr(right(_placement,36),10,4))::bit(48)::bigint
    ELSE 0 END;
CREATE FUNCTION access.realm_reply_best(_score integer,_placement text) RETURNS double precision
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN -(sign(_score)*log(1+abs(_score::double precision))+access.realm_reply_time(_placement)/86400000.0);

CREATE INDEX realm_reply_sibling_best ON access.realm_thread_reference
  (data_epoch,realm,parent,access.realm_reply_best(score,placement),
    (-access.realm_reply_time(placement)),placement COLLATE "C") INCLUDE(reply)
  WHERE active AND parent IS NOT NULL;
CREATE INDEX realm_reply_sibling_top ON access.realm_thread_reference
  (data_epoch,realm,parent,(-score::double precision),
    (-access.realm_reply_time(placement)),placement COLLATE "C") INCLUDE(reply)
  WHERE active AND parent IS NOT NULL;
CREATE INDEX realm_reply_sibling_new ON access.realm_thread_reference
  (data_epoch,realm,parent,(-access.realm_reply_time(placement)),placement COLLATE "C") INCLUDE(reply)
  WHERE active AND parent IS NOT NULL;

-- Unrelated admission-population rebuilds cannot become a readiness scan.
CREATE INDEX realm_reply_projection_pending ON access.realm_thread_dirty(data_epoch,kind,resource)
  WHERE kind <> 'population';

-- A focus below a withdrawn ancestor has a different placement scope from the
-- opening discussion. Those bounded candidates still need ordered index seeks.
CREATE INDEX realm_reply_branch_best ON access.realm_thread_reference
  (data_epoch,realm,parent,access.realm_reply_best(score,placement),
    (-access.realm_reply_time(placement)),placement COLLATE "C") INCLUDE(reply);
CREATE INDEX realm_reply_branch_top ON access.realm_thread_reference
  (data_epoch,realm,parent,(-score::double precision),
    (-access.realm_reply_time(placement)),placement COLLATE "C") INCLUDE(reply);
CREATE INDEX realm_reply_branch_new ON access.realm_thread_reference
  (data_epoch,realm,parent,(-access.realm_reply_time(placement)),placement COLLATE "C") INCLUDE(reply);

-- Votes change sibling order without moving Graph or Content. A parent-local
-- token fences ranked walks; a recreated projection row cannot revive an old
-- cursor. No reply bodies or alternative order population are retained here.
ALTER TABLE access.realm_thread_reference
  ADD COLUMN sibling_rank_revision uuid NOT NULL DEFAULT gen_random_uuid();
-- Binary scope keys also prevent stale planner statistics from choosing the
-- unscoped reply-only index and scanning copies in other Realms or epochs.
CREATE INDEX realm_reply_sibling_revision ON access.realm_thread_reference
  (data_epoch COLLATE "C",realm COLLATE "C",reply COLLATE "C")
  INCLUDE(sibling_rank_revision);

CREATE FUNCTION access.realm_reply_sibling_rank_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.realm_thread_reference SET sibling_rank_revision=gen_random_uuid()
    WHERE data_epoch=NEW.data_epoch AND realm=NEW.realm AND reply=NEW.parent;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_reply_sibling_rank_changed
  AFTER UPDATE OF score,placement ON access.realm_thread_reference
  FOR EACH ROW WHEN (NEW.parent IS NOT NULL AND
    (OLD.score,OLD.placement) IS DISTINCT FROM (NEW.score,NEW.placement))
  EXECUTE FUNCTION access.realm_reply_sibling_rank_changed();

-- Revision-only writes must not refresh the parent's own ranking or propagate
-- another revision upwards. Preserve every existing projection input column.
CREATE OR REPLACE TRIGGER realm_thread_reference_changed AFTER INSERT OR UPDATE OF
  data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,score,replies,active
  ON access.realm_thread_reference FOR EACH ROW EXECUTE FUNCTION access.realm_thread_reference_changed();
