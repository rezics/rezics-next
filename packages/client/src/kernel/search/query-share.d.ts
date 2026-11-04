export type QueryShare = {
    viewer: 'anonymous' | 'signed-in';
    action: 'allowed' | 'disabled' | 'unavailable';
    reason: 'ready' | 'private_context' | 'unsupported' | 'oversized' | 'unavailable';
    document: { text: string; filter: string | null; languages: string[]; sort: string | null } | null;
    parameters: string | null;
    selections: { value: string; language: string }[];
};
