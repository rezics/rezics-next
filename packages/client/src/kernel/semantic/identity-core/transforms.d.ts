/** The store page and executable mapping consume the same immutable constant transform. */
export declare function identityEpochChangeTerminal(intent: IdentityEpochLibraryTransform, remainder: string | null, original: string, previous: string): string;
/** Only the constant fields consumed by pageChanges; unrelated immutable intent data stays native. */
export type IdentityEpochLibraryTransform = Readonly<{
    kind: 'merge';
    survivor: string;
}> | Readonly<{
    kind: 'unmerge';
    original: string;
}> | Readonly<{
    kind: 'repoint';
    original: string;
    terminal: string;
}>;
export type IdentityTransformSource = Readonly<{
    input_original: string;
    terminal: string;
    observed_count: string;
    remainder_terminal?: string | null;
}>;
export type IdentityRemainder = Readonly<{
    state: 'ready';
    terminal: string | null;
}> | Readonly<{
    state: 'unavailable';
}> | Readonly<{
    state: 'overflow';
}> | Readonly<{
    state: 'stale';
}>;
/** Captured immutable input values; native adapters retain error construction and admission. */
export declare function classifyIdentityRemainder(intent: IdentityEpochLibraryTransform, sources: readonly IdentityTransformSource[]): IdentityRemainder;
