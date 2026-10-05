-- Shelf writers no longer update the co-reader fence row they all shared until
-- commit. A writing transaction appends one change row instead; only a
-- co-reader builder folds visible rows into the revision and locks the fence.
-- A basis is the revision a fold returned and stays current while the revision
-- is equal and no change row exists. An uncommitted shelf change is invisible
-- to every fold, so its row outdates the basis when it commits. No transaction
-- counter is involved, so a logical restore keeps rows and revision together.
CREATE TABLE reader.also_enjoyed_source_change (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);

-- One row per transaction: any shelf change outdates every basis. The
-- transaction-local mark reverts with a rolled-back savepoint.
CREATE FUNCTION reader.record_also_enjoyed_source_change() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.also_enjoyed_shelf_changed', true) = 'on' THEN RETURN; END IF;
  INSERT INTO reader.also_enjoyed_source_change DEFAULT VALUES;
  PERFORM set_config('rezics.also_enjoyed_shelf_changed', 'on', true);
END $$;

-- Migration 602's membership filter is unchanged.
CREATE OR REPLACE FUNCTION reader.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.agent, NEW.work, NEW.status)
    IS NOT DISTINCT FROM (OLD.agent, OLD.work, OLD.status) THEN RETURN NULL; END IF;
  PERFORM reader.record_also_enjoyed_source_change();
  RETURN NULL;
END $$;

-- Folders serialize on the fence row, after the cheap unlocked check that
-- nothing is pending. Each call folds at most 100,000 rows; any rows left keep
-- reporting a change until the next fold.
CREATE FUNCTION reader.fold_also_enjoyed_source_changes(OUT basis bigint, OUT changed boolean)
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
BEGIN
  SELECT f.revision, false INTO basis, changed FROM reader.also_enjoyed_source_fence f
    WHERE f.id AND NOT EXISTS (SELECT 1 FROM reader.also_enjoyed_source_change);
  IF FOUND THEN RETURN; END IF;
  PERFORM 1 FROM reader.also_enjoyed_source_fence WHERE id FOR UPDATE;
  WITH folded AS (DELETE FROM reader.also_enjoyed_source_change WHERE id IN
    (SELECT id FROM reader.also_enjoyed_source_change ORDER BY id LIMIT 100000) RETURNING id)
  UPDATE reader.also_enjoyed_source_fence SET revision = revision + 1
    WHERE id AND EXISTS (SELECT 1 FROM folded);
  PERFORM set_config('rezics.also_enjoyed_shelf_changed', '', true);
  SELECT f.revision, EXISTS (SELECT 1 FROM reader.also_enjoyed_source_change) INTO basis, changed
    FROM reader.also_enjoyed_source_fence f WHERE f.id;
END $$;
