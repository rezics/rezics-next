import type { TurtleDeclaration } from '../compiler/shacl.ts';

/** V1 remains the default canonical route; an authored V2 selector admits its distinct meaning. */
export const authoredStatementDeclaration = {
  id: 'statement-v2',
  canonical: {
    statement: { types: ['rdf:Statement'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/statement-v2>' }] },
    revision: { types: ['rv:StatementRevision'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/statement-v2>' }] },
  },
} as const satisfies TurtleDeclaration;
