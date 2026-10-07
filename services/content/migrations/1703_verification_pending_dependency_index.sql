-- Summary reads probe only their pinned dependencies. Completed history and
-- unrelated pending work must not participate in those exact pending seeks.
CREATE INDEX invalidation_pending_dependency
  ON verification.invalidation (kind, reference) WHERE state = 'pending';
