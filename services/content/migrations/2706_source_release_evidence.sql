-- Native list/detail reads select optional retained references by the exact
-- immutable component revision, independently of any converter registration.
CREATE INDEX field_support_step_native_revision_idx ON source.field_support_step
  ((native_acknowledgement->>'component'),(native_acknowledgement->>'revision'),support_id,id)
  WHERE native_acknowledgement IS NOT NULL;
