import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term) => ({ path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true });
const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });
const requiredClass = (path: `rv:${string}`, term: Term) => ({ path, minCount: 1, maxCount: 1,
  class: term, lineBreaks: [{ after: 3, indent: 18 }] });

export const classificationDirectDecisionProfile = {
  id: 'classification-direct-decision-v1',
  comments: [
    'First curated classification decision for a public MainVersion.',
    'Application and Decision have distinct identities; the latter is the head',
    'selected by the former. This profile does not model community judgment.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/classification-direct-decision-v1/work-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
        requiredIri('rv:mainVersion'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-direct-decision-v1/main-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MainVersion' },
        requiredIri('rv:work'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-direct-decision-v1/sense-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationSense' },
        fixed('rv:senseState', 'rv:Active'),
        { ...fixed('rv:interpretationScope', '<urn:rezics:classification-context:global>'),
          lineBreaks: [{ after: 1, indent: 18 }] },
        requiredIri('rv:head'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-direct-decision-v1/context-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationContext' },
        fixed('rv:contextState', 'rv:Active'),
        requiredIri('rv:inheritancePolicy'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-direct-decision-v1/application-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationApplication' },
        requiredClass('rv:targetMainVersion', 'rv:MainVersion'),
        requiredClass('rv:sense', 'rv:ClassificationSense'),
        requiredClass('rv:classificationContext', 'rv:ClassificationContext'),
        fixed('rv:applicationChannel', 'rv:Curated'),
        fixed('rv:applicationState', 'rv:Active'),
        requiredIri('rv:proposer'),
        requiredIri('rv:decisionHead'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-direct-decision-v1/decision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationDecision' },
        requiredClass('rv:application', 'rv:ClassificationApplication'),
        { path: 'rv:outcome', minCount: 1, maxCount: 1, in: ['rv:Accepted', 'rv:Rejected'],
          lineBreaks: [{ after: 3, indent: 18 }] },
        { path: 'rv:decisionBasis', minCount: 1, maxCount: 1,
          in: ['rv:GlobalCuratorReview', 'rv:RealmManagerReview'],
          lineBreaks: [{ after: 3, indent: 18 }] },
        requiredIri('rv:decidedBy'),
        { ...fixed('rv:decisionPolicy', '<https://rezics.com/definition/classification-direct-decision-v1>'),
          lineBreaks: [{ after: 1, indent: 18 }, { after: 2, indent: 18 }] },
        { path: 'rv:contextRevision', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:predecessor', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
