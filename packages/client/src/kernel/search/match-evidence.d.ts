import type { IndexedSubject } from './source.ts';
import type { TextLeaf } from './text.ts';
export type MatchEvidenceField = 'title' | 'alias' | 'description';
export type MatchEvidenceReason = {
    field: MatchEvidenceField;
    language: string;
    text: string;
    spans: {
        start: number;
        end: number;
    }[];
};
export type MatchEvidence = {
    state: 'absent';
} | {
    state: 'unsupported';
} | {
    state: 'unavailable';
} | {
    state: 'current';
    source: {
        id: string;
        revision: number;
    };
    query: string;
    reasons: MatchEvidenceReason[];
};
export declare const MATCH_EVIDENCE_LIMITS: Readonly<{
    reasons: 3;
    spans: 8;
    textBytes: 256;
    fragmentBytes: 1024;
    enginePageBytes: 262144;
    pageBytes: 131072;
}>;
export type MatchEvidenceQuery = Readonly<{
    query: Record<string, unknown>;
    highlight: Record<string, unknown>;
    queryBinding: string;
    names: Readonly<Record<'names' | 'descriptions', readonly string[]>>;
}>;
type CompiledText = {
    query: Record<string, unknown>;
    leaves: readonly TextLeaf[];
};
/** Add zero-score named field probes while retaining the installed text query as the sole required clause. */
export declare function compileMatchEvidence(compiled: CompiledText): MatchEvidenceQuery;
export type EngineMatchEvidence = Readonly<{
    matched: readonly string[];
    highlight?: unknown;
    malformed?: boolean;
}>;
export declare function readEngineMatchEvidence(matched: unknown, highlight: unknown, plan: MatchEvidenceQuery): EngineMatchEvidence;
/** Project only engine-highlighted excerpts that map to one current public source value and language. */
export declare function projectMatchEvidence(subject: IndexedSubject, candidate: EngineMatchEvidence | undefined, plan: MatchEvidenceQuery | undefined): MatchEvidence;
export declare function boundMatchEvidencePage<T extends {
    matchEvidence: MatchEvidence;
}>(hits: readonly T[]): T[];
export {};
