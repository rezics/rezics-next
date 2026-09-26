import type { ProfileDefinition } from '../compiler/ir.ts';

/** A field slot owns its content and control heads independently of the Work title. */
export const workEditorialFieldProfile = {
  id: 'work-editorial-field-v1', layout: 'compact',
  comments: ['A stable Work field slot has one native value and two independent immutable heads.',
    'The control epoch records edit authority; it never grants rights to source expression.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: 'https://rezics.com/definition/work-editorial-field-v1/slot-shape',
      canonical: { types: ['rv:EditorialFieldSlot'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:EditorialFieldSlot' },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:fieldDefinition', hasValue: '<https://rezics.com/definition/work-synopsis-v1>', maxCount: 1 },
      { path: 'rv:fieldValue', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 8000 },
      { path: 'rv:fieldHead', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:fieldControlHead', minCount: 1, maxCount: 1, class: 'rv:EditorialFieldControlRevision' },
      { path: 'rv:protectionHead', maxCount: 1, class: 'rv:ProtectionRevision' },
    ] },
    { iri: 'https://rezics.com/definition/work-editorial-field-v1/value-shape', properties: [
      { path: 'rdf:type', in: ['rv:EditorialFieldRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:EditorialFieldSlot' },
      { path: 'rv:fieldValue', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 8000 },
      { path: 'rv:rightsStatus', hasValue: 'rv:Undetermined', maxCount: 1 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:EditorialFieldRevision' },
      { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/work-editorial-field-v1>', maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/work-editorial-field-v1>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
    { iri: 'https://rezics.com/definition/work-editorial-field-v1/control-shape', properties: [
      { path: 'rdf:type', in: ['rv:EditorialFieldControlRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:EditorialFieldSlot' },
      { path: 'rv:controlField', hasValue: '"synopsis"', maxCount: 1 },
      { path: 'rv:controlMode', in: ['rv:SourceManaged', 'rv:HumanControlled'], minCount: 1, maxCount: 1 },
      { path: 'rv:controlEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:fieldRevision', minCount: 1, maxCount: 1, class: 'rv:EditorialFieldRevision' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:EditorialFieldControlRevision' },
      { path: 'rv:controlIntent', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 10000 },
      { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/work-editorial-field-v1>', maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/work-editorial-field-v1>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
