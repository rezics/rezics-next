-- migrate:up
ALTER TABLE semantic.identity_epoch_admission_plan ADD COLUMN waiting boolean NOT NULL DEFAULT true;
CREATE INDEX identity_epoch_admission_waiters ON semantic.identity_epoch_admission_plan(resource_home,job_id)
 WHERE waiting;

-- migrate:down
-- Forward-only retained native recovery index.
