export declare const TEXT_LIMITS: Readonly<{
    bytes: 512;
    depth: 4;
    leaves: 64;
    phraseTokens: 32;
}>;
export type TextNode = {
    kind: 'term' | 'phrase';
    value: string;
} | {
    kind: 'not';
    child: TextNode;
} | {
    kind: 'and' | 'or';
    children: TextNode[];
};
export declare class TextSyntaxError extends Error {
    readonly code: 'unsupported' | 'out_of_range';
    readonly offset: number;
    constructor(code: 'unsupported' | 'out_of_range', offset: number);
}
export declare function parseText(input: string): TextNode;
export declare function positiveText(node: TextNode): boolean;
export type TextLeaf = {
    name: string;
    kind: 'term' | 'phrase';
    value: string;
    negated: boolean;
};
export declare function compileText(node: TextNode, { field, prefix }: {
    field: string;
    prefix: string;
}): {
    query: Record<string, unknown>;
    leaves: TextLeaf[];
};
