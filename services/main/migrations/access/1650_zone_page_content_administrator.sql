-- Content keeps its action and page scope; the existing administrator proof
-- pins the server-resolved Zone used by zone.edit at register, replay and claim.
-- The table's existing immutable trigger also protects this column.
ALTER TABLE access.platform_administrator_admission
  ADD COLUMN resolved_zone_page text
  CHECK (resolved_zone_page ~ '^https://rezics\.com/id/[0-9a-f-]{36}$');
