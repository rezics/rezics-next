-- migrate:up
-- A dedicated authority epoch is independent of core.partition.position. Every
-- invalidator advances only the logical home that owns the changed authority.
CREATE TABLE core.publication_authority_epoch (
  home_no integer PRIMARY KEY REFERENCES core.partition(partition_no) CHECK (home_no BETWEEN 0 AND 4095),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);

INSERT INTO core.publication_authority_epoch(home_no)
SELECT partition_no FROM core.partition ORDER BY partition_no;

CREATE FUNCTION core.bump_publication_authority(home integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE core.publication_authority_epoch
     SET epoch=epoch+1
   WHERE home_no=home;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication authority home is not installed' USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE FUNCTION core.bump_publication_authority_route_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  route_value integer;
BEGIN
  IF TG_OP='DELETE' THEN
    route_value := (to_jsonb(OLD)->>'route')::integer;
  ELSE
    route_value := (to_jsonb(NEW)->>'route')::integer;
  END IF;
  PERFORM core.bump_publication_authority(route_value / 16);
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION core.reset_publication_authority_on_move() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.node,NEW.write_state,NEW.moved_to,NEW.epoch)
       IS DISTINCT FROM ROW(OLD.node,OLD.write_state,OLD.moved_to,OLD.epoch) THEN
    UPDATE core.publication_authority_epoch
       SET generation=gen_random_uuid(),epoch=0
     WHERE home_no=NEW.partition_no;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER partition_publication_authority_move
AFTER UPDATE OF node,write_state,moved_to,epoch ON core.partition
FOR EACH ROW EXECUTE FUNCTION core.reset_publication_authority_on_move();

CREATE FUNCTION core.lock_publication_authority(homes integer[])
RETURNS TABLE(home_no integer,generation uuid,epoch bigint)
LANGUAGE plpgsql AS $$
DECLARE
  selected_home integer;
BEGIN
  FOR selected_home IN
    SELECT DISTINCT value FROM unnest(COALESCE(homes,'{}'::integer[])) AS requested(value)
    ORDER BY value
  LOOP
    RETURN QUERY
      SELECT authority.home_no,authority.generation,authority.epoch
      FROM core.publication_authority_epoch authority
      WHERE authority.home_no=selected_home
      FOR UPDATE;
  END LOOP;
END;
$$;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Publication authority epochs are forward-only once installed' USING ERRCODE='23514';
END;
$$;
