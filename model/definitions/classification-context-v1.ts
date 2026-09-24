import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term, breaks: number[] = []) => ({
  path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true,
  ...(breaks.length ? { lineBreaks: breaks.map(after => ({ after, indent: 18 })) } : {}),
});

export const classificationContextProfile = {
  id: 'classification-context-v1',
  comments: ['Role-specific Realm classification context with one fixed Global dependency.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/classification-context-v1/global-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationContext' },
        fixed('rv:contextRole', 'rv:GlobalClassification'),
        fixed('rv:contextState', 'rv:Active'),
        fixed('rv:inheritancePolicy', '<https://rezics.com/definition/classification-isolate-v1>', [1, 2]),
        { path: 'rv:fallbackContext', maxCount: 0 },
        { path: 'rv:realm', maxCount: 0 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-context-v1/realm-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Realm' },
        fixed('rv:realmState', 'rv:Active'),
        { path: 'rv:classificationContext', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI',
          lineBreaks: [{ after: 2, indent: 18 }] },
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-context-v1/context-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationContext' },
        fixed('rv:contextRole', 'rv:RealmClassification'),
        fixed('rv:contextState', 'rv:Active'),
        { path: 'rv:realm', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        fixed('rv:inheritancePolicy', '<https://rezics.com/definition/classification-inherit-global-v1>', [1, 2]),
        fixed('rv:fallbackContext', '<urn:rezics:classification-context:global>', [1]),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
