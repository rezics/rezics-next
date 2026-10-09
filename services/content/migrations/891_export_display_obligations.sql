-- A missing export head is unassessed, not an unprotected fact. change_indication
-- is an export obligation. Keep every previous basis kind and obligation.
DO $$
DECLARE
  basis_name text;
  obligation_name text;
BEGIN
  SELECT conname INTO basis_name FROM pg_constraint
    WHERE conrelid = 'export.rights_basis'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE 'CHECK ((basis_kind = ANY%';
  IF basis_name IS NULL THEN
    RAISE EXCEPTION 'export basis_kind check is missing';
  END IF;
  EXECUTE format('ALTER TABLE export.rights_basis DROP CONSTRAINT %I', basis_name);
  ALTER TABLE export.rights_basis ADD CONSTRAINT rights_basis_basis_kind_check
    CHECK (basis_kind IN ('license_offering', 'use_assessment', 'public_domain',
      'unprotected_fact', 'statutory_exception', 'native_contribution', 'unassessed'));

  SELECT conname INTO obligation_name FROM pg_constraint
    WHERE conrelid = 'export.rights_basis'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%obligations <@%';
  IF obligation_name IS NULL THEN
    RAISE EXCEPTION 'export obligations check is missing';
  END IF;
  EXECUTE format('ALTER TABLE export.rights_basis DROP CONSTRAINT %I', obligation_name);
  ALTER TABLE export.rights_basis ADD CONSTRAINT rights_basis_obligations_check
    CHECK (cardinality(obligations) <= 6
      AND obligations <@ ARRAY['attribution', 'share_alike', 'non_commercial', 'no_derivatives',
        'notice_retention', 'change_indication', 'access_restriction']::text[]);
END $$;
