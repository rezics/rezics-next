import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationPropositionV2Declaration = {
  id: 'classification-proposition-v2',
  canonical: {
    scheme: {
      types: ['skos:ConceptScheme'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/classification-proposition-v2>',
      }],
    },
    concept: {
      types: ['skos:Concept'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/classification-proposition-v2>',
      }],
    },
    path: {
      types: ['rv:ConceptPath'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/classification-proposition-v2>',
      }],
    },
    expression: {
      types: ['rv:ClassificationExpression'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/classification-proposition-v2>',
      }],
    },
    sense: {
      types: ['rv:ClassificationSense'],
      when: [{
        path: 'rv:definitionProfile',
        value: '<https://rezics.com/definition/classification-proposition-v2>',
      }],
    },
  },
  binding: {
    required: ['scheme', 'concept', 'path', 'expression', 'sense'],
    roles: ['scheme', 'concept', 'path', 'expression', 'sense'],
    demandedBy: ['rv:VocabularyDefinition'],
  },
} as const satisfies TurtleDeclaration;

export const classificationPropositionV2Profile = parseTurtleProfile(
  classificationPropositionV2Declaration.id,
  readFileSync(new URL('./classification-proposition-v2.ttl', import.meta.url), 'utf8'),
  classificationPropositionV2Declaration,
);
