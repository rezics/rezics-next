-- Supplemental custody keyed by the original immutable manifest. These rows do
-- not replace revisions, manifest bytes or an ordinary writer's Structure head.
CREATE TABLE structure.group_root (
  manifest_digest text PRIMARY KEY CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  structure text NOT NULL CHECK (structure ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  records jsonb NOT NULL,
  ordering jsonb NOT NULL,
  total integer NOT NULL CHECK (total BETWEEN 0 AND 1048576),
  cursor text CHECK (cursor IS NULL OR octet_length(cursor) BETWEEN 1 AND 512),
  scanned integer NOT NULL DEFAULT 0 CHECK (scanned BETWEEN 0 AND total),
  groups jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  complete boolean NOT NULL DEFAULT false,
  CHECK (NOT complete OR scanned = total),
  CHECK (total <= (ordering->>'count')::integer),
  CHECK ((cursor IS NULL) = (scanned = 0)),
  CHECK (cursor IS NULL OR starts_with(cursor, structure || chr(1))),
  CHECK ((groups->>'count')::integer BETWEEN 0 AND scanned)
);

CREATE FUNCTION structure.group_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retained group preparation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  FOREACH root IN ARRAY ARRAY[NEW.records, NEW.ordering, NEW.groups] LOOP
    IF jsonb_typeof(root) <> 'object' OR root - 'page' - 'level' - 'count' <> '{}'::jsonb
      OR NOT (root ?& ARRAY['page','level','count'])
      OR jsonb_typeof(root->'page') <> 'string' OR root->>'page' !~ '^sha256:[0-9a-f]{64}$'
      OR jsonb_typeof(root->'level') <> 'number' OR root->>'level' !~ '^[0-5]$'
      OR jsonb_typeof(root->'count') <> 'number' OR root->>'count' !~ '^(0|[1-9][0-9]*)$'
      OR (root->>'count')::bigint > 1048576 THEN
      RAISE EXCEPTION 'invalid group preparation tree root' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_OP = 'INSERT' THEN
    IF NEW.scanned <> 0 OR NEW.cursor IS NOT NULL OR NEW.version <> 0 OR NEW.complete
      OR NEW.groups->>'count' <> '0' OR NEW.groups->>'level' <> '0' THEN
      RAISE EXCEPTION 'group preparation must start empty and pending' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.complete OR (NEW.manifest_digest, NEW.structure, NEW.records, NEW.ordering, NEW.total)
      IS DISTINCT FROM (OLD.manifest_digest, OLD.structure, OLD.records, OLD.ordering, OLD.total)
      OR NEW.version <> OLD.version + 1 OR NEW.scanned < OLD.scanned OR NEW.scanned > OLD.scanned + 256
      OR (NEW.groups->>'count')::integer < (OLD.groups->>'count')::integer
      OR (NEW.groups->>'count')::integer - (OLD.groups->>'count')::integer > NEW.scanned - OLD.scanned
      OR (NEW.scanned > OLD.scanned AND (NEW.cursor IS NULL
        OR OLD.cursor IS NOT NULL AND NEW.cursor COLLATE "C" <= OLD.cursor COLLATE "C"))
      OR (NEW.scanned = OLD.scanned AND (NOT NEW.complete OR NEW.cursor IS DISTINCT FROM OLD.cursor
        OR NEW.groups IS DISTINCT FROM OLD.groups)) THEN
      RAISE EXCEPTION 'group preparation checkpoint is stale or changes its source' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_root_guard BEFORE INSERT OR UPDATE OR DELETE ON structure.group_root
  FOR EACH ROW EXECUTE FUNCTION structure.group_root_guard();
