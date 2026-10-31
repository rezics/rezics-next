-- migrate:up
-- No payload is rewritten by deployment DDL. The native maintenance pages own
-- historical disposition; these guards close new arbitrary provider SQL writes.
ALTER TABLE auth_client ADD COLUMN display_name_writer integer;
ALTER TABLE "oauthResource" ADD COLUMN name_writer integer;

CREATE TABLE auth_metadata_scrub (
  store text PRIMARY KEY CHECK (store IN ('auth_client','oauthResource','oauthClientResource')),
  writer_version integer NOT NULL CHECK (writer_version = 1),
  after_key text CHECK (octet_length(after_key) <= 1024)
);

CREATE FUNCTION auth_configuration_client_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- These fields have no admitted personal producer or active native consumer.
  NEW.contacts := NULL; NEW.name := NULL; NEW.uri := NULL; NEW.icon := NULL;
  NEW.tos := NULL; NEW.policy := NULL; NEW."softwareId" := NULL;
  NEW."softwareVersion" := NULL; NEW."softwareStatement" := NULL;
  IF TG_OP='INSERT' THEN
    NEW.metadata := NULL;
    NEW."referenceId" := NULL;
    NEW.display_name_writer := NULL;
  ELSE
    NEW.display_name_writer := OLD.display_name_writer;
    IF OLD.display_name_writer=1 THEN
      IF octet_length(NEW.display_name)>400 THEN
        NEW.display_name_writer := NULL;
      ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        NEW.display_name_writer := NULL;
      END IF;
    END IF;
    -- There is no admitted source retiring a legacy provider reference.
    NEW."referenceId" := OLD."referenceId";
    IF OLD.metadata IS NULL THEN
      NEW.metadata := NULL;
    ELSIF NEW.metadata IS NULL THEN
      IF NEW.client_id='rezics-website'
        AND current_setting('auth.configuration_client',true) IS DISTINCT FROM NEW.client_id THEN
        RAISE EXCEPTION 'Auth website metadata requires configuration replacement' USING ERRCODE='55000';
      END IF;
    ELSE
      -- Never compare, traverse or detoast the old JSON to classify a write.
      -- A non-null attempted replacement cannot install a new private value.
      NEW.metadata := OLD.metadata;
    END IF;
  END IF;
  -- The command supplies the actual configured key and label, never a caller's
  -- assertion that arbitrary JSON is safe. Transaction-local settings expire.
  IF current_setting('auth.configuration_client',true)=NEW.client_id
    AND current_setting('auth.configuration_label',true)=NEW.display_name THEN
    NEW.display_name_writer := 1;
  END IF;
  IF NEW.display_name_writer IS DISTINCT FROM 1 THEN NEW.display_name := NULL; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION auth_configuration_resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.metadata := NULL;
  IF TG_OP='INSERT' THEN
    NEW."customClaims" := NULL;
    NEW.name_writer := NULL;
  ELSE
    NEW.name_writer := OLD.name_writer;
    IF OLD.name_writer=1 THEN
      IF NEW.name IS DISTINCT FROM 'REZICS API' OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.identifier IS DISTINCT FROM OLD.identifier THEN NEW.name_writer := NULL; END IF;
    END IF;
    IF OLD."customClaims" IS NULL THEN
      NEW."customClaims" := NULL;
    ELSIF NEW."customClaims" IS NULL THEN
      IF current_setting('auth.configuration_resource',true) IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Auth resource claims require configuration replacement' USING ERRCODE='55000';
      END IF;
    ELSE
      NEW."customClaims" := OLD."customClaims";
    END IF;
  END IF;
  IF current_setting('auth.configuration_resource',true)=NEW.id AND NEW.name='REZICS API' THEN
    NEW.name_writer := 1;
  END IF;
  IF NEW.name_writer IS DISTINCT FROM 1 THEN NEW.name := ''; NEW.name_writer := 0; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION auth_configuration_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.metadata := NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER configuration_fields BEFORE INSERT OR UPDATE ON auth_client
  FOR EACH ROW EXECUTE FUNCTION auth_configuration_client_guard();
CREATE TRIGGER configuration_fields BEFORE INSERT OR UPDATE ON "oauthResource"
  FOR EACH ROW EXECUTE FUNCTION auth_configuration_resource_guard();
CREATE TRIGGER configuration_fields BEFORE INSERT OR UPDATE ON "oauthClientResource"
  FOR EACH ROW EXECUTE FUNCTION auth_configuration_link_guard();

-- migrate:down
DROP TRIGGER configuration_fields ON "oauthClientResource";
DROP TRIGGER configuration_fields ON "oauthResource";
DROP TRIGGER configuration_fields ON auth_client;
DROP FUNCTION auth_configuration_link_guard();
DROP FUNCTION auth_configuration_resource_guard();
DROP FUNCTION auth_configuration_client_guard();
DROP TABLE auth_metadata_scrub;
ALTER TABLE "oauthResource" DROP COLUMN name_writer;
ALTER TABLE auth_client DROP COLUMN display_name_writer;
