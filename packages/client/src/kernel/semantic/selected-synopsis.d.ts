import type { Item, Statement } from './item.ts';
export type SelectedSynopsisInput = {
    statement: string;
    document: string;
    digest: string;
    language: string;
    context: string;
    release: string;
    realm?: string;
    pageRelease?: string;
};
export type SelectedSynopsisResult = {
    kind: 'matched';
    fact: Omit<Statement, 'rezics'>;
    context: string;
    release: string;
} | {
    kind: 'changed';
} | {
    kind: 'missing';
} | {
    kind: 'unsupported';
} | {
    kind: 'unavailable';
};
/** HTTP transport only. The original comparison operands never enter the result. */
export declare function parseSelectedSynopsis(value: string): SelectedSynopsisInput | undefined;
export declare function selectedSynopsisFact(subject: Item, input: SelectedSynopsisInput): Statement | undefined;
/** Redact every locator, including locator-valued qualifier and reference parts. */
export declare function redactSynopsisFact(fact: Statement): Omit<Statement, 'rezics'>;
