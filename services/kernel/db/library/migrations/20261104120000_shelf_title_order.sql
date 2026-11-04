-- migrate:up
CREATE TABLE library.shelf_title_owner (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  population bigint NOT NULL DEFAULT 0 CHECK (population >= 0),
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))
);
CREATE TABLE library.shelf_title_head (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  generation uuid NOT NULL,
  population bigint NOT NULL,
  policy text NOT NULL CHECK (policy ~ '^[0-9a-f]{64}$'),
  source_basis text NOT NULL CHECK (octet_length(source_basis) BETWEEN 1 AND 1024),
  phase text NOT NULL CHECK (phase IN ('cleanup','build','ready')),
  after_subject_id uuid,
  PRIMARY KEY (route, account_id)
);
-- Only one selected-language generation per owner. Replacing it requires bounded cleanup first.
CREATE TABLE library.shelf_title_key (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  generation uuid NOT NULL,
  incarnation_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  state text NOT NULL,
  type_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_basis text NOT NULL CHECK (octet_length(source_basis) BETWEEN 1 AND 1024),
  missing boolean NOT NULL,
  key bytea NOT NULL CHECK (octet_length(key) <= 1024),
  PRIMARY KEY (route, account_id, subject_id),
  CHECK (NOT missing OR octet_length(key)=0)
);
CREATE INDEX shelf_title_all_asc ON library.shelf_title_key
  (route,account_id,generation,missing,key ASC,subject_id ASC);
CREATE INDEX shelf_title_all_desc ON library.shelf_title_key
  (route,account_id,generation,missing,key DESC,subject_id DESC);
CREATE INDEX shelf_title_state_asc ON library.shelf_title_key
  (route,account_id,generation,state,missing,key ASC,subject_id ASC);
CREATE INDEX shelf_title_state_desc ON library.shelf_title_key
  (route,account_id,generation,state,missing,key DESC,subject_id DESC);
CREATE INDEX shelf_title_type_asc ON library.shelf_title_key
  (route,account_id,generation,type_id,missing,key ASC,subject_id ASC);
CREATE INDEX shelf_title_type_desc ON library.shelf_title_key
  (route,account_id,generation,type_id,missing,key DESC,subject_id DESC);
CREATE INDEX shelf_title_state_type_asc ON library.shelf_title_key
  (route,account_id,generation,state,type_id,missing,key ASC,subject_id ASC);
CREATE INDEX shelf_title_state_type_desc ON library.shelf_title_key
  (route,account_id,generation,state,type_id,missing,key DESC,subject_id DESC);

-- Entry command ownership is unchanged. The trigger invalidates any prepared population atomically,
-- including restore, incarnation changes and maintenance's state/type/source rewrites.
CREATE FUNCTION library.advance_shelf_title_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO library.shelf_title_owner AS h (route,account_id,population)
      VALUES (OLD.route,OLD.account_id,1)
      ON CONFLICT (route,account_id) DO UPDATE SET population=h.population+1;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP='UPDATE' AND
    (NEW.route,NEW.account_id) IS DISTINCT FROM (OLD.route,OLD.account_id)) THEN
    INSERT INTO library.shelf_title_owner AS h (route,account_id,population)
      VALUES (NEW.route,NEW.account_id,1)
      ON CONFLICT (route,account_id) DO UPDATE SET population=h.population+1;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER entry_shelf_title_population AFTER INSERT OR DELETE OR UPDATE ON library.entry
  FOR EACH ROW EXECUTE FUNCTION library.advance_shelf_title_population();

-- migrate:down
DROP TRIGGER entry_shelf_title_population ON library.entry;
DROP FUNCTION library.advance_shelf_title_population();
DROP TABLE library.shelf_title_key;
DROP TABLE library.shelf_title_head;
DROP TABLE library.shelf_title_owner;
