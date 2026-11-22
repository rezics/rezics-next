-- migrate:up
-- Drain old stamp writers before initializing the new comparison addresses.
LOCK TABLE semantic.subject_access_range_revision_v1 IN SHARE ROW EXCLUSIVE MODE;

-- The four Source lanes already serialize changes to the native page stamps.
-- Keep 32 adjacent page revisions per lane so one locked read covers the
-- whole tree and a range can select just the pages it independently compared.
ALTER TABLE search.public_filter_repair_authority ADD COLUMN subject_pages bytea;
UPDATE search.public_filter_repair_authority SET subject_pages=decode(repeat(replace(gen_random_uuid()::text,'-',''),32),'hex')
  WHERE physical_target='@source';
ALTER TABLE search.public_filter_repair_authority ADD CONSTRAINT subject_ack_page_clock CHECK (
  subject_pages IS NULL OR (physical_target='@source' AND octet_length(subject_pages)=512));

CREATE OR REPLACE FUNCTION search.change_subject_ack_stamp_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_home integer; new_home integer; home integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE search.public_filter_repair_authority SET revision=revision+1,
      subject_pages=decode(repeat(replace(gen_random_uuid()::text,'-',''),32),'hex') WHERE physical_target='@source';
  ELSE
    IF TG_OP<>'INSERT' THEN old_home:=OLD.first_home; END IF;
    IF TG_OP<>'DELETE' THEN new_home:=NEW.first_home; END IF;
    FOR home IN SELECT DISTINCT h FROM unnest(ARRAY[old_home,new_home]) h WHERE h IS NOT NULL ORDER BY h LOOP
      UPDATE search.public_filter_repair_authority SET revision=revision+1,
        subject_pages=overlay(subject_pages placing uuid_send(gen_random_uuid()) from 1+16*((home/32)%32) for 16)
        WHERE (physical_target,lane)=('@source',home/1024);
      IF NOT FOUND THEN RAISE EXCEPTION 'Missing Subject ACK page clock' USING ERRCODE='40001'; END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE TYPE search.public_filter_ack_basis_v1 AS (authority bytea,pages bytea);
CREATE FUNCTION search.public_filter_ack_basis_v1(shared boolean) RETURNS search.public_filter_ack_basis_v1
LANGUAGE plpgsql STRICT AS $$
DECLARE basis search.public_filter_ack_basis_v1;
BEGIN
  IF shared THEN
    basis.authority:=search.public_filter_ack_witness(ARRAY['','@ack-retention']);
    SELECT CASE WHEN count(subject_pages)=4 THEN string_agg(subject_pages,''::bytea ORDER BY lane) END INTO basis.pages FROM
      (SELECT lane,subject_pages FROM search.public_filter_repair_authority
       WHERE physical_target='@source' ORDER BY lane FOR SHARE) locked;
    IF basis.pages IS NULL THEN RAISE EXCEPTION 'Missing Subject ACK page clocks' USING ERRCODE='40001'; END IF;
  ELSE
    basis.authority:=search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']);
  END IF;
  RETURN basis;
END $$;

CREATE FUNCTION search.public_filter_ack_range_witness(cut uuid,first_no integer,span integer,basis search.public_filter_ack_basis_v1)
RETURNS bytea LANGUAGE sql VOLATILE STRICT AS $$
  SELECT search.public_filter_ack_range_witness(cut,first_no,span,
    CASE WHEN basis.pages IS NULL THEN basis.authority ELSE sha256(basis.authority ||
      substring(basis.pages FROM 1+16*(first_no/32) FOR 16*((first_no+span-1)/32-first_no/32+1))) END)
$$;

-- Use the same comparison address in planning, independent leaf and parent
-- comparison, and the final manifest. Keep the historical continuity digest
-- and the separate publication/writer fence on their existing authority.
DO $$
DECLARE target regprocedure; previous text; replacement text; shared text;
  old_basis constant text:='search.public_filter_ack_witness(ARRAY['''',''@ack-retention'',''@accounts'',''@source''])';
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'search.prepare_public_filter_ack(uuid,integer)'::regprocedure,
    'search.prepare_public_filter_ack_batch(uuid,integer,integer)'::regprocedure,
    'search.prepare_subject_ack_prefix_v1(uuid,integer,integer)'::regprocedure,
    'search.compare_public_filter_ack_range()'::regprocedure,
    'search.compare_subject_receiver_leaf_v1()'::regprocedure,
    'search.compare_subject_compact_range_v1()'::regprocedure,
    'search.bind_public_filter_ack_manifest()'::regprocedure
  ] LOOP
    previous:=pg_get_functiondef(target);
    shared:=CASE WHEN target IN ('search.prepare_subject_ack_prefix_v1(uuid,integer,integer)'::regprocedure,
      'search.compare_subject_receiver_leaf_v1()'::regprocedure,'search.compare_subject_compact_range_v1()'::regprocedure)
      THEN 'true' ELSE 'search.shared_subject_job_v1(a.job)' END;
    replacement:=replace(previous,old_basis,'search.public_filter_ack_basis_v1('||shared||')');
    IF replacement=previous THEN RAISE EXCEPTION 'Missing original comparison basis in %',target; END IF;
    replacement:=replace(replace(replacement,'foreign_cut bytea','foreign_cut search.public_filter_ack_basis_v1'),
      'witness_cut bytea','witness_cut search.public_filter_ack_basis_v1');
    EXECUTE replacement;
  END LOOP;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject ACK clock requires forward migration'; END $$;
