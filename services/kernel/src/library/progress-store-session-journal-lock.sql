SELECT session_id AS "sessionId", account_id AS "accountId", journal_revision AS revision,
       journal_start_year AS "startYear", journal_start_month AS "startMonth",
       journal_start_day AS "startDay", journal_finish_year AS "finishYear",
       journal_finish_month AS "finishMonth", journal_finish_day AS "finishDay",
       journal_reflection AS reflection,
       journal_assessment_meaning_revision AS "assessmentMeaningRevision",
       journal_assessment_units AS "assessmentUnits"
FROM library.progress_session
WHERE state <> 'retired' AND route = :route AND account_id = :account_id AND session_id = :session_id
FOR UPDATE;
