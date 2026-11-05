-- migrate:up
-- No historical account inference. Future native writes preserve their actual owner locator.
ALTER TABLE library.native_source_fence ADD COLUMN account_id uuid;
CREATE INDEX native_source_fence_account ON library.native_source_fence (route,account_id,kind,owner_id);
CREATE INDEX native_source_hold_active ON library.native_source_hold (route,capture_id,hold_id) WHERE NOT released;

CREATE OR REPLACE FUNCTION library.advance_native_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; step integer; owner uuid; attributed uuid; r integer; k text;
BEGIN
  -- Both old and new anchors are fenced. Only native key columns enter control metadata.
  -- Conservatively fence even a no-op UPDATE, without converting business payload to JSON.
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    r := item.route;
    attributed := NULL;
    IF TG_TABLE_NAME IN ('collection','collection_member') THEN
      k := 'collection'; owner := item.collection_id;
      IF TG_TABLE_NAME='collection' THEN
        attributed := item.curator_account_id;
      END IF;
    ELSIF TG_TABLE_NAME IN ('progress_unit','progress_change') THEN
      k := 'account';
      SELECT account_id INTO owner FROM library.progress_session
        WHERE route=r AND session_id=item.session_id;
      -- Parent deletion already fences the account, including cascading child deletion.
    ELSE
      k := 'account'; owner := item.account_id;
    END IF;
    IF k='account' THEN attributed := owner; END IF;
    IF owner IS NOT NULL THEN
      INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id) VALUES(r,k,owner,1,attributed)
      ON CONFLICT (route,kind,owner_id) DO UPDATE
        SET generation=library.native_source_fence.generation+1,
            account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id);
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;

-- FK children must be gone before the existing owner operation can retire immutable provenance.
DROP TRIGGER native_source_receipt_immutable ON library.native_source_receipt;
CREATE TRIGGER native_source_receipt_immutable BEFORE UPDATE ON library.native_source_receipt
  FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();

-- migrate:down
-- Forward only: preserve owner locators and bounded retirement.
