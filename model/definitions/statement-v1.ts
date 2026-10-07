import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** Current statements and their immutable revision anchors keep their canonical routes. */
export const statementDeclaration = {
  id: 'statement-v1',
  canonical: {
    statement: { types: ['rdf:Statement'] },
    revision: { types: ['rv:StatementRevision'] },
  },
} as const satisfies TurtleDeclaration;
