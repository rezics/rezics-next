-- migrate:up
ALTER TABLE content.authored_field
  ADD COLUMN anchor uuid,
  ADD CONSTRAINT authored_field_anchor_route_check CHECK (
    anchor IS NULL OR route = get_byte(uuid_send(anchor), 10) * 256 + get_byte(uuid_send(anchor), 11)
  );

CREATE OR REPLACE FUNCTION content.guard_authored_field() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authored document identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.id, NEW.subject, NEW.anchor, NEW.candidate, NEW.revision, NEW.author_account_id, NEW.body_sha256,
         NEW.licence, NEW.language, NEW.recorded_xid, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.id, OLD.subject, OLD.anchor, OLD.candidate, OLD.revision, OLD.author_account_id, OLD.body_sha256,
         OLD.licence, OLD.language, OLD.recorded_xid, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased' OR NEW.body IS NOT NULL THEN
    RAISE EXCEPTION 'Authored documents are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Authored field anchor migration is forward only';
END $$;
