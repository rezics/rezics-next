import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const one = (path: `rv:${string}`, extra: Partial<PropertyDefinition> = {}): PropertyDefinition =>
  ({ path, minCount: 1, maxCount: 1, ...extra, lineBreaks: [{ after: 3, indent: 8 }] });
const components = [
  ['rv:yearValue', undefined, undefined],
  ['rv:monthValue', 1, 12],
  ['rv:dayValue', 1, 31],
  ['rv:hourValue', 0, 23],
  ['rv:minuteValue', 0, 59],
  ['rv:secondValue', 0, 60],
] as const;
const component = ([path, min, max]: (typeof components)[number], required: boolean,
  indent: number): PropertyDefinition => ({
  path, ...(required ? { minCount: 1 } : {}), maxCount: 1, datatype: 'xsd:integer',
  ...(min === undefined ? {} : { minInclusive: min, maxInclusive: max }),
  lineBreaks: [{ after: required ? 3 : 2, indent }],
});
// Exact civil components; count is how many leading components the precision fixes.
const point = (state: `rv:${string}`, precision: `rv:${string}` | null, count: number): PropertyDefinition[] => [
  { path: 'rv:pointState', hasValue: state },
  precision ? { path: 'rv:timePrecision', hasValue: precision } : { path: 'rv:timePrecision', maxCount: 0 },
  ...components.map((entry, index) => index < count ? component(entry, true, 12) : { path: entry[0], maxCount: 0 }),
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
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/event-time-v1/event-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Event' },
        { path: 'rv:eventTime', maxCount: 2, class: 'rv:EventTime' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/event-time-v1/slot-shape',
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
        one('rv:timeCalendar', { nodeKind: 'sh:IRI' }),
        one('rv:sourceLexical', { datatype: 'xsd:string', minLength: 1, maxLength: 200 }),
        { path: 'rv:timePrecision', maxCount: 1,
          in: ['rv:YearPrecision', 'rv:MonthPrecision', 'rv:DayPrecision', 'rv:MinutePrecision', 'rv:SecondPrecision'],
          lineBreaks: [{ after: 2, indent: 8 }] },
        { path: 'rv:timeReference', maxCount: 1,
          in: ['rv:FloatingCivilTime', 'rv:OffsetTime', 'rv:ZonedTime'], lineBreaks: [{ after: 2, indent: 8 }] },
        { path: 'rv:timeZone', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 64,
          lineBreaks: [{ after: 3, indent: 8 }] },
        { path: 'rv:utcOffset', maxCount: 1, datatype: 'xsd:string', pattern: '^[+-](0[0-9]|1[0-4]):[0-5][0-9]$',
          lineBreaks: [{ after: 3, indent: 8 }] },
        { path: 'rv:timeQualifier', maxCount: 1, in: ['rv:ApproximateTime', 'rv:UncertainTime'],
          lineBreaks: [{ after: 2, indent: 8 }] },
        ...components.map(entry => component(entry, false, 8)),
      ],
      or: [
        point('rv:UnknownPoint', null, 0),
        point('rv:OpenPoint', null, 0),
        point('rv:KnownPoint', 'rv:YearPrecision', 1),
        point('rv:KnownPoint', 'rv:MonthPrecision', 2),
        point('rv:KnownPoint', 'rv:DayPrecision', 3),
        point('rv:KnownPoint', 'rv:MinutePrecision', 5),
        point('rv:KnownPoint', 'rv:SecondPrecision', 6),
        [
          // A calendar without admitted civil components keeps only its lexical.
          { path: 'rv:pointState', hasValue: 'rv:KnownPoint' },
          { path: 'rv:timePrecision', minCount: 1, maxCount: 1,
            in: ['rv:YearPrecision', 'rv:MonthPrecision', 'rv:DayPrecision', 'rv:MinutePrecision', 'rv:SecondPrecision'],
            lineBreaks: [{ after: 3, indent: 12 }] },
          ...components.map(([path]) => ({ path, maxCount: 0 })),
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
