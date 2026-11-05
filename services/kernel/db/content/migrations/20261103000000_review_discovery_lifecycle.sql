-- migrate:up
-- This is an identity dependency directory, including concealed and withdrawn reviews.
-- It never answers eligibility, population or bootstrap page requests.
CREATE TABLE content.review_discovery_dependency (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  gate_kind text NOT NULL CHECK (gate_kind IN ('thread','post','board','subject','account','realm','space','context')),
  gate_key uuid NOT NULL,
  PRIMARY KEY (route, thread_id, gate_kind, gate_key),
  CHECK (route = get_byte(uuid_send(thread_id),10)*256 + get_byte(uuid_send(thread_id),11))
);
CREATE INDEX review_discovery_dependency_gate ON content.review_discovery_dependency
  (gate_kind, gate_key, route, thread_id);
CREATE INDEX review_discovery_dependency_resource ON content.review_discovery_dependency
  (gate_key, route, thread_id);
CREATE INDEX review_discovery_dependency_all ON content.review_discovery_dependency
  (route, thread_id) WHERE gate_kind='thread';

CREATE FUNCTION content.record_review_discovery_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'review' THEN
    INSERT INTO content.review_discovery_dependency(route,thread_id,gate_kind,gate_key)
    SELECT NEW.route, NEW.thread_id, keys.kind, keys.id
    FROM content.board b
    LEFT JOIN community.realm r ON r.route = get_byte(uuid_send(b.realm_id),10)*256 + get_byte(uuid_send(b.realm_id),11)
      AND r.realm_id=b.realm_id
    CROSS JOIN LATERAL (VALUES ('thread',NEW.thread_id),('post',NEW.first_post_id),
      ('board',NEW.board_id),('subject',NEW.review_subject_id),('account',NEW.author_account_id),
      ('realm',b.realm_id),('space',r.space_id),('context',r.context_id),
      ('context','00000000-0000-8000-8000-000000000000'::uuid)) AS keys(kind,id)
    WHERE b.route = get_byte(uuid_send(NEW.board_id),10)*256 + get_byte(uuid_send(NEW.board_id),11)
      AND b.board_id=NEW.board_id AND keys.id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_discovery_dependencies AFTER INSERT OR UPDATE OF
  board_id, review_subject_id, first_post_id, author_account_id ON content.thread
  FOR EACH ROW EXECUTE FUNCTION content.record_review_discovery_dependencies();

-- One migration backfill of identities; current disclosure remains in review-discovery.ts.
INSERT INTO content.review_discovery_dependency(route,thread_id,gate_kind,gate_key)
SELECT t.route,t.thread_id,keys.kind,keys.id FROM content.thread t
JOIN content.board b ON b.route=get_byte(uuid_send(t.board_id),10)*256 + get_byte(uuid_send(t.board_id),11)
  AND b.board_id=t.board_id
LEFT JOIN community.realm r ON r.route=get_byte(uuid_send(b.realm_id),10)*256 + get_byte(uuid_send(b.realm_id),11)
  AND r.realm_id=b.realm_id
CROSS JOIN LATERAL (VALUES ('thread',t.thread_id),('post',t.first_post_id),('board',t.board_id),
  ('subject',t.review_subject_id),('account',t.author_account_id),('realm',b.realm_id),('space',r.space_id),('context',r.context_id),
      ('context','00000000-0000-8000-8000-000000000000'::uuid)) AS keys(kind,id)
WHERE t.kind='review' AND keys.id IS NOT NULL ON CONFLICT DO NOTHING;

CREATE TABLE content.review_discovery_work (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535 AND route % 16 = 0),
  id uuid NOT NULL,
  origin jsonb NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 8),
  scope_no integer NOT NULL DEFAULT 0 CHECK (scope_no BETWEEN 0 AND 8),
  after_route integer NOT NULL DEFAULT -1 CHECK (after_route BETWEEN -1 AND 65535),
  after_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  source_subject uuid,
  after_subject uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,id)
);
CREATE TABLE content.review_discovery_frontier (
  route integer PRIMARY KEY CHECK (route BETWEEN 0 AND 65535 AND route % 16 = 0),
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0)
);
CREATE TABLE content.review_discovery_change (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  partition_no integer NOT NULL CHECK (partition_no = route / 16),
  position bigint NOT NULL CHECK (position > 0),
  origin jsonb NOT NULL,
  origin_id uuid NOT NULL,
  PRIMARY KEY (route,thread_id,origin_id),
  UNIQUE (partition_no,position),
  CHECK (route = get_byte(uuid_send(thread_id),10)*256 + get_byte(uuid_send(thread_id),11)),
  CHECK (origin->>'id' = origin_id::text)
);

-- migrate:down
DROP TABLE content.review_discovery_change;
DROP TABLE content.review_discovery_frontier;
DROP TABLE content.review_discovery_work;
DROP TRIGGER review_discovery_dependencies ON content.thread;
DROP FUNCTION content.record_review_discovery_dependencies();
DROP TABLE content.review_discovery_dependency;
