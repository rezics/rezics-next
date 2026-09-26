import type { ProfileDefinition } from '../compiler/ir.ts';

export const semanticAnnotationProfile = {
  id: 'semantic-annotation-v1',
  comments: [
    'Standard identified name records (SKOS-XL Label) and evidence annotations (Web Annotation).',
    'A Label is linked by rv:nameRecord; selecting a preferred name is a separate decision.',
    'Statement and ListItem records belong to their Context and Structure owner profiles.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['skosxl', 'http://www.w3.org/2008/05/skos-xl#'], ['oa', 'http://www.w3.org/ns/oa#'],
    ['prov', 'http://www.w3.org/ns/prov#'], ['rv', 'https://rezics.com/vocab/'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/semantic-annotation-v1/label-shape', properties: [
      { path: 'rdf:type', hasValue: 'skosxl:Label' },
      { path: 'skosxl:literalForm', minCount: 1, maxCount: 1, datatype: 'rdf:langString', maxLength: 1000 },
      { path: 'rv:nameRole', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'prov:wasDerivedFrom', maxCount: 16, nodeKind: 'sh:IRI' },
    ] },
    { iri: 'https://rezics.com/definition/semantic-annotation-v1/annotation-shape', properties: [
      { path: 'rdf:type', hasValue: 'oa:Annotation' },
      { path: 'oa:hasTarget', minCount: 1, maxCount: 16, nodeKind: 'sh:IRI' },
      { path: 'oa:hasBody', maxCount: 16, nodeKind: 'sh:IRIOrLiteral' },
      { path: 'oa:motivatedBy', minCount: 1, maxCount: 1, in: ['oa:assessing', 'oa:classifying',
        'oa:commenting', 'oa:describing', 'oa:identifying', 'oa:linking', 'oa:questioning', 'oa:tagging'] },
    ] },
    { iri: 'https://rezics.com/definition/semantic-annotation-v1/specific-resource-shape', properties: [
      { path: 'rdf:type', hasValue: 'oa:SpecificResource' },
      { path: 'oa:hasSource', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'oa:hasSelector', minCount: 1, maxCount: 1, class: 'oa:TextQuoteSelector' },
    ] },
    { iri: 'https://rezics.com/definition/semantic-annotation-v1/text-quote-selector-shape', properties: [
      { path: 'rdf:type', hasValue: 'oa:TextQuoteSelector' },
      { path: 'oa:exact', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 4096 },
      { path: 'oa:prefix', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 32 },
      { path: 'oa:suffix', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 32 },
    ] },
  ],
} as const satisfies ProfileDefinition;
