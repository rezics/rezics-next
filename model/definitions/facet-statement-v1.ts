import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * Values an occurrence's co-participant is stated to have under one exact relation DefinitionRef,
 * such as a character's gender, accepted in the Query's Context. A named Facet that fixes the
 * predicate, as `concept` does, replaces these Conditions once it is admitted.
 */
export const statementFacet = {
  name: 'statement',
  version: 1,
  labels: { en: 'Statement', 'zh-Hant': '陳述', 'zh-Hans': '陈述', ja: '記述', ko: '진술', de: 'Aussage',
    fr: 'Énoncé', es: 'Afirmación' },
  appliesTo: 'participant',
  subject: 'rdfs:Resource',
  path: [{ kind: 'statement' }],
  parameters: [{ key: 'predicate', value: { kind: 'class', class: 'rdf:Property' } },
    { key: 'relationDefinition', value: { kind: 'definition' } }],
  values: [{ kind: 'class', class: 'rdfs:Resource' }],
  operators: ['any', 'all', 'none'],
  source: 'context',
  qualifiers: ['interpretation', 'applicability'],
  // Interpretation resolution and one acceptance batch.
  cost: { maxValues: 8, graphReads: 2 },
} as const satisfies FacetDefinition;
