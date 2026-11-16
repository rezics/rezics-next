import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { IndexedStatement } from '../search/source.ts';
import type { WorkHeader } from './credit-search-cut.ts';
export declare const SEARCH_INDEX_STATEMENT_KEYS = 4;
export declare const SEARCH_INDEX_STATEMENT_BYTES = 65536;
export declare const SEARCH_INDEX_PROVENANCE_BYTES = 4096;
export declare const readCanonicalStatementCountSql = "SELECT count(*)::integer AS count\n FROM (SELECT 1 FROM semantic.search_selected\n  WHERE (route,subject_id)=($1,$2) AND active LIMIT 5) selected";
export declare const readCanonicalStatementPresenceSql = "SELECT 1 FROM semantic.search_selected\n WHERE (route,subject_id)=($1,$2) AND active LIMIT 1";
export declare const readCanonicalStatementsSql = "WITH raw AS MATERIALIZED (\n SELECT route,subject_id,slot_id,candidate_id,property,rank,ordinal,body,release,revision,relation,compact,source\n FROM semantic.search_selected WHERE (route,subject_id)=($1,$2) AND active\n ORDER BY property,slot_id,candidate_id LIMIT ($3::integer+1)\n), selected AS MATERIALIZED (\n SELECT raw.*,row_number() OVER (ORDER BY property,slot_id,candidate_id) AS ordinal_in_window FROM raw\n), admitted AS MATERIALIZED (\n SELECT * FROM selected WHERE ordinal_in_window<=$3\n), evidence AS MATERIALIZED (\n SELECT s.*,\n   (h IS NOT NULL OR l IS NOT NULL OR (d.disclosed IS NOT NULL AND (NOT d.disclosed OR r IS NOT NULL))) AS concealed,\n   (s.property=ANY($4::text[]) AND h IS NULL AND r IS NULL AND (d.disclosed IS NULL OR d.disclosed)\n     AND (s.compact OR a.verdict='accept' OR (c.origin='compact' AND a.verdict IS NULL))) IS TRUE AS eligible\n FROM admitted s\n LEFT JOIN LATERAL (SELECT 1 FROM semantic.hidden_candidate h\n  WHERE (h.route,h.subject_id,h.candidate_id)=(s.route,s.subject_id,s.candidate_id) LIMIT 1) h ON true\n LEFT JOIN LATERAL (SELECT 1 FROM semantic.record_lifecycle l\n  WHERE (l.route,l.subject_id,l.candidate_id)=(s.route,s.subject_id,s.candidate_id)\n  AND l.state IN ('deleted','purging','purged') LIMIT 1) l ON true\n LEFT JOIN LATERAL (SELECT disclosed FROM semantic.statement_disclosure d\n  WHERE (d.route,d.subject_id,d.candidate_id)=(s.route,s.subject_id,s.candidate_id) LIMIT 1) d ON true\n LEFT JOIN LATERAL (SELECT 1 FROM semantic.retraction r\n  WHERE (r.route,r.subject_id,r.candidate_id)=(s.route,s.subject_id,s.candidate_id) LIMIT 1) r ON true\n LEFT JOIN LATERAL (SELECT origin FROM semantic.candidate c WHERE s.property=ANY($4::text[])\n  AND (c.route,c.subject_id,c.slot_id,c.candidate_id)=(s.route,s.subject_id,s.slot_id,s.candidate_id) LIMIT 1) c ON true\n LEFT JOIN LATERAL (SELECT verdict FROM semantic.acceptance_current a WHERE s.property=ANY($4::text[])\n  AND (a.route,a.subject_id,a.context_id,a.candidate_id)=(s.route,s.subject_id,'00000000-0000-8000-8000-000000000000'::uuid,s.candidate_id)\n  LIMIT 1) a ON true\n)\nSELECT route,subject_id::text,slot_id::text,candidate_id::text,property,rank,ordinal,release,revision,relation,compact,ordinal_in_window,\n concealed,eligible,\n CASE WHEN ((NOT relation AND NOT concealed) OR eligible) AND octet_length(body::text)<=65536\n  THEN body END AS body,\n CASE WHEN eligible AND octet_length(source::text)<=4096 THEN source END AS source,\n (eligible AND COALESCE(octet_length(source::text),0)>4096) AS oversized_source\nFROM evidence\nUNION ALL\nSELECT route,subject_id::text,slot_id::text,candidate_id::text,property,rank,ordinal,release,revision,relation,compact,ordinal_in_window,\n true,false,NULL::jsonb,NULL::jsonb,false\nFROM selected WHERE ordinal_in_window>$3\nORDER BY ordinal_in_window";
export type CanonicalStatementInput = Readonly<{
    keys: number;
    digest: string;
    release: string;
}>;
export declare function readCanonicalStatementCount(tx: CommandTransaction, subject: string): Promise<number | null>;
/** Complete admitted descriptive values and ordinary relation samples. Native releases, visibility, provenance and fences
 * all come from the same released physical-Pool snapshot as the root Subject. */
export declare function readCanonicalIndexStatements(tx: CommandTransaction, pool: Pool, subject: WorkHeader, routeKey: Uint8Array, keys: number, release: Release, runtime: {
    digest: string;
    head: number;
    release: Release;
}): Promise<{
    statements: IndexedStatement[];
    credit: Readonly<{
        state: 'complete';
        names: readonly import("../search/credit-search.ts").CreditSearchWitness[];
    }> | undefined;
    proof: {
        keys: number;
        digest: string;
        release: string;
    };
} | null>;
