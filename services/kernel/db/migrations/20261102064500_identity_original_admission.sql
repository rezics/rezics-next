-- migrate:up
-- Fixed selected-History partitions. An absent child declaration is NULL, never zero.
CREATE FUNCTION core.identity_original_sum(a bigint[], b bigint[], c bigint[], d bigint[])
RETURNS bigint[] LANGUAGE sql IMMUTABLE AS $$
 SELECT array_agg(a[i]+coalesce(b[i],0)+coalesce(c[i],0)+d[i] ORDER BY i)
 FROM generate_series(1,8) i
$$;

CREATE TABLE core.identity_history_allocation (
 original_id uuid PRIMARY KEY REFERENCES core.identity_history_original(original_id),
 local_work bigint[] NOT NULL CHECK(core.identity_original_vector_valid(local_work)),
 source_work bigint[] CHECK(source_work IS NULL OR core.identity_original_vector_valid(source_work)),
 library_work bigint[] CHECK(library_work IS NULL OR core.identity_original_vector_valid(library_work)),
 transfer_work bigint[] NOT NULL CHECK(core.identity_original_vector_valid(transfer_work)),
 parent_work bigint[] NOT NULL CHECK(core.identity_original_vector_valid(parent_work)),
 local_entered boolean NOT NULL DEFAULT false,
 child_entered boolean NOT NULL DEFAULT false,
 child_ended boolean NOT NULL DEFAULT false,
 next_binding jsonb CHECK(next_binding IS NULL OR
   (jsonb_typeof(next_binding)='object' AND octet_length(next_binding::text)<=2048)),
 CHECK(parent_work=core.identity_original_sum(local_work,source_work,library_work,transfer_work)),
 CHECK(NOT child_entered OR (local_entered AND source_work IS NOT NULL AND library_work IS NOT NULL)),
 CHECK(NOT child_ended OR child_entered),
 CHECK(next_binding IS NULL OR local_entered)
);

CREATE FUNCTION core.guard_identity_history_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original core.identity_history_original;
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Original partitions cannot be discarded' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO original FROM core.identity_history_original WHERE original_id=NEW.original_id FOR SHARE;
   IF NOT FOUND OR original.allowance IS DISTINCT FROM NEW.parent_work OR
      original.spent IS DISTINCT FROM NEW.parent_work OR NOT original.dispatched THEN
     RAISE EXCEPTION 'Original partitions require committed prepaid admission' USING ERRCODE='23514';
   END IF;
 ELSE
   IF (to_jsonb(NEW)-ARRAY['local_entered','child_entered','child_ended','next_binding']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['local_entered','child_entered','child_ended','next_binding']) OR
      (OLD.local_entered AND NOT NEW.local_entered) OR
      (OLD.child_entered AND NOT NEW.child_entered) OR
      (OLD.child_ended AND NOT NEW.child_ended) OR
      (OLD.next_binding IS NOT NULL AND NEW.next_binding IS DISTINCT FROM OLD.next_binding) THEN
     RAISE EXCEPTION 'Original partitions cannot refill or reopen' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_history_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON core.identity_history_allocation
 FOR EACH ROW EXECUTE FUNCTION core.guard_identity_history_allocation();

-- migrate:down
-- Forward only: failures retain original partitions and the unresolved custody obligation.
