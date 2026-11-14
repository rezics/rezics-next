-- migrate:up
-- Immutable, fixed-depth UUID trie roots make relevance membership independent of cursor depth.
ALTER TABLE search.release_relevance_position
  ADD COLUMN membership_root uuid;

CREATE TABLE search.release_relevance_membership_node (
  execution_id uuid NOT NULL REFERENCES search.release_relevance_execution ON DELETE CASCADE,
  id uuid NOT NULL,
  depth smallint NOT NULL CHECK (depth >= 0 AND depth <= 32),
  children uuid[] NOT NULL CHECK (cardinality(children) = 16),
  work_id text COLLATE "C",
  PRIMARY KEY (execution_id, id),
  CHECK ((depth < 32 AND work_id IS NULL) OR (depth = 32 AND work_id IS NOT NULL)),
  CHECK (work_id IS NULL OR work_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

ALTER TABLE search.release_relevance_position
  ADD CONSTRAINT release_relevance_position_membership_root_fkey
  FOREIGN KEY (execution_id, membership_root)
  REFERENCES search.release_relevance_membership_node (execution_id, id);

CREATE TABLE search.release_relevance_membership_build (
  execution_id uuid NOT NULL,
  target_position_id uuid NOT NULL,
  next_position_id uuid,
  next_work_id text COLLATE "C",
  membership_root uuid,
  PRIMARY KEY (execution_id, target_position_id),
  FOREIGN KEY (execution_id, target_position_id)
    REFERENCES search.release_relevance_position (execution_id, id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id, membership_root)
    REFERENCES search.release_relevance_membership_node (execution_id, id)
);

CREATE INDEX release_relevance_membership_position_root
  ON search.release_relevance_position (execution_id, membership_root)
  WHERE membership_root IS NOT NULL;
CREATE INDEX release_relevance_membership_build_root
  ON search.release_relevance_membership_build (execution_id, membership_root)
  WHERE membership_root IS NOT NULL;

CREATE FUNCTION search.release_relevance_membership_add(
  p_execution_id uuid,
  p_root_id uuid,
  p_work_id text
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_root uuid := p_root_id;
  v_path uuid[] := array_fill(NULL::uuid, ARRAY[33]);
  v_slots integer[] := array_fill(0, ARRAY[32]);
  v_children uuid[];
  v_empty uuid[] := array_fill(NULL::uuid, ARRAY[16]);
  v_key text;
  v_slot integer;
  v_depth integer;
  v_node uuid;
  v_existing text;
BEGIN
  IF p_work_id IS NULL OR p_work_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid release relevance membership work id';
  END IF;
  IF v_root IS NULL THEN
    v_root := gen_random_uuid();
    INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
    VALUES (p_execution_id, v_root, 0, v_empty, NULL);
  END IF;

  v_key := encode(uuid_send(p_work_id::uuid), 'hex');
  v_path[1] := v_root;
  FOR v_depth IN 0..31 LOOP
    v_slot := strpos('0123456789abcdef', substring(v_key FROM v_depth + 1 FOR 1));
    v_slots[v_depth + 1] := v_slot;
    IF v_path[v_depth + 1] IS NOT NULL THEN
      SELECT n.children INTO v_children
      FROM search.release_relevance_membership_node n
      WHERE n.execution_id = p_execution_id
        AND n.id = v_path[v_depth + 1]
        AND n.depth = v_depth;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Missing release relevance membership trie node';
      END IF;
      v_path[v_depth + 2] := v_children[v_slot];
    END IF;
  END LOOP;

  IF v_path[33] IS NOT NULL THEN
    SELECT n.work_id INTO v_existing
    FROM search.release_relevance_membership_node n
    WHERE n.execution_id = p_execution_id AND n.id = v_path[33] AND n.depth = 32;
    IF v_existing = p_work_id THEN
      RETURN v_root;
    END IF;
    RAISE EXCEPTION 'Conflicting release relevance membership trie leaf';
  END IF;

  v_node := gen_random_uuid();
  INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
  VALUES (p_execution_id, v_node, 32, v_empty, p_work_id);
  FOR v_depth IN REVERSE 31..0 LOOP
    IF v_path[v_depth + 1] IS NULL THEN
      v_children := v_empty;
    ELSE
      SELECT n.children INTO v_children
      FROM search.release_relevance_membership_node n
      WHERE n.execution_id = p_execution_id
        AND n.id = v_path[v_depth + 1]
        AND n.depth = v_depth;
    END IF;
    v_children[v_slots[v_depth + 1]] := v_node;
    v_node := gen_random_uuid();
    INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
    VALUES (p_execution_id, v_node, v_depth, v_children, NULL);
  END LOOP;
  RETURN v_node;
END
$$;

CREATE FUNCTION search.release_relevance_membership_add_many(
  p_execution_id uuid,
  p_root_id uuid,
  p_work_ids text[]
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_root uuid := p_root_id;
  v_work_id text;
  v_empty uuid[] := array_fill(NULL::uuid, ARRAY[16]);
BEGIN
  IF v_root IS NULL THEN
    v_root := gen_random_uuid();
    INSERT INTO search.release_relevance_membership_node (execution_id, id, depth, children, work_id)
    VALUES (p_execution_id, v_root, 0, v_empty, NULL);
  END IF;
  FOREACH v_work_id IN ARRAY COALESCE(p_work_ids, ARRAY[]::text[]) LOOP
    v_root := search.release_relevance_membership_add(p_execution_id, v_root, v_work_id);
  END LOOP;
  RETURN v_root;
END
$$;

CREATE FUNCTION search.release_relevance_membership_contains(
  p_execution_id uuid,
  p_root_id uuid,
  p_work_id text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_node uuid := p_root_id;
  v_children uuid[];
  v_key text;
  v_slot integer;
  v_depth integer;
  v_work text;
BEGIN
  IF v_node IS NULL OR p_work_id IS NULL OR p_work_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_key := encode(uuid_send(p_work_id::uuid), 'hex');
  FOR v_depth IN 0..31 LOOP
    SELECT n.children INTO v_children
    FROM search.release_relevance_membership_node n
    WHERE n.execution_id = p_execution_id AND n.id = v_node AND n.depth = v_depth;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    v_slot := strpos('0123456789abcdef', substring(v_key FROM v_depth + 1 FOR 1));
    v_node := v_children[v_slot];
    IF v_node IS NULL THEN
      RETURN false;
    END IF;
  END LOOP;
  SELECT n.work_id INTO v_work
  FROM search.release_relevance_membership_node n
  WHERE n.execution_id = p_execution_id AND n.id = v_node AND n.depth = 32;
  RETURN COALESCE(v_work = p_work_id, false);
END
$$;

CREATE FUNCTION search.release_relevance_membership_build_batch(
  p_execution_id uuid,
  p_target_position_id uuid,
  p_position_limit integer,
  p_work_limit integer,
  p_now timestamptz
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution_id uuid;
  v_position_root uuid;
  v_root uuid;
  v_next_position uuid;
  v_next_work text;
  v_parent uuid;
  v_work_id text;
  v_more boolean;
  v_positions integer := 0;
  v_works integer := 0;
  v_room integer;
BEGIN
  IF p_position_limit < 1 OR p_work_limit < 1 THEN
    RAISE EXCEPTION 'Invalid release relevance membership build limit';
  END IF;
  SELECT e.id INTO v_execution_id
  FROM search.release_relevance_execution e
  WHERE e.id = p_execution_id AND e.expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT p.membership_root INTO v_position_root
  FROM search.release_relevance_position p
  WHERE p.execution_id = p_execution_id AND p.id = p_target_position_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_position_root IS NOT NULL THEN
    RETURN true;
  END IF;

  INSERT INTO search.release_relevance_membership_build
    (execution_id, target_position_id, next_position_id, next_work_id, membership_root)
  VALUES (p_execution_id, p_target_position_id, p_target_position_id, NULL, NULL)
  ON CONFLICT (execution_id, target_position_id) DO NOTHING;
  SELECT b.next_position_id, b.next_work_id, b.membership_root
  INTO v_next_position, v_next_work, v_root
  FROM search.release_relevance_membership_build b
  WHERE b.execution_id = p_execution_id AND b.target_position_id = p_target_position_id
  FOR UPDATE;

  WHILE v_next_position IS NOT NULL AND v_positions < p_position_limit LOOP
    SELECT p.parent_id INTO v_parent
    FROM search.release_relevance_position p
    WHERE p.execution_id = p_execution_id AND p.id = v_next_position;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    v_room := p_work_limit - v_works;
    IF v_room > 0 THEN
      FOR v_work_id IN
        SELECT w.work_id
        FROM search.release_relevance_work w
        WHERE w.execution_id = p_execution_id
          AND w.position_id = v_next_position
          AND (v_next_work IS NULL OR w.work_id > v_next_work)
        ORDER BY w.work_id
        LIMIT v_room
      LOOP
        v_root := search.release_relevance_membership_add(p_execution_id, v_root, v_work_id);
        v_next_work := v_work_id;
        v_works := v_works + 1;
      END LOOP;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM search.release_relevance_work w
      WHERE w.execution_id = p_execution_id
        AND w.position_id = v_next_position
        AND (v_next_work IS NULL OR w.work_id > v_next_work)
    ) INTO v_more;
    IF v_more THEN
      UPDATE search.release_relevance_membership_build b
      SET next_position_id = v_next_position, next_work_id = v_next_work, membership_root = v_root
      WHERE b.execution_id = p_execution_id AND b.target_position_id = p_target_position_id;
      RETURN false;
    END IF;
    v_next_position := v_parent;
    v_next_work := NULL;
    v_positions := v_positions + 1;
  END LOOP;

  IF v_next_position IS NULL THEN
    v_root := search.release_relevance_membership_add_many(p_execution_id, v_root, ARRAY[]::text[]);
    UPDATE search.release_relevance_position p
    SET membership_root = v_root
    WHERE p.execution_id = p_execution_id AND p.id = p_target_position_id AND p.membership_root IS NULL;
    DELETE FROM search.release_relevance_membership_build b
    WHERE b.execution_id = p_execution_id AND b.target_position_id = p_target_position_id;
    RETURN true;
  END IF;

  UPDATE search.release_relevance_membership_build b
  SET next_position_id = v_next_position, next_work_id = v_next_work, membership_root = v_root
  WHERE b.execution_id = p_execution_id AND b.target_position_id = p_target_position_id;
  RETURN false;
END
$$;

CREATE FUNCTION search.release_relevance_advance(
  p_execution_id uuid,
  p_parent_id uuid,
  p_proposed_id uuid,
  p_branch_hash text,
  p_work_digest text,
  p_principal text,
  p_request_hash text,
  p_generation integer,
  p_source_cut_hash text,
  p_expires_at timestamptz,
  p_now timestamptz,
  p_work_ids text[]
) RETURNS TABLE (execution_id uuid, id uuid, work_digest text, membership_ready boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution_id uuid;
  v_parent_root uuid;
  v_root uuid;
  v_existing_id uuid;
  v_existing_digest text;
BEGIN
  UPDATE search.release_relevance_execution e
  SET expires_at = p_expires_at
  WHERE e.id = p_execution_id
    AND e.principal = p_principal
    AND e.request_hash = p_request_hash
    AND e.generation = p_generation
    AND e.source_cut_hash = p_source_cut_hash
    AND e.expires_at > p_now
  RETURNING e.id INTO v_execution_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT p.membership_root INTO v_parent_root
  FROM search.release_relevance_position p
  WHERE p.execution_id = p_execution_id AND p.id = p_parent_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT p.id, p.work_digest INTO v_existing_id, v_existing_digest
  FROM search.release_relevance_position p
  WHERE p.execution_id = p_execution_id
    AND p.parent_id = p_parent_id
    AND p.branch_hash = p_branch_hash;
  IF FOUND THEN
    RETURN QUERY SELECT p_execution_id, v_existing_id, v_existing_digest, true;
    RETURN;
  END IF;
  IF v_parent_root IS NULL THEN
    IF NOT search.release_relevance_membership_build_batch(
      p_execution_id, p_parent_id, 32, 256, p_now
    ) THEN
      RETURN QUERY SELECT p_execution_id, p_parent_id, p_work_digest, false;
      RETURN;
    END IF;
    SELECT p.membership_root INTO v_parent_root
    FROM search.release_relevance_position p
    WHERE p.execution_id = p_execution_id AND p.id = p_parent_id;
  END IF;
  IF v_parent_root IS NULL THEN
    RAISE EXCEPTION 'Release relevance membership parent has no root';
  END IF;
  v_root := search.release_relevance_membership_add_many(p_execution_id, v_parent_root, p_work_ids);
  INSERT INTO search.release_relevance_position
    (execution_id, id, parent_id, branch_hash, work_digest, membership_root)
  VALUES (p_execution_id, p_proposed_id, p_parent_id, p_branch_hash, p_work_digest, v_root);
  INSERT INTO search.release_relevance_work (execution_id, position_id, work_id)
  SELECT p_execution_id, p_proposed_id, emitted.work_id
  FROM unnest(p_work_ids) AS emitted(work_id)
  ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT p_execution_id, p_proposed_id, p_work_digest, true;
END
$$;

-- migrate:down
DROP FUNCTION search.release_relevance_advance(uuid, uuid, uuid, text, text, text, text, integer, text, timestamptz, timestamptz, text[]);
DROP FUNCTION search.release_relevance_membership_build_batch(uuid, uuid, integer, integer, timestamptz);
DROP FUNCTION search.release_relevance_membership_contains(uuid, uuid, text);
DROP FUNCTION search.release_relevance_membership_add_many(uuid, uuid, text[]);
DROP FUNCTION search.release_relevance_membership_add(uuid, uuid, text);
DROP TABLE search.release_relevance_membership_build;
ALTER TABLE search.release_relevance_position
  DROP CONSTRAINT release_relevance_position_membership_root_fkey;
DROP TABLE search.release_relevance_membership_node;
ALTER TABLE search.release_relevance_position DROP COLUMN membership_root;
