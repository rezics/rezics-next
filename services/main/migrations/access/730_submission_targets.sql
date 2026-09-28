-- Preserve existing text submissions and immutable snapshots. Resource targets
-- carry their own exact Work/publication basis without a fabricated TextContribution.
ALTER TABLE access.realm_submission DROP CONSTRAINT realm_submission_kind_check;
ALTER TABLE access.realm_submission ADD CONSTRAINT realm_submission_kind_check
  CHECK (kind IN ('contribution', 'correction', 'work', 'content-publication'));
ALTER TABLE access.realm_submission ALTER COLUMN contribution DROP NOT NULL;
ALTER TABLE access.realm_submission ALTER COLUMN publication_decision DROP NOT NULL;
ALTER TABLE access.realm_submission ALTER COLUMN selected_draft DROP NOT NULL;
ALTER TABLE access.realm_submission ADD COLUMN target jsonb;
ALTER TABLE access.realm_submission ADD CONSTRAINT realm_submission_target_check CHECK (
  (kind IN ('contribution', 'correction') AND target IS NULL
    AND contribution IS NOT NULL AND publication_decision IS NOT NULL AND selected_draft IS NOT NULL)
  OR (kind IN ('work', 'content-publication') AND target IS NOT NULL AND jsonb_typeof(target) = 'object'
    AND target ?& ARRAY['kind', 'work', 'mainVersion', 'actingSubject', 'workRevision']
    AND target->>'kind' = kind AND target->>'work' = work AND target->>'mainVersion' = main_version
    AND target->>'actingSubject' = submitting_agent AND target ? 'workRevision'
    AND contribution IS NULL AND selected_draft IS NULL AND correction_of IS NULL
    AND ((kind = 'work' AND publication_decision IS NULL)
      OR (kind = 'content-publication' AND target ?& ARRAY['variant', 'publicationDecision', 'contentRevision']
        AND publication_decision IS NOT NULL AND target->>'publicationDecision' = publication_decision)))
);
