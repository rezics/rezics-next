-- migrate:up
-- Native identities, not public facts. Shared scopes seek this inverse index;
-- they never visit a partition inventory or filter through public eligibility.
CREATE SEQUENCE community.space_discovery_dependency_key;
CREATE TABLE community.space_discovery_dependency (
  dependency jsonb NOT NULL,
  route integer NOT NULL,
  space_id uuid NOT NULL,
  ordinal bigint NOT NULL DEFAULT nextval('community.space_discovery_dependency_key'),
  PRIMARY KEY (dependency, route, space_id),
  FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id) ON DELETE CASCADE,
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (ordinal > 0)
);
CREATE UNIQUE INDEX space_discovery_dependency_page
  ON community.space_discovery_dependency(dependency, ordinal) INCLUDE (route, space_id);
CREATE INDEX space_discovery_dependency_owner
  ON community.space_discovery_dependency(route, space_id);

CREATE FUNCTION community.refresh_space_discovery_dependencies(r integer, id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE dependencies jsonb[] := ARRAY[
  '{"kind":"exposure","group":"search"}'::jsonb,
  '{"kind":"exposure","group":"search_advanced"}'::jsonb
]; carried record;
BEGIN
  -- Serialize initialization and native changes on the retained owner, including
  -- removed owners. An old seed cannot replace a concurrently committed head.
  PERFORM 1 FROM community.space WHERE route=r AND space_id=id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT h.context_id, v.presentation INTO carried
    FROM community.realm h JOIN community.realm_revision v
      ON v.route=h.route AND v.realm_id=h.realm_id AND v.revision_id=h.head_revision_id
    WHERE h.route=r AND h.space_id=id;
  IF FOUND THEN
    dependencies := array_append(dependencies,
      jsonb_build_object('kind','context','id',carried.context_id));
    IF carried.presentation->>'avatarMediaId' IS NOT NULL THEN
      dependencies := array_append(dependencies,
        jsonb_build_object('kind','media','id',carried.presentation->>'avatarMediaId'));
    END IF;
  END IF;
  DELETE FROM community.space_discovery_dependency
    WHERE route=r AND space_id=id AND NOT (dependency=ANY(dependencies));
  INSERT INTO community.space_discovery_dependency(dependency,route,space_id)
    SELECT d,r,id FROM unnest(dependencies) d ON CONFLICT DO NOTHING;
END;
$$;
CREATE FUNCTION community.change_space_discovery_dependencies() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community.refresh_space_discovery_dependencies(
    COALESCE(NEW.route,OLD.route),COALESCE(NEW.space_id,OLD.space_id));
  RETURN NULL;
END;
$$;
-- Deferred so the exact native head and its optional carried Realm exist. No
-- historical revision walk, media hydration or foreign authority is involved.
CREATE CONSTRAINT TRIGGER space_discovery_dependencies
  AFTER INSERT OR UPDATE ON community.space DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION community.change_space_discovery_dependencies();
CREATE CONSTRAINT TRIGGER realm_space_discovery_dependencies
  AFTER INSERT OR UPDATE OR DELETE ON community.realm DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION community.change_space_discovery_dependencies();

-- Installation captures one indexed endpoint per partition under the native
-- writer lock. Writers after this cut maintain their dependencies themselves.
LOCK TABLE community.space, community.realm IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE community.space_discovery_dependency_install (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  cursor_route integer NOT NULL,
  cursor_id uuid NOT NULL,
  cut_route integer NOT NULL,
  cut_id uuid NOT NULL,
  complete boolean NOT NULL DEFAULT false
);
CREATE INDEX space_discovery_dependency_install_pending
  ON community.space_discovery_dependency_install(partition_no) WHERE NOT complete;
INSERT INTO community.space_discovery_dependency_install
  (partition_no,cursor_route,cursor_id,cut_route,cut_id,complete)
SELECT p,p*16,'00000000-0000-0000-0000-000000000000'::uuid,
  COALESCE(s.route,p*16),COALESCE(s.space_id,'00000000-0000-0000-0000-000000000000'::uuid),
  s.space_id IS NULL
FROM generate_series(0,4095) p LEFT JOIN LATERAL (
  SELECT route,space_id FROM community.space WHERE route BETWEEN p*16 AND p*16+15
  ORDER BY route DESC,space_id DESC LIMIT 1
) s ON true;

CREATE TABLE community.space_discovery_frontier (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  obligation text NOT NULL,
  invalidation jsonb NOT NULL,
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing','unavailable','draining','settled')),
  cut bigint,
  cursor bigint NOT NULL DEFAULT 0,
  examined bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (partition_no,obligation),
  CHECK (cursor >= 0 AND examined >= 0 AND (cut IS NULL OR cursor <= cut)),
  CHECK (state NOT IN ('draining','settled') OR cut IS NOT NULL)
);
CREATE INDEX space_discovery_frontier_pending ON community.space_discovery_frontier(partition_no,obligation)
  WHERE state IN ('preparing','draining');
-- This retained deduplication belongs to the exact Space home. Receipt expiry
-- cannot emit another wake for an already examined obligation/Space pair.
CREATE TABLE community.space_discovery_frontier_wake (
  route integer NOT NULL,
  space_id uuid NOT NULL,
  obligation text NOT NULL,
  PRIMARY KEY (route,space_id,obligation),
  FOREIGN KEY (route,space_id) REFERENCES community.space(route,space_id) ON DELETE CASCADE
);

-- migrate:down
-- Forward only: dependency frontiers and delivered-wake identities are retained.
