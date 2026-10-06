-- Matching shares transform storage, but never scans screen/width job queues.
CREATE INDEX required_match_job_ready ON media.transform_job (created_at, id)
  WHERE profile = 'required-image-match-v1' AND status IN ('queued', 'leased');
