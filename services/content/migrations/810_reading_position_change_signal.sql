-- Revelation generations are equality fences. One change row per transaction
-- replaces the statement trigger's shared counter, including bulk publication.
CREATE TABLE reading_position.change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_epoch uuid NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX reading_position_change_order ON reading_position.change(data_epoch,xid,id);
CREATE OR REPLACE FUNCTION reading_position.advance_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.revelation_changed',true) = 'on' THEN RETURN NULL; END IF;
  INSERT INTO reading_position.change(data_epoch) SELECT data_epoch FROM content.owner_control WHERE singleton;
  PERFORM set_config('rezics.revelation_changed','on',true);
  RETURN NULL;
END $$;
CREATE FUNCTION reading_position.current_generation() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT data_epoch,pg_current_snapshot() AS snapshot FROM content.owner_control WHERE singleton
  )
  SELECT encode(sha256(convert_to(concat_ws('|',g.version::text,h.data_epoch::text,
    (SELECT concat_ws('/',c.xid::text,c.id::text) FROM reading_position.change c
      WHERE c.data_epoch = h.data_epoch AND c.xid < pg_snapshot_xmin(h.snapshot)
      ORDER BY c.xid DESC,c.id DESC LIMIT 1),
    CASE WHEN EXISTS (SELECT 1 FROM reading_position.change c
      WHERE c.data_epoch = h.data_epoch AND c.xid >= pg_snapshot_xmin(h.snapshot))
      THEN h.snapshot::text END),'UTF8')),'hex')
  FROM reading_position.generation g CROSS JOIN horizon h WHERE g.singleton;
$$;
