ALTER TABLE access.baseline_admission
    ADD COLUMN author_work text CHECK (author_work ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    ADD COLUMN author_generation bigint CHECK (author_generation >= 0),
    ADD COLUMN submission_contribution text
      CHECK (submission_contribution ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$');
CREATE INDEX baseline_admission_author_work ON access.baseline_admission (author_work)
    WHERE author_work IS NOT NULL;
