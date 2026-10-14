import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const classificationContextV2Declaration = {
  id: 'classification-context-v2',
  canonical: {
    context: {
      types: ['rv:ClassificationContext'],
      when: [
        { path: 'rv:contextRole', value: 'rv:RealmClassification' },
        { path: 'rv:definitionProfile', value: '<https://rezics.com/definition/classification-context-v2>' },
      ],
    },
  },
  binding: {
    required: ['realm', 'context'],
    roles: ['global', 'realm', 'context'],
    demandedBy: [],
  },
} as const satisfies TurtleDeclaration;

export const classificationContextV2Profile = parseTurtleProfile(
  classificationContextV2Declaration.id,
  readFileSync(new URL('./classification-context-v2.ttl', import.meta.url), 'utf8'),
  classificationContextV2Declaration,
);
