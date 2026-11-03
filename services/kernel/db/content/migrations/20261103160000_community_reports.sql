-- migrate:up
ALTER TABLE content.report DROP CONSTRAINT report_target_kind_check;
ALTER TABLE content.report ADD CONSTRAINT report_target_kind_check
  CHECK (target_kind IN ('board','thread','post','subject','space','realm'));
ALTER TABLE content.report_target DROP CONSTRAINT report_target_target_kind_check;
ALTER TABLE content.report_target ADD CONSTRAINT report_target_target_kind_check
  CHECK (target_kind IN ('board','thread','post','subject','space','realm'));
ALTER TABLE content.report DROP CONSTRAINT report_check2;
ALTER TABLE content.report ADD CONSTRAINT report_check2
  CHECK (revision_id IS NULL OR target_kind IN ('thread','post'));
-- New reports own their immutable security/head observation. Existing retained reports remain readable.
ALTER TABLE content.report ADD COLUMN target_witness jsonb;
ALTER TABLE content.report ADD CONSTRAINT report_witness_bytes
  CHECK (target_witness IS NULL OR octet_length(target_witness::text) <= 16384);
-- Keep the existing catalogue relation/index and its Subject compatibility column.
ALTER TABLE content.catalogue_report_candidate ADD COLUMN target_kind text NOT NULL DEFAULT 'subject'
  CHECK (target_kind IN ('subject','space','realm'));
CREATE INDEX catalogue_report_candidate_kind_page_idx ON content.catalogue_report_candidate
  (route, target_kind, created_at DESC, report_id DESC) INCLUDE (report_route, subject_id);

-- migrate:down
-- Retained reports cannot be discarded on rollback; an incompatible population rejects rollback.
DROP INDEX content.catalogue_report_candidate_kind_page_idx;
ALTER TABLE content.catalogue_report_candidate DROP COLUMN target_kind;
ALTER TABLE content.report DROP CONSTRAINT report_witness_bytes;
ALTER TABLE content.report DROP COLUMN target_witness;
ALTER TABLE content.report DROP CONSTRAINT report_check2;
ALTER TABLE content.report ADD CONSTRAINT report_check2 CHECK (revision_id IS NULL OR target_kind NOT IN ('board','subject'));
ALTER TABLE content.report DROP CONSTRAINT report_target_kind_check;
ALTER TABLE content.report ADD CONSTRAINT report_target_kind_check CHECK (target_kind IN ('board','thread','post','subject'));
ALTER TABLE content.report_target DROP CONSTRAINT report_target_target_kind_check;
ALTER TABLE content.report_target ADD CONSTRAINT report_target_target_kind_check CHECK (target_kind IN ('board','thread','post','subject'));
