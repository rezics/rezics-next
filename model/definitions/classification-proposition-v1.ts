import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationPropositionDeclaration = {
  id: 'classification-proposition-v1',
  canonical: {
    sense: { types: ['rv:ClassificationSense'] },
    scheme: { types: ['skos:ConceptScheme'] },
    concept: { types: ['skos:Concept'] },
    path: { types: ['rv:ConceptPath'] },
    expression: { types: ['rv:ClassificationExpression'] },
  },
  binding: {
    required: ['scheme', 'concept', 'path', 'expression', 'sense'],
    roles: ['scheme', 'concept', 'path', 'expression', 'sense'],
    demandedBy: [
      'rv:ClassificationSense', 'rv:ConceptPath', 'rv:ClassificationExpression',
      'skos:Concept', 'skos:ConceptScheme',
    ],
  },
} as const satisfies TurtleDeclaration;

export const classificationPropositionProfile = parseTurtleProfile(
  'classification-proposition-v1',
  readFileSync(new URL('./classification-proposition-v1.ttl', import.meta.url), 'utf8'),
  classificationPropositionDeclaration,
);
