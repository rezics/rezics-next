import type { Query } from "reylo";
export type Params = {
    start_year?: number | null;
    start_month?: number | null;
    start_day?: number | null;
    finish_year?: number | null;
    finish_month?: number | null;
    finish_day?: number | null;
    reflection?: string | null;
    assessment_units?: number | null;
    assessment_presence?: string | null;
    assessment_meaning_revision: number;
    route: number;
    account_id: string;
    session_id: string;
    revision: number;
};
export type Row = {
    sessionId: string;
    revision: number;
    startYear: number | null;
    startMonth: number | null;
    startDay: number | null;
    finishYear: number | null;
    finishMonth: number | null;
    finishDay: number | null;
    reflection: string | null;
    assessmentPresence: string | null;
    assessmentUnits: number | null;
    assessmentMeaningRevision: number;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "UPDATE library.progress_session\nSET journal_revision = journal_revision + 1,\n    journal_start_year = $1::integer,\n    journal_start_month = $2::smallint,\n    journal_start_day = $3::smallint,\n    journal_finish_year = $4::integer,\n    journal_finish_month = $5::smallint,\n    journal_finish_day = $6::smallint,\n    journal_reflection = $7::text,\n    journal_assessment_units = $8::smallint,\n    journal_assessment_presence = COALESCE($9::text,journal_assessment_presence),\n    journal_assessment_meaning_revision = $10::smallint\nWHERE state <> 'retired' AND route = $11 AND account_id = $12 AND session_id = $13 AND journal_revision = $14\nRETURNING session_id AS \"sessionId\", journal_revision AS revision,\n          journal_start_year AS \"startYear\", journal_start_month AS \"startMonth\",\n          journal_start_day AS \"startDay\", journal_finish_year AS \"finishYear\",\n          journal_finish_month AS \"finishMonth\", journal_finish_day AS \"finishDay\",\n          journal_reflection AS reflection,\n          journal_assessment_presence AS \"assessmentPresence\",\n          journal_assessment_units AS \"assessmentUnits\",\n          journal_assessment_meaning_revision AS \"assessmentMeaningRevision\";";
export declare const raw: "UPDATE library.progress_session\nSET journal_revision = journal_revision + 1,\n    journal_start_year = :start_year::nullable(integer),\n    journal_start_month = :start_month::nullable(smallint),\n    journal_start_day = :start_day::nullable(smallint),\n    journal_finish_year = :finish_year::nullable(integer),\n    journal_finish_month = :finish_month::nullable(smallint),\n    journal_finish_day = :finish_day::nullable(smallint),\n    journal_reflection = :reflection::nullable(text),\n    journal_assessment_units = :assessment_units::nullable(smallint),\n    journal_assessment_presence = COALESCE(:assessment_presence::nullable(text),journal_assessment_presence),\n    journal_assessment_meaning_revision = :assessment_meaning_revision::smallint\nWHERE state <> 'retired' AND route = :route AND account_id = :account_id AND session_id = :session_id AND journal_revision = :revision\nRETURNING session_id AS \"sessionId\", journal_revision AS revision,\n          journal_start_year AS \"startYear\", journal_start_month AS \"startMonth\",\n          journal_start_day AS \"startDay\", journal_finish_year AS \"finishYear\",\n          journal_finish_month AS \"finishMonth\", journal_finish_day AS \"finishDay\",\n          journal_reflection AS reflection,\n          journal_assessment_presence AS \"assessmentPresence\",\n          journal_assessment_units AS \"assessmentUnits\",\n          journal_assessment_meaning_revision AS \"assessmentMeaningRevision\";\n";
export declare const params: readonly ["start_year", "start_month", "start_day", "finish_year", "finish_month", "finish_day", "reflection", "assessment_units", "assessment_presence", "assessment_meaning_revision", "route", "account_id", "session_id", "revision"];
/**
 * ```sql
 * UPDATE library.progress_session
 * SET journal_revision = journal_revision + 1,
 *     journal_start_year = :start_year::nullable(integer),
 *     journal_start_month = :start_month::nullable(smallint),
 *     journal_start_day = :start_day::nullable(smallint),
 *     journal_finish_year = :finish_year::nullable(integer),
 *     journal_finish_month = :finish_month::nullable(smallint),
 *     journal_finish_day = :finish_day::nullable(smallint),
 *     journal_reflection = :reflection::nullable(text),
 *     journal_assessment_units = :assessment_units::nullable(smallint),
 *     journal_assessment_presence = COALESCE(:assessment_presence::nullable(text),journal_assessment_presence),
 *     journal_assessment_meaning_revision = :assessment_meaning_revision::smallint
 * WHERE state <> 'retired' AND route = :route AND account_id = :account_id AND session_id = :session_id AND journal_revision = :revision
 * RETURNING session_id AS "sessionId", journal_revision AS revision,
 *           journal_start_year AS "startYear", journal_start_month AS "startMonth",
 *           journal_start_day AS "startDay", journal_finish_year AS "finishYear",
 *           journal_finish_month AS "finishMonth", journal_finish_day AS "finishDay",
 *           journal_reflection AS reflection,
 *           journal_assessment_presence AS "assessmentPresence",
 *           journal_assessment_units AS "assessmentUnits",
 *           journal_assessment_meaning_revision AS "assessmentMeaningRevision";
 * ```
 */
declare const query: Query<{
    start_year?: number | null;
    start_month?: number | null;
    start_day?: number | null;
    finish_year?: number | null;
    finish_month?: number | null;
    finish_day?: number | null;
    reflection?: string | null;
    assessment_units?: number | null;
    assessment_presence?: string | null;
    assessment_meaning_revision: number;
    route: number;
    account_id: string;
    session_id: string;
    revision: number;
}, {
    sessionId: string;
    revision: number;
    startYear: number | null;
    startMonth: number | null;
    startDay: number | null;
    finishYear: number | null;
    finishMonth: number | null;
    finishDay: number | null;
    reflection: string | null;
    assessmentPresence: string | null;
    assessmentUnits: number | null;
    assessmentMeaningRevision: number;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
