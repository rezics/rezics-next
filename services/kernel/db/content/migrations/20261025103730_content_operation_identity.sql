-- migrate:up
-- DOMAIN identity only. DBOS owns progress, status, results, retries and scheduling.
-- The command writes verified AccountActor fields individually, never caller actor
-- JSON or credentials, and supplies requested_at from its trusted attempt T.
-- initiator_account_id is the initiating account; author_account_id and thread_id
-- define the erasure scope. No remote Account/Auth foreign keys or history counts.
CREATE FUNCTION content.operation_scopes_valid(scopes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (cardinality(scopes) = 0 OR array_ndims(scopes) = 1)
    AND cardinality(scopes) <= 6450
    AND octet_length(array_to_string(scopes, ' ')) <= 12900
    AND COALESCE(bool_and(scope IS NOT NULL AND scope ~ '^[!-~]{1,128}$'
      AND position('"' in scope) = 0 AND position(chr(92) in scope) = 0), true)
  FROM unnest(scopes) AS scope
$$;

CREATE TABLE content.operation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  operation_id uuid NOT NULL,
  initiator_account_id uuid NOT NULL,
  author_account_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind = 'account'),
  actor_account_id uuid NOT NULL CHECK (actor_account_id = initiator_account_id),
  actor_client_id text NOT NULL CHECK (char_length(actor_client_id) BETWEEN 1 AND 1024),
  actor_scopes text[] NOT NULL CHECK (content.operation_scopes_valid(actor_scopes)),
  actor_requested_by text CHECK (actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_authn_epoch bigint NOT NULL CHECK (actor_authn_epoch BETWEEN 1 AND 9007199254740991),
  empty_scope boolean NOT NULL,
  upper_created_at timestamptz,
  upper_post_id uuid,
  requested_at timestamptz NOT NULL CHECK (isfinite(requested_at)),
  recorded_transaction_id uuid NOT NULL,
  native_workflow_id text,
  source_epoch integer,
  source_partition integer,
  source_position bigint,
  source_event_index integer,
  PRIMARY KEY (route, operation_id),
  CHECK (route = get_byte(uuid_send(operation_id), 10) * 256 + get_byte(uuid_send(operation_id), 11)),
  CHECK (route >> 4 = (get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)) >> 4),
  CHECK ((empty_scope AND upper_created_at IS NULL AND upper_post_id IS NULL)
    OR (NOT empty_scope AND upper_created_at IS NOT NULL AND upper_post_id IS NOT NULL
      AND isfinite(upper_created_at) AND upper_created_at <= requested_at
      AND substring(uuid_send(upper_post_id) from 11 for 2) = substring(uuid_send(thread_id) from 11 for 2))),
  CHECK ((num_nonnulls(native_workflow_id, source_epoch, source_partition, source_position, source_event_index) = 0)
    OR (num_nonnulls(native_workflow_id, source_epoch, source_partition, source_position, source_event_index) = 5
      AND source_epoch > 0 AND source_partition = route >> 4 AND source_position > 0 AND source_event_index >= 0
      AND native_workflow_id = 'fx:' || source_epoch || ':' || source_partition || ':' || source_position
        || ':' || source_event_index || ':content_author_erase_' || operation_id))
);

-- The source point projection alone binds these five nullable mapping columns,
-- before enqueue, through the command module's private typed binder. It computes
-- contentWorkWorkflowId(source,index,'authorErase',operationId), then UPDATEs by
-- (route,operation_id). No request body may set them. An absent mapping or absent
-- native status means pending in the API Operation view, never unknown/success.
-- Identity is immutable; replaying the same binding is safe, replacing it fails.
CREATE FUNCTION content.guard_operation_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Operation identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW.native_workflow_id, NEW.source_epoch, NEW.source_partition,
        NEW.source_position, NEW.source_event_index) <> 0 THEN
      RAISE EXCEPTION 'Operation source is bound only after recording' USING ERRCODE = '23514';
    END IF;
  ELSIF (to_jsonb(NEW) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index'])
    OR (OLD.native_workflow_id IS NOT NULL AND ROW(NEW.native_workflow_id, NEW.source_epoch,
        NEW.source_partition, NEW.source_position, NEW.source_event_index) IS DISTINCT FROM
      ROW(OLD.native_workflow_id, OLD.source_epoch, OLD.source_partition, OLD.source_position, OLD.source_event_index)) THEN
    RAISE EXCEPTION 'Operation identity and source binding are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_identity BEFORE INSERT OR UPDATE OR DELETE ON content.operation
FOR EACH ROW EXECUTE FUNCTION content.guard_operation_identity();

-- Endpoint reads reuse post_thread_author_page_idx with exact route/thread/author,
-- using the route encoded in thread_id (operation.route may be a sibling route),
-- ORDER BY created_at,post_id in either direction and LIMIT 1. Freeze the returned
-- upper tuple, or explicitly mark empty_scope; never invent a post or count history.
-- Runtime: one PK insert/read/bind O(log(Ut)+A); no second registry or launch.
-- migrate:down
-- Forward only: preserve the identity and source mapping across rollback.
