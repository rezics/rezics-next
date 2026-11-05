/** One subject's stored fact log, shared by creation and slot expansion. */
export declare const FACT_LIMIT = 512;
export type StoredFact = {
    slot_id: string;
    log_seq: number;
    operation: 'assert' | 'retract' | 'expand';
    kind: 'label' | 'description' | 'alias' | 'statement';
    language: string | null;
    property: string | null;
    statement_id: string | null;
    body: unknown;
    release: string | null;
    relation?: boolean;
};
export type FactWriter = {
    query(text: string, values?: readonly unknown[]): Promise<unknown>;
};
/** Refuses an unbounded fact log before any insert. Callers share this path. */
export declare function writeFacts(client: FactWriter, input: {
    route: number;
    subject_id: string;
    transaction_id: string;
    facts: readonly StoredFact[];
}): Promise<void>;
