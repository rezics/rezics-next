import type { ProfileDefinition } from '../compiler/ir.ts';

const slug = '^[a-z0-9]+(-[a-z0-9]+)*$';

export const valueExactProfile = {
  id: 'value-exact-v1',
  comments: [
    'Identified value nodes for exact quantities, temporal descriptions, directional text and external references.',
    'Numbers keep exact RDF lexicals (xsd:integer, xsd:decimal, owl:rational); JSON carries them only as strings.',
    'Original temporal lexicals survive engine normalization; derived UTC bounds are query aids only.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['owl', 'http://www.w3.org/2002/07/owl#'],
    ['schema', 'https://schema.org/'], ['time', 'http://www.w3.org/2006/time#'],
    ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/value-exact-v1/quantity-shape', properties: [
      { path: 'rdf:type', hasValue: 'schema:QuantitativeValue' },
      { path: 'schema:value', minCount: 1, maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
      { path: 'schema:unitCode', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:quantityKind', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:lexicalForm', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 2100 },
      { path: 'rv:decimalPlaces', maxCount: 1, datatype: 'xsd:integer', minInclusive: 1, maxInclusive: 1024 },
      { path: 'rv:uncertainty', maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
    ] },
    { iri: 'https://rezics.com/definition/value-exact-v1/temporal-shape', properties: [
      { path: 'rdf:type', hasValue: 'time:GeneralDateTimeDescription' },
      { path: 'rv:lexicalForm', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 64 },
      { path: 'time:unitType', minCount: 1, maxCount: 1, in: ['time:unitYear', 'time:unitMonth',
        'time:unitDay', 'time:unitHour', 'time:unitMinute', 'time:unitSecond'] },
      { path: 'time:hasTRS', minCount: 1, maxCount: 1,
        in: ['<http://www.opengis.net/def/uom/ISO-8601/0/Gregorian>'] },
      { path: 'rv:utcOffset', maxCount: 1, datatype: 'xsd:string',
        pattern: '^(Z|[+-](0[0-9]|1[0-3]):[0-5][0-9]|[+-]14:00)$' },
      { path: 'rv:timeZoneName', maxCount: 1, datatype: 'xsd:string', maxLength: 64 },
      { path: 'rv:earliest', maxCount: 1, datatype: 'xsd:dateTime' },
      { path: 'rv:latest', maxCount: 1, datatype: 'xsd:dateTime' },
    ] },
    { iri: 'https://rezics.com/definition/value-exact-v1/directional-text-shape', properties: [
      { path: 'rdf:value', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 8000 },
      { path: 'rdf:language', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$' },
      { path: 'rdf:direction', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ['"ltr"', '"rtl"'] },
    ] },
    { iri: 'https://rezics.com/definition/value-exact-v1/external-reference-shape', properties: [
      { path: 'rdf:type', hasValue: 'rv:ExternalReference' },
      { path: 'rv:externalProvider', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: slug },
      { path: 'rv:externalNamespace', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: slug },
      { path: 'rv:externalKey', minCount: 1, maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 512 },
      { path: 'owl:sameAs', maxCount: 0 },
    ] },
  ],
} as const satisfies ProfileDefinition;
