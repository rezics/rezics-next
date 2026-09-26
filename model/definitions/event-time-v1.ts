import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const one = (path: `rv:${string}`, extra: Partial<PropertyDefinition> = {}): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...extra, lineBreaks: [{ after: 3, indent: 8 }] });
const point = (state: `rv:${string}`, hasTemporalValue: boolean): PropertyDefinition[] => [
  { path: 'rv:pointState', hasValue: state },
  hasTemporalValue
    ? { path: 'rv:temporalValue', minCount: 1, maxCount: 1, class: 'time:GeneralDateTimeDescription' }
    : { path: 'rv:temporalValue', maxCount: 0 },
  hasTemporalValue
    ? { path: 'rv:unknownLexical', maxCount: 0 }
    : { path: 'rv:unknownLexical', minCount: 1, maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 200 },
];

export const eventTimeProfile = {
  id: 'event-time-v1',
  comments: [
    'One identified Event occurrence with separate actual and planned time slots.',
    'Each revision keeps precision, calendar, reference, qualifier and source lexical;',
    'normalized interval keys are derived outside the graph under a conversion profile.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['time', 'http://www.w3.org/2006/time#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/event-time-v1/event-shape',
      canonical: { types: ['rv:Event'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Event' },
        { path: 'rv:eventTime', maxCount: 2, class: 'rv:EventTime' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/event-time-v1/slot-shape',
      canonical: { types: ['rv:EventTime'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:EventTime' },
        one('rv:event', { class: 'rv:Event' }),
        one('rv:timeStatus', { in: ['rv:ActualTime', 'rv:PlannedTime'] }),
        one('rv:eventTimeHead', { class: 'rv:EventTimeRevision' }),
      ],
    },
    {
      iri: 'https://rezics.com/definition/event-time-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:EventTimeRevision' },
        one('rv:eventTime', { class: 'rv:EventTime' }),
        one('rv:timeAvailability', { in: ['rv:Available', 'rv:Withdrawn'] }),
        one('rv:recordedAt', { datatype: 'xsd:dateTime' }),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:EventTimeRevision',
          lineBreaks: [{ after: 2, indent: 8 }] },
        { path: 'rv:timeEvidence', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
      or: [
        [
          { path: 'rv:timeAvailability', hasValue: 'rv:Withdrawn' },
          { path: 'rv:temporalKind', maxCount: 0 },
          { path: 'rv:eventStart', maxCount: 0 },
          { path: 'rv:eventEnd', maxCount: 0 },
        ],
        [
          { path: 'rv:timeAvailability', hasValue: 'rv:Available' },
          { path: 'rv:temporalKind', hasValue: 'rv:InstantTime' },
          { path: 'rv:eventStart', minCount: 1, maxCount: 1, class: 'rv:EventTimePoint',
            lineBreaks: [{ after: 3, indent: 12 }] },
          { path: 'rv:eventEnd', maxCount: 0 },
        ],
        [
          { path: 'rv:timeAvailability', hasValue: 'rv:Available' },
          { path: 'rv:temporalKind', hasValue: 'rv:IntervalTime' },
          { path: 'rv:eventStart', minCount: 1, maxCount: 1, class: 'rv:EventTimePoint',
            lineBreaks: [{ after: 3, indent: 12 }] },
          { path: 'rv:eventEnd', minCount: 1, maxCount: 1, class: 'rv:EventTimePoint',
            lineBreaks: [{ after: 3, indent: 12 }] },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/event-time-v1/point-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:EventTimePoint' },
        one('rv:pointState', { in: ['rv:KnownPoint', 'rv:UnknownPoint', 'rv:OpenPoint'] }),
        { path: 'rv:temporalValue', maxCount: 1, class: 'time:GeneralDateTimeDescription' },
        { path: 'rv:unknownLexical', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 200 },
      ],
      or: [
        point('rv:KnownPoint', true),
        point('rv:UnknownPoint', false),
        point('rv:OpenPoint', false),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
