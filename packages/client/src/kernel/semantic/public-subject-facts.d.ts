/** Public visible-subject type and label reads for Access identity presentation. */
import type { Pool, PoolClient } from 'pg';
type Queryable = Pick<Pool | PoolClient, 'query'>;
export type ItemTypeDetails = {
    type: string;
    agentAccountId: string | null;
    agentVerified: boolean;
};
/** Unlocalized projection keys use the shared label rule without reader or original-language preferences. */
export declare function subjectLabel(labels: Record<string, string>, language?: string): string;
/** Item targets of one write, one primary-key probe per id and one statement per partition. */
export declare function readItemDetails(client: Queryable, ids: readonly string[]): Promise<Map<string, ItemTypeDetails>>;
export declare function readItemTypes(client: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
export type SubjectPageState = {
    id: string;
    visibility: string;
    securityRevision: string;
    redirect: string | null;
    revision: number;
};
/** Current native identity and revision fences for one display-home batch. */
export declare function readSubjectPageStates(client: Queryable, home: number, ids: readonly string[]): Promise<SubjectPageState[]>;
export declare function readLabels(pool: Queryable, ids: readonly string[]): Promise<Map<string, Record<string, string>>>;
export declare function readPublicSubject(client: Queryable, subjectId: string): Promise<{
    id: string;
    label: string;
    type: string;
} | null>;
export {};
