import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const projectionDeclaration = {
  id: 'projection-v1',
  canonical: {
    projection: { types: ['rv:Projection'] },
    revision: { types: ['rv:ProjectionRevision'] },
  },
  binding: {
    required: ['projection', 'revision'],
    roles: ['projection', 'revision'],
    demandedBy: ['rv:Projection', 'rv:ProjectionRevision'],
  },
} as const satisfies TurtleDeclaration;

export const projectionProfile = parseTurtleProfile(
  projectionDeclaration.id,
  readFileSync(new URL('./projection-v1.ttl', import.meta.url), 'utf8'),
  projectionDeclaration,
);
