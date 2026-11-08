/** Native progress catalog. Access/Semantic descriptors and shelf-maintenance plans are bound here. */
import type { ProgressOperationCatalog } from '../contract/index.ts';
export declare const PROGRESS_MEANING_SQL = "INSERT INTO library.reading_insights_progress_meaning\n        (route,session_id,unit_id,meaning_revision,mode,profile_pin,dimension,precision,minimum,maximum,\n         total_policy,identity_kind,structure_kind)\n       SELECT $1,$2,unit_id,1,mode,$3::jsonb,dimension,precision,minimum,maximum,total_policy,identity_kind,structure_kind\n       FROM jsonb_to_recordset($4::jsonb) AS accepted(\n         unit_id text, mode text, dimension text, precision smallint, minimum numeric, maximum numeric,\n         total_policy text, identity_kind text, structure_kind text)";
export declare const PROGRESS_REFRESH_SQL = "SELECT library.reading_insights_current_progress_refresh($1,$2)";
export declare function createProgressOperationCatalog(): ProgressOperationCatalog;
