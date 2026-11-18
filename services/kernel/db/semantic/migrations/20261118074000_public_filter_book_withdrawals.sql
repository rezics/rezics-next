-- migrate:up
ALTER TABLE semantic.public_filter_bootstrap ADD COLUMN book_withdrawals jsonb,
  ADD CONSTRAINT public_filter_book_withdrawals_check CHECK (book_withdrawals IS NULL OR
    (coverage_publication IS NOT NULL AND snapshot_kind='pit' AND jsonb_typeof(book_withdrawals)='array'
      AND jsonb_array_length(book_withdrawals) BETWEEN 1 AND 8));

CREATE INDEX public_filter_book_withdrawal_cut ON semantic.public_filter_bootstrap
  (coverage_publication,coverage_generation) WHERE book_withdrawals IS NOT NULL;

CREATE FUNCTION semantic.public_filter_book_withdrawal_covers(
  h search.public_filter_coverage_home, original uuid, withdrawals jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT h.baseline_bootstrap=original AND h.acknowledged_baseline=original
    AND h.native_enqueue_revision=h.acknowledged_native_enqueue
    AND h.native_revision IS NOT DISTINCT FROM h.acknowledged_native_revision
    AND h.native_claim_revision IS NOT DISTINCT FROM h.acknowledged_native_claim_revision
    AND withdrawals @> jsonb_build_array(jsonb_build_object(
      'home',h.source_home,'epoch',h.source_epoch,'position',h.relevant_position::text))
$$;

CREATE OR REPLACE FUNCTION semantic.retain_public_filter_publication_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coverage_publication IS DISTINCT FROM OLD.coverage_publication
    OR NEW.book_withdrawals IS DISTINCT FROM OLD.book_withdrawals THEN
    RAISE EXCEPTION 'Original publication coverage binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
DROP FUNCTION semantic.public_filter_book_withdrawal_covers(search.public_filter_coverage_home,uuid,jsonb);
DROP INDEX semantic.public_filter_book_withdrawal_cut;
CREATE OR REPLACE FUNCTION semantic.retain_public_filter_publication_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coverage_publication IS DISTINCT FROM OLD.coverage_publication THEN
    RAISE EXCEPTION 'Original publication coverage binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE semantic.public_filter_bootstrap DROP COLUMN book_withdrawals;
