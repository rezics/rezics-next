import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const one = (path: Term, facets: Omit<PropertyDefinition, 'path'>): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...facets });
const link = (path: Term, target: Term) => one(path, { class: target });
const count = (path: Term, minInclusive: number, maxInclusive: number) =>
  one(path, { datatype: 'xsd:integer', minInclusive, maxInclusive });
const operation = one('rv:operation', { nodeKind: 'sh:IRI', pattern: '^urn:rezics:operation:[0-9a-f]{64}$' });

export const pollAllocationProfile = {
  id: 'poll-allocation-v1',
  comments: [
    'Immutable allocation plans split one root entitlement into explicit leaf seats.',
    'Allocated plus residual units equal the root units; the residual leaf stays with the',
    'root holder. One activation per poll and root, only while the poll is a draft, so a',
    'root and its leaves never both count. Leaves keep the root source entitlement.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/poll-allocation-v1/plan-shape',
      canonical: { types: ['rv:AllocationPlan'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:AllocationPlan' },
        link('rv:poll', 'rv:Poll'),
        link('rv:rootEntitlement', 'rv:SourceEntitlement'),
        count('rv:leafCount', 1, 1024),
        count('rv:allocatedUnits', 0, 1000000),
        count('rv:residualUnits', 0, 1000000),
        one('rv:planDigest', { datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' }),
        operation,
        one('rv:preparedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-allocation-v1/leaf-shape',
      canonical: { types: ['rv:AllocationLeaf'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:AllocationLeaf' },
        { path: 'rdf:type', hasValue: 'rv:VotingSeat' },
        link('rv:allocationPlan', 'rv:AllocationPlan'),
        link('rv:sourceEntitlement', 'rv:SourceEntitlement'),
        one('rv:holder', { nodeKind: 'sh:IRI' }),
        one('rv:seatClass', { in: ['rv:PersonSeat', 'rv:OrganizationSeat', 'rv:CollectiveMemberSeat'] }),
        one('rv:leafKind', { in: ['rv:AllocatedLeaf', 'rv:ResidualLeaf'] }),
        one('rv:countingSlot', { nodeKind: 'sh:IRI' }),
        count('rv:leafUnits', 1, 1000000),
      ],
    },
    {
      iri: 'https://rezics.com/definition/poll-allocation-v1/activation-shape',
      canonical: { types: ['rv:AllocationActivation'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:AllocationActivation' },
        link('rv:poll', 'rv:Poll'),
        link('rv:allocationPlan', 'rv:AllocationPlan'),
        link('rv:rootEntitlement', 'rv:SourceEntitlement'),
        operation,
        one('rv:activatedAt', { datatype: 'xsd:dateTime' }),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
