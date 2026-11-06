import type { TextNode } from '@rezics/search-text';
export { TEXT_LIMITS, TextSyntaxError, parseText, positiveText, textSyntaxProblem } from '@rezics/search-text';
export type { TextNode } from '@rezics/search-text';
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
