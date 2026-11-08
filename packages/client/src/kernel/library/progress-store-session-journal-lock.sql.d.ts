import type { Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
    session_id: string;
};
export type Row = {
    sessionId: string;
    accountId: string;
    revision: number;
    startYear: number | null;
    startMonth: number | null;
    startDay: number | null;
    finishYear: number | null;
    finishMonth: number | null;
    finishDay: number | null;
    reflection: string | null;
    assessmentUnits: number | null;
    assessmentPresence: string | null;
    assessmentMeaningRevision: number;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT session_id AS \"sessionId\", account_id AS \"accountId\", journal_revision AS revision,\n       journal_start_year AS \"startYear\", journal_start_month AS \"startMonth\",\n       journal_start_day AS \"startDay\", journal_finish_year AS \"finishYear\",\n       journal_finish_month AS \"finishMonth\", journal_finish_day AS \"finishDay\",\n       journal_reflection AS reflection,\n       journal_assessment_units AS \"assessmentUnits\",\n       journal_assessment_presence AS \"assessmentPresence\",\n       journal_assessment_meaning_revision AS \"assessmentMeaningRevision\"\nFROM library.progress_session\nWHERE state <> 'retired' AND route = $1 AND account_id = $2 AND session_id = $3\nFOR UPDATE;";
export declare const raw: "SELECT session_id AS \"sessionId\", account_id AS \"accountId\", journal_revision AS revision,\n       journal_start_year AS \"startYear\", journal_start_month AS \"startMonth\",\n       journal_start_day AS \"startDay\", journal_finish_year AS \"finishYear\",\n       journal_finish_month AS \"finishMonth\", journal_finish_day AS \"finishDay\",\n       journal_reflection AS reflection,\n       journal_assessment_units AS \"assessmentUnits\",\n       journal_assessment_presence AS \"assessmentPresence\",\n       journal_assessment_meaning_revision AS \"assessmentMeaningRevision\"\nFROM library.progress_session\nWHERE state <> 'retired' AND route = :route AND account_id = :account_id AND session_id = :session_id\nFOR UPDATE;\n";
export declare const params: readonly ["route", "account_id", "session_id"];
/**
 * ```sql
 * SELECT session_id AS "sessionId", account_id AS "accountId", journal_revision AS revision,
 *        journal_start_year AS "startYear", journal_start_month AS "startMonth",
 *        journal_start_day AS "startDay", journal_finish_year AS "finishYear",
 *        journal_finish_month AS "finishMonth", journal_finish_day AS "finishDay",
 *        journal_reflection AS reflection,
 *        journal_assessment_units AS "assessmentUnits",
 *        journal_assessment_presence AS "assessmentPresence",
 *        journal_assessment_meaning_revision AS "assessmentMeaningRevision"
 * FROM library.progress_session
 * WHERE state <> 'retired' AND route = :route AND account_id = :account_id AND session_id = :session_id
 * FOR UPDATE;
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
    session_id: string;
}, {
    sessionId: string;
    accountId: string;
    revision: number;
    startYear: number | null;
    startMonth: number | null;
    startDay: number | null;
    finishYear: number | null;
    finishMonth: number | null;
    finishDay: number | null;
    reflection: string | null;
    assessmentUnits: number | null;
    assessmentPresence: string | null;
    assessmentMeaningRevision: number;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
