-- migrate:up
CREATE TABLE economy.asset_program_expiry (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  retired_at timestamptz CHECK (retired_at >= expires_at),
  PRIMARY KEY (book_id, asset_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset_program (book_id, asset_id)
);

CREATE INDEX asset_program_expiry_ready_idx
  ON economy.asset_program_expiry (book_id, expires_at, asset_id)
  WHERE retired_at IS NULL;

CREATE FUNCTION economy.queue_asset_program_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO economy.asset_program_expiry (book_id, asset_id, expires_at)
  VALUES (NEW.book_id, NEW.asset_id, NEW.expires_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_program_enqueue_expiry AFTER INSERT ON economy.asset_program
FOR EACH ROW WHEN (NEW.expires_at IS NOT NULL)
EXECUTE FUNCTION economy.queue_asset_program_expiry();

INSERT INTO economy.asset_program_expiry (book_id, asset_id, expires_at)
SELECT book_id, asset_id, expires_at FROM economy.asset_program WHERE expires_at IS NOT NULL;

-- migrate:down
DROP TRIGGER asset_program_enqueue_expiry ON economy.asset_program;
DROP FUNCTION economy.queue_asset_program_expiry();
DROP TABLE economy.asset_program_expiry;
