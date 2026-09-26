import type { ProfileDefinition } from '../compiler/ir.ts';

export const eventTopicBindingProfile = {
  id: 'event-topic-binding-v1',
  comments: [
    'A named-event topic binds to one Event occurrence; the Event keeps the only date authority.',
    'The binding node is deterministic per topic, so distinct topics may share one Event.',
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
      iri: 'https://rezics.com/definition/event-topic-binding-v1/event-shape',
      properties: [{ path: 'rdf:type', hasValue: 'rv:Event' }],
    },
    {
      iri: 'https://rezics.com/definition/event-topic-binding-v1/binding-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:EventTopicBinding' },
        { path: 'rv:topic', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:bindingHead', minCount: 1, maxCount: 1, class: 'rv:EventTopicBindingRevision',
          lineBreaks: [{ after: 3, indent: 8 }] },
      ],
    },
    {
      iri: 'https://rezics.com/definition/event-topic-binding-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:EventTopicBindingRevision' },
        { path: 'rv:binding', minCount: 1, maxCount: 1, class: 'rv:EventTopicBinding',
          lineBreaks: [{ after: 3, indent: 8 }] },
        { path: 'rv:bindingState', minCount: 1, maxCount: 1, in: ['rv:AcceptedBinding', 'rv:WithdrawnBinding'],
          lineBreaks: [{ after: 3, indent: 8 }] },
        { path: 'rv:revisedAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:EventTopicBindingRevision',
          lineBreaks: [{ after: 2, indent: 8 }] },
      ],
      or: [
        [
          { path: 'rv:bindingState', hasValue: 'rv:AcceptedBinding' },
          { path: 'rv:boundEvent', minCount: 1, maxCount: 1, class: 'rv:Event' },
        ],
        [
          { path: 'rv:bindingState', hasValue: 'rv:WithdrawnBinding' },
          { path: 'rv:boundEvent', maxCount: 0 },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
