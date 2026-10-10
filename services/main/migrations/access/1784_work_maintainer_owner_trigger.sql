-- The first maintainer row of a Work is its owner. Creation paths that omit
-- the flag (catalogue import, fixtures, any later writer) still leave exactly
-- one. A later insert stays a non-owner unless that statement sets the flag;
-- the partial unique index then rejects a second owner. Transfer moves the
-- flag with UPDATE and remove deletes a row, so this insert trigger leaves both.
CREATE FUNCTION access.work_maintainer_first_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.work_maintainer WHERE work = NEW.work) THEN
    NEW.owner := true;
  ELSIF NEW.owner IS DISTINCT FROM true THEN
    NEW.owner := false;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_maintainer_first_owner
  BEFORE INSERT ON access.work_maintainer
  FOR EACH ROW EXECUTE FUNCTION access.work_maintainer_first_owner();

-- A create receipt written without an owner records the Work's owner. Add,
-- transfer and remove receipts are written with the owner they left behind
-- and are not rewritten here.
CREATE FUNCTION access.work_maintainer_create_receipt_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'create' AND NEW.owner IS NULL THEN
    SELECT agent INTO NEW.owner FROM access.work_maintainer
      WHERE work = NEW.work AND owner;
    IF NEW.owner IS NULL THEN
      NEW.owner := NEW.target;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_maintainer_create_receipt_owner
  BEFORE INSERT ON access.work_maintainer_receipt
  FOR EACH ROW
  WHEN (NEW.action = 'create' AND NEW.owner IS NULL)
  EXECUTE FUNCTION access.work_maintainer_create_receipt_owner();
