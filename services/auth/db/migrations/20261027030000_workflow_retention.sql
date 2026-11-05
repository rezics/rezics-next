-- migrate:up
-- The Auth host installs the trigger after DBOS creates auth_dbos.workflow_status.
-- Each SDK batch deletes its request bindings in the same transaction by primary key.
CREATE FUNCTION auth_delete_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.auth_workflow_request WHERE workflow_id=OLD.workflow_uuid;
  RETURN OLD;
END $$;

-- migrate:down
-- Forward only: the host requires transactional workflow request cleanup.
