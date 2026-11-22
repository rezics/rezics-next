-- migrate:up
-- The original personal node stays identifiable after verification moves its backlink.
-- A catalogue survivor has its own independent id.
CREATE FUNCTION semantic.personal_agent_id(account uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH seed AS (
    SELECT substring(sha256(uuid_send('fb3a9d35-804c-4d22-b317-260c05382a41'::uuid)
                            || account::text::bytea) FROM 1 FOR 16) AS bytes
  )
  SELECT encode(set_byte(set_byte(set_byte(set_byte(bytes,
    6, (get_byte(bytes,6) & 15) | 128),
    8, (get_byte(bytes,8) & 63) | 128),
    10, get_byte(uuid_send(account),10)),
    11, get_byte(uuid_send(account),11)), 'hex')::uuid FROM seed
$$;

-- Only the native erasure row grants this exclusion. The expression index also covers
-- accounts erased before installation, and verification or reversal cannot move the key.
CREATE UNIQUE INDEX erasure_personal_agent ON access.erasure(route,semantic.personal_agent_id(account_id));

CREATE FUNCTION semantic.search_agent_erased(r integer,id uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN get_byte(uuid_send(id),6)>>4=8 THEN coalesce((
    SELECT true FROM access.erasure e WHERE e.route=r AND semantic.personal_agent_id(e.account_id)=id LIMIT 1
  ),false) ELSE false END
$$;

CREATE VIEW semantic.search_subject AS
SELECT s.route,s.subject_id,s.type,s.current_release,s.security_revision,
       CASE WHEN semantic.search_agent_erased(s.route,s.subject_id) THEN 'hidden' ELSE s.visibility END AS visibility
FROM semantic.subject s;

-- Track the intersection of the native visible census and the excluded originals.
-- A count read stays a single partition point even when many accounts have been erased.
ALTER TABLE semantic.partition_subjects ADD COLUMN erased_visible bigint NOT NULL DEFAULT 0 CHECK (erased_visible>=0);
CREATE TABLE semantic.search_erased_visible (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  PRIMARY KEY (route,subject_id)
);

CREATE FUNCTION semantic.refresh_erased_search_count(r integer,id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT semantic.search_agent_erased(r,id) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM semantic.subject s WHERE (s.route,s.subject_id)=(r,id) AND s.visibility='visible')
     AND (SELECT d.target FROM semantic.redirect d WHERE (d.route,d.subject_id)=(r,id)
          ORDER BY d.sequence DESC LIMIT 1) IS NULL THEN
    INSERT INTO semantic.search_erased_visible VALUES(r,id) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      UPDATE semantic.partition_subjects SET erased_visible=erased_visible+1 WHERE partition_no=r/16;
    END IF;
  ELSE
    DELETE FROM semantic.search_erased_visible WHERE (route,subject_id)=(r,id);
    IF FOUND THEN
      UPDATE semantic.partition_subjects SET erased_visible=erased_visible-1 WHERE partition_no=r/16;
    END IF;
  END IF;
END
$$;

CREATE FUNCTION semantic.capture_search_agent_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM semantic.refresh_erased_search_count(NEW.route,semantic.personal_agent_id(NEW.account_id));
  PERFORM nextval('semantic.search_canonical_generation');
  RETURN NULL;
END
$$;
CREATE TRIGGER search_agent_erasure AFTER INSERT ON access.erasure
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_search_agent_erasure();

CREATE FUNCTION semantic.capture_erased_search_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' AND (TG_OP='DELETE' OR (OLD.route,OLD.subject_id)<>(NEW.route,NEW.subject_id)) THEN
    PERFORM semantic.refresh_erased_search_count(OLD.route,OLD.subject_id);
  END IF;
  IF TG_OP<>'DELETE' THEN PERFORM semantic.refresh_erased_search_count(NEW.route,NEW.subject_id); END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER subject_erased_search_count AFTER INSERT OR UPDATE OF visibility,route,subject_id OR DELETE
  ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.capture_erased_search_count();
CREATE TRIGGER redirect_erased_search_count AFTER INSERT OR UPDATE OR DELETE
  ON semantic.redirect FOR EACH ROW EXECUTE FUNCTION semantic.capture_erased_search_count();

SELECT semantic.refresh_erased_search_count(route,semantic.personal_agent_id(account_id)) FROM access.erasure;

-- migrate:down
DROP TRIGGER redirect_erased_search_count ON semantic.redirect;
DROP TRIGGER subject_erased_search_count ON semantic.subject;
DROP FUNCTION semantic.capture_erased_search_count();
DROP TRIGGER search_agent_erasure ON access.erasure;
DROP FUNCTION semantic.capture_search_agent_erasure();
DROP FUNCTION semantic.refresh_erased_search_count(integer,uuid);
DROP TABLE semantic.search_erased_visible;
ALTER TABLE semantic.partition_subjects DROP COLUMN erased_visible;
DROP VIEW semantic.search_subject;
DROP FUNCTION semantic.search_agent_erased(integer,uuid);
DROP INDEX access.erasure_personal_agent;
DROP FUNCTION semantic.personal_agent_id(uuid);
