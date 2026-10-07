import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const valueExactDeclaration = {
  id: 'value-exact-v1',
  canonical: {
    quantity: { types: ['schema:QuantitativeValue'] },
    temporal: { types: ['time:GeneralDateTimeDescription'] },
    'directional-text': { types: ['rdf:CompoundLiteral'] },
    'external-reference': { types: ['rv:ExternalReference'] },
  },
} as const satisfies TurtleDeclaration;

export const valueExactProfile = parseTurtleProfile(
  valueExactDeclaration.id,
  readFileSync(new URL('./value-exact-v1.ttl', import.meta.url), 'utf8'),
  valueExactDeclaration,
);
