-- Count successful reservations, including reservations preceding the quota.
-- A single principal row serializes concurrent inserts. ON CONFLICT losers do
-- not fire the AFTER trigger, so adopting an existing identity costs no quota.
CREATE TABLE access.projection_creator_quota (
  principal_id uuid PRIMARY KEY REFERENCES access.principal(id),
  reservations integer NOT NULL CHECK (reservations >= 0)
);
INSERT INTO access.projection_creator_quota (principal_id, reservations)
SELECT a.principal_id, count(*) FROM access.projection_identity p
JOIN access.admission a ON a.id = p.admission_id GROUP BY a.principal_id;

CREATE FUNCTION access.enforce_projection_creation_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE creator uuid;
BEGIN
  SELECT principal_id INTO STRICT creator FROM access.admission WHERE id = NEW.admission_id;
  INSERT INTO access.projection_creator_quota (principal_id, reservations)
    VALUES (creator, 0) ON CONFLICT DO NOTHING;
  UPDATE access.projection_creator_quota SET reservations = reservations + 1
    WHERE principal_id = creator AND reservations < 1000;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Projection creation quota reached' USING ERRCODE = '23514',
      CONSTRAINT = 'projection_creation_quota';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER projection_creation_quota AFTER INSERT ON access.projection_identity
  FOR EACH ROW EXECUTE FUNCTION access.enforce_projection_creation_quota();
