-- migrate:up
ALTER TABLE library.progress_session
  ADD COLUMN journal_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN journal_start_year integer,
  ADD COLUMN journal_start_month smallint,
  ADD COLUMN journal_start_day smallint,
  ADD COLUMN journal_finish_year integer,
  ADD COLUMN journal_finish_month smallint,
  ADD COLUMN journal_finish_day smallint,
  ADD COLUMN journal_reflection text,
  ADD CONSTRAINT progress_session_journal_revision_check CHECK (journal_revision BETWEEN 0 AND 2147483646),
  ADD CONSTRAINT progress_session_journal_start_date_check CHECK (
    (journal_start_year IS NULL AND journal_start_month IS NULL AND journal_start_day IS NULL)
    OR (
      journal_start_year IS NOT NULL AND journal_start_year BETWEEN 1 AND 9999
      AND (journal_start_month IS NULL OR journal_start_month BETWEEN 1 AND 12)
      AND (
        journal_start_day IS NULL OR (
          journal_start_month IS NOT NULL
          AND journal_start_day BETWEEN 1 AND CASE
            WHEN journal_start_month = 2 THEN
              CASE WHEN journal_start_year % 400 = 0 OR (journal_start_year % 4 = 0 AND journal_start_year % 100 <> 0)
                THEN 29 ELSE 28 END
            WHEN journal_start_month IN (4, 6, 9, 11) THEN 30
            ELSE 31
          END
        )
      )
    )
  ),
  ADD CONSTRAINT progress_session_journal_finish_date_check CHECK (
    (journal_finish_year IS NULL AND journal_finish_month IS NULL AND journal_finish_day IS NULL)
    OR (
      journal_finish_year IS NOT NULL AND journal_finish_year BETWEEN 1 AND 9999
      AND (journal_finish_month IS NULL OR journal_finish_month BETWEEN 1 AND 12)
      AND (
        journal_finish_day IS NULL OR (
          journal_finish_month IS NOT NULL
          AND journal_finish_day BETWEEN 1 AND CASE
            WHEN journal_finish_month = 2 THEN
              CASE WHEN journal_finish_year % 400 = 0 OR (journal_finish_year % 4 = 0 AND journal_finish_year % 100 <> 0)
                THEN 29 ELSE 28 END
            WHEN journal_finish_month IN (4, 6, 9, 11) THEN 30
            ELSE 31
          END
        )
      )
    )
  ),
  ADD CONSTRAINT progress_session_journal_reflection_check CHECK (
    journal_reflection IS NULL OR (
      char_length(journal_reflection) <= 2000 AND octet_length(journal_reflection) <= 4096
    )
  );

-- migrate:down
-- Forward only: private occurrence journals are retained user data.
