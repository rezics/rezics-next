-- Candidate references only. Current Wiki evidence/disclosure still decides
-- whether a potential publication is readable; this index grants no acceptance.
ALTER TABLE access.statement_seek
  ADD COLUMN statement_head text,
  ADD COLUMN publication_source text,
  ADD COLUMN publication_evidence boolean NOT NULL DEFAULT false;

CREATE INDEX statement_publication_subject_seek ON access.statement_seek
  (data_epoch, subject, predicate, meaning_key, statement_id)
  WHERE frame_key = '*' AND statement_head IS NOT NULL
    AND (publication_source IS NOT NULL OR publication_evidence);

-- One subject can recover without completing the dataset-wide raw projector.
-- The source membership head and Access recovery generation fence omission;
-- checkpoint CAS prevents an obsolete builder from publishing local coverage.
-- Physical continuation/EOF belongs to one native store incarnation. Delivery
-- ordering stays in the candidate B-tree, independent of native record order.
CREATE TABLE access.statement_publication_seek_coverage (
  data_epoch text NOT NULL,
  subject text COLLATE "C" NOT NULL,
  membership_head text,
  recovery_basis bigint NOT NULL CHECK (recovery_basis >= 0),
  complete boolean NOT NULL DEFAULT false,
  build_id uuid NOT NULL,
  step_revision bigint NOT NULL DEFAULT 0 CHECK (step_revision >= 0),
  phase text NOT NULL DEFAULT 'clearing' CHECK (phase IN ('clearing', 'building')),
  native_storage text NOT NULL CHECK (length(native_storage) BETWEEN 1 AND 500),
  physical_cursor jsonb,
  PRIMARY KEY (data_epoch, subject),
  CHECK (physical_cursor IS NULL OR (jsonb_typeof(physical_cursor) = 'object'
    AND physical_cursor ?& ARRAY['storage','phase','key','seal']
    AND jsonb_typeof(physical_cursor->'storage') = 'string'
    AND jsonb_typeof(physical_cursor->'seal') = 'string'
    AND physical_cursor->>'storage' = native_storage
    AND jsonb_typeof(physical_cursor->'phase') = 'number'
    AND physical_cursor->>'phase' IN ('0','1','2')
    AND jsonb_typeof(physical_cursor->'key') = 'string'
    AND physical_cursor->>'seal' ~ '^[0-9a-f]{64}$'
    AND CASE physical_cursor->>'phase'
      WHEN '0' THEN physical_cursor->>'key' ~ '^([0-9a-f]{64})?$'
      WHEN '1' THEN physical_cursor->>'key' ~ '^([0-9a-f]{48})?$'
      WHEN '2' THEN physical_cursor->>'key' = '' ELSE false END)),
  CHECK (NOT complete OR (phase = 'building' AND physical_cursor IS NOT NULL
    AND physical_cursor->>'phase' = '2' AND physical_cursor->>'key' = ''))
);

-- The existing worker resumes one incomplete neighborhood without scanning
-- already completed subjects; completion itself remains subject-local.
CREATE INDEX statement_publication_seek_pending ON access.statement_publication_seek_coverage
  (data_epoch, subject) WHERE NOT complete;
