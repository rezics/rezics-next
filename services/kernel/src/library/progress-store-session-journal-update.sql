UPDATE library.progress_session
SET journal_revision = journal_revision + 1,
    journal_start_year = :start_year::nullable(integer),
    journal_start_month = :start_month::nullable(smallint),
    journal_start_day = :start_day::nullable(smallint),
    journal_finish_year = :finish_year::nullable(integer),
    journal_finish_month = :finish_month::nullable(smallint),
    journal_finish_day = :finish_day::nullable(smallint),
    journal_reflection = :reflection::nullable(text)
WHERE state <> 'retired' AND route = :route AND account_id = :account_id AND session_id = :session_id AND journal_revision = :revision
RETURNING session_id AS "sessionId", journal_revision AS revision,
          journal_start_year AS "startYear", journal_start_month AS "startMonth",
          journal_start_day AS "startDay", journal_finish_year AS "finishYear",
          journal_finish_month AS "finishMonth", journal_finish_day AS "finishDay",
          journal_reflection AS reflection;
