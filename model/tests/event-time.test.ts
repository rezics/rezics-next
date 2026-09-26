import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { eventTimeProfile } from '../definitions/event-time-v1.ts';
import { valueExactProfile } from '../definitions/value-exact-v1.ts';

const shape = (suffix: string) => eventTimeProfile.shapes.find(candidate => candidate.iri.endsWith(`/${suffix}-shape`));

test('RATE07/RATE08: Event time points reuse exact temporal values and keep event identity separate', () => {
  const point = shape('point');
  expect(eventTimeProfile.prefixes).toContainEqual(['time', 'http://www.w3.org/2006/time#']);
  expect(point?.properties.find(property => property.path === 'rv:temporalValue'))
    .toMatchObject({ class: 'time:GeneralDateTimeDescription', maxCount: 1 });
  expect(point?.properties.some(property => ['rv:yearValue', 'rv:monthValue', 'rv:dayValue',
    'rv:timePrecision', 'rv:calendar'].includes(property.path))).toBe(false);
  expect(valueExactProfile.shapes.some(candidate => candidate.iri.endsWith('/temporal-shape'))).toBe(true);
  expect(shape('event')?.properties.find(property => property.path === 'rv:eventTime'))
    .toMatchObject({ maxCount: 2, class: 'rv:EventTime' });
  const rendered = renderProfile(eventTimeProfile);
  expect(rendered).toContain('sh:in ( rv:ActualTime rv:PlannedTime )');
  expect(rendered).toContain('sh:path rv:temporalValue ; sh:minCount 1 ; sh:maxCount 1 ; sh:class time:GeneralDateTimeDescription');
  expect(rendered).not.toContain('rv:timePrecision');
  expect(rendered).not.toContain('rv:yearValue');
  const exact = renderProfile(valueExactProfile);
  expect(exact).toContain('<https://rezics.com/definition/value-exact-v1/temporal-shape>');
  expect(exact).toContain('sh:path rdf:type ; sh:hasValue time:GeneralDateTimeDescription');
});

test('RATE09: event revision records one available instant or a two-ended interval', () => {
  const revision = shape('revision');
  expect(revision?.or?.map(branch => branch.map(property => property.path))).toEqual([
    ['rv:timeAvailability', 'rv:temporalKind', 'rv:eventStart', 'rv:eventEnd'],
    ['rv:timeAvailability', 'rv:temporalKind', 'rv:eventStart', 'rv:eventEnd'],
    ['rv:timeAvailability', 'rv:temporalKind', 'rv:eventStart', 'rv:eventEnd'],
  ]);
});
