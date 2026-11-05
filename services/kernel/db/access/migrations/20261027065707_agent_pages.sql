-- migrate:up
ALTER TABLE access.account ADD COLUMN public_changed_at timestamptz;
UPDATE access.account SET public_changed_at = created_at;
ALTER TABLE access.account
  ALTER COLUMN public_changed_at SET NOT NULL,
  ALTER COLUMN public_changed_at SET DEFAULT statement_timestamp();

-- Keep this dependency list aligned with account-public-read.sql, including its visibility guards.
CREATE FUNCTION access.record_public_account_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.public_changed_at := NEW.created_at;
  ELSIF ROW(NEW.account_id, NEW.kind, NEW.state, NEW.authn_fenced, NEW.avatar, NEW.public_views,
            NEW.speakers_listed, NEW.handle, NEW.display_name, NEW.avatar_url, NEW.biography,
            NEW.links, NEW.operator_account_id, NEW.agent_verified, NEW.agent_subject_id)
        IS DISTINCT FROM
        ROW(OLD.account_id, OLD.kind, OLD.state, OLD.authn_fenced, OLD.avatar, OLD.public_views,
            OLD.speakers_listed, OLD.handle, OLD.display_name, OLD.avatar_url, OLD.biography,
            OLD.links, OLD.operator_account_id, OLD.agent_verified, OLD.agent_subject_id) THEN
    NEW.public_changed_at := statement_timestamp();
  ELSE
    NEW.public_changed_at := OLD.public_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_public_change BEFORE INSERT OR UPDATE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.record_public_account_change();

CREATE INDEX account_agent_pages ON access.account (route, account_id)
WHERE state = 'active' AND NOT authn_fenced AND handle IS NOT NULL;

-- migrate:down
DROP INDEX access.account_agent_pages;
DROP TRIGGER account_public_change ON access.account;
DROP FUNCTION access.record_public_account_change();
ALTER TABLE access.account DROP COLUMN public_changed_at;
