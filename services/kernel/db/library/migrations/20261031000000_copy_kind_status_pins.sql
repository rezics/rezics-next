-- migrate:up
-- Existing mutable compatibility pins cannot prove original kind acceptance.
-- NULL is deliberate: only native fresh creation or explicit fixed-contract migration captures both meanings.
ALTER TABLE library.copy
  ADD COLUMN kind_profile_pin jsonb,
  ADD COLUMN status_profile_pin jsonb,
  ADD CONSTRAINT copy_kind_profile_pin_check
    CHECK (kind_profile_pin IS NULL OR library.library_profile_pin_valid(kind_profile_pin)),
  ADD CONSTRAINT copy_status_profile_pin_check
    CHECK (status_profile_pin IS NULL OR library.library_profile_pin_valid(status_profile_pin));

-- migrate:down
-- Forward-only: captured personal provenance must not be discarded.
