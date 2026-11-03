-- migrate:up
-- Native projection repairs need not allocate a core publication position. Keep
-- their equality witness at the changed row's home, including board homes shared
-- by reviews in other partitions. This is not anonymous eligibility authority.
CREATE TABLE content.review_census_source_frontier (
  route integer PRIMARY KEY CHECK (route BETWEEN 0 AND 65535 AND route % 16=0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE FUNCTION content.advance_review_census_source_frontier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_route integer;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='thread' THEN
    IF TG_OP='INSERT' AND NEW.kind<>'review' THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' AND OLD.kind<>'review' THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND NEW.kind<>'review' AND OLD.kind<>'review' THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='board' THEN
    IF TG_OP='INSERT' AND NEW.purpose<>'reviews' THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' AND OLD.purpose<>'reviews' THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND NEW.purpose<>'reviews' AND OLD.purpose<>'reviews' THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='post' THEN
    IF NOT EXISTS (
      SELECT 1 FROM content.thread t
      WHERE t.route=COALESCE(NEW.route,OLD.route)
        AND t.thread_id=COALESCE(NEW.thread_id,OLD.thread_id) AND t.kind='review'
        AND t.first_post_id=COALESCE(NEW.post_id,OLD.post_id)
    ) THEN RETURN NULL; END IF;
  END IF;
  source_route := COALESCE(NEW.route,OLD.route)/16*16;
  INSERT INTO content.review_census_source_frontier(route,revision) VALUES(source_route,1)
  ON CONFLICT(route) DO UPDATE SET revision=content.review_census_source_frontier.revision+1;
  IF TG_OP='UPDATE' AND OLD.route/16<>NEW.route/16 THEN
    INSERT INTO content.review_census_source_frontier(route,revision) VALUES(OLD.route/16*16,1)
    ON CONFLICT(route) DO UPDATE SET revision=content.review_census_source_frontier.revision+1;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER review_census_thread_source AFTER INSERT OR DELETE OR UPDATE OF
  route,thread_id,kind,author_account_id,board_id,review_subject_id,title,security_revision,
  first_post_id,review_live,availability,visibility ON content.thread
  FOR EACH ROW EXECUTE FUNCTION content.advance_review_census_source_frontier();
CREATE TRIGGER review_census_post_source AFTER INSERT OR DELETE OR UPDATE OF
  route,thread_id,post_id,head_revision_id,security_revision,availability,visibility,deleted_at ON content.post
  FOR EACH ROW EXECUTE FUNCTION content.advance_review_census_source_frontier();
CREATE TRIGGER review_census_board_source AFTER INSERT OR DELETE OR UPDATE OF
  route,board_id,realm_id,purpose,visibility,security_revision ON content.board
  FOR EACH ROW EXECUTE FUNCTION content.advance_review_census_source_frontier();
CREATE TRIGGER review_census_dependency_source AFTER INSERT OR UPDATE OR DELETE ON content.review_discovery_dependency
  FOR EACH ROW EXECUTE FUNCTION content.advance_review_census_source_frontier();

-- migrate:down
DROP TRIGGER review_census_dependency_source ON content.review_discovery_dependency;
DROP TRIGGER review_census_board_source ON content.board;
DROP TRIGGER review_census_post_source ON content.post;
DROP TRIGGER review_census_thread_source ON content.thread;
DROP FUNCTION content.advance_review_census_source_frontier();
DROP TABLE content.review_census_source_frontier;
