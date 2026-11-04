import { TextSyntaxError } from '../../../../packages/search-text/src/index.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { TextNode } from '../../../../packages/search-text/src/index.ts';
export { TEXT_LIMITS, TextSyntaxError, parseText, positiveText } from '../../../../packages/search-text/src/index.ts';
export type { TextNode } from '../../../../packages/search-text/src/index.ts';

type TextQuery =
  | { match: Record<string, { query: string; operator: 'and'; _name: string }> }
  | { match_phrase: Record<string, { query: string; _name: string }> }
  | { bool: { must?: TextQuery[]; must_not?: TextQuery[]; should?: TextQuery[]; minimum_should_match?: 1 } };

export type TextLeaf = { name: string; kind: 'term' | 'phrase'; value: string; negated: boolean };

export function compileText(
  node: TextNode,
  { field, prefix }: { field: string; prefix: string },
): { query: Record<string, unknown>; leaves: TextLeaf[] } {
  const leaves: TextLeaf[] = [];
  function compile(current: TextNode, negated: boolean): TextQuery {
    switch (current.kind) {
      case 'term':
      case 'phrase': {
        const name = `${prefix}${leaves.length}`;
        const { kind, value } = current;
        leaves.push({ name, kind, value, negated });
        return kind === 'term'
          ? { match: { [field]: { query: value, operator: 'and', _name: name } } }
          : { match_phrase: { [field]: { query: value, _name: name } } };
      }
      case 'not':
        return { bool: { must_not: [compile(current.child, !negated)] } };
      case 'and': {
        const must: TextQuery[] = [];
        const must_not: TextQuery[] = [];
        for (const child of current.children) {
          if (child.kind === 'not') must_not.push(compile(child.child, !negated));
          else must.push(compile(child, negated));
        }
        return { bool: { ...(must.length ? { must } : {}), ...(must_not.length ? { must_not } : {}) } };
      }
      case 'or':
        return { bool: { should: current.children.map((child) => compile(child, negated)), minimum_should_match: 1 } };
    }
  }
  return { query: compile(node, false), leaves };
}

/** Public syntax advice contains only a closed parser diagnostic, never request contents. */
export function rejectTextSyntax(error: TextSyntaxError): never {
  throw new ProblemError('unsupported_query', {
    errors: [{ pointer: '/text', code: error.code }],
    extensions: { textDiagnostic: error.diagnostic },
  });
}
