import { expect, test } from 'bun:test';
import { coordinateOf, dimensionOf, dimensionOfTypes, frameWork, FrameRefused, normalizeFrame, slotOf,
  type Coordinate } from '../src/modules/projection/dimension.ts';
import type { Base } from '../src/modules/target/contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rv = (name: string) => `https://rezics.com/vocab/${name}`;
const railgun = id(1), episode3 = id(2), canon = id(3), legends = id(4), battle = id(6);
const otherWork = id(7), release = id(10), realization = id(11);
const at = (dimension: Coordinate['dimension'], iri: string, work: string | null = null): Coordinate =>
  ({ iri, dimension, work });
const refusal = (frame: Coordinate[]) => { try { normalizeFrame(frame); } catch (error) { return error instanceof FrameRefused ? error.reason : error; } };

test('structural grains map to their own dimension, whatever descriptive types they also carry', () => {
  const dimension = (base: Base, types: string[] = []) => dimensionOf({ base, types });
  expect(dimension('work', ['https://schema.org/CreativeWork', 'https://schema.org/Event'])).toBe('work');
  expect(dimension('realization')).toBe('realization');
  expect(dimension('release', [rv('Release')])).toBe('release');
  expect(dimension('occurrence', ['https://schema.org/ListItem'])).toBe('position');
});

test('a descriptive Resource is a frame only through a registered type that declares a dimension', () => {
  const dimension = (...types: string[]) => dimensionOf({ base: 'resource', types });
  expect(dimension('https://schema.org/Event')).toBe('event');
  expect(dimension(rv('NarrativeContinuity'))).toBe('continuity');
  expect(dimension(rv('Character'), rv('NarrativeContinuity'), 'http://www.w3.org/2000/01/rdf-schema#Resource')).toBe('continuity');
  // No dimension: units and held titles are Resources but never coordinates; neither are Realms or Agents.
  for (const type of [rv('GameUnit'), rv('Title'), rv('Character'), rv('Realm'), rv('Zone'), rv('Agent'),
    'http://www.w3.org/2004/02/skos/core#Concept', 'https://schema.org/Place', 'https://example.test/Unknown'])
    expect(dimension(type), type).toBeNull();
  expect(dimension()).toBeNull();
  // A Resource that is both an Event and a continuity belongs to no single dimension.
  expect(dimension('https://schema.org/Event', rv('NarrativeContinuity'))).toBeNull();
  // A Projection is never a frame: there are no projections of projections.
  expect(dimensionOf({ base: 'projection', types: [rv('Projection')] })).toBeNull();
});

test('a target becomes a typed coordinate carrying the Work that owns a position', () => {
  expect(coordinateOf({ resource: episode3, base: 'occurrence', types: [], work: railgun }))
    .toEqual({ iri: episode3, dimension: 'position', work: railgun });
  expect(coordinateOf({ resource: canon, base: 'resource', types: [rv('NarrativeContinuity')], work: null }))
    .toEqual({ iri: canon, dimension: 'continuity', work: null });
  expect(coordinateOf({ resource: id(9), base: 'resource', types: [rv('GameUnit')], work: null })).toBeNull();
});

test('a Work or position is one slot and a release or realization another; the four kinds stay distinct', () => {
  expect(['work', 'position', 'release', 'realization', 'continuity', 'event'].map(dimension => slotOf(dimension as Coordinate['dimension'])))
    .toEqual(['structure', 'structure', 'edition', 'edition', 'continuity', 'event']);
});

test('a frame keeps one coordinate per slot and drops a Work that a position, release or realization implies', () => {
  const work = at('work', railgun, railgun), position = at('position', episode3, railgun);
  expect(normalizeFrame([work, position])).toEqual([position]);
  expect(normalizeFrame([position, work])).toEqual([position]);
  expect(normalizeFrame([work, at('release', release, railgun)])).toEqual([at('release', release, railgun)]);
  expect(normalizeFrame([work, at('realization', realization, railgun), at('continuity', canon)]))
    .toEqual([at('realization', realization, railgun), at('continuity', canon)]);
  // A position and a release of the same Work are different slots: both stay.
  expect(normalizeFrame([position, at('release', release, railgun)])).toEqual([position, at('release', release, railgun)]);
  // Nothing implies a Work frame, a continuity or an event: they stay as given.
  expect(normalizeFrame([work])).toEqual([work]);
  expect(normalizeFrame([work, at('continuity', canon), at('event', battle)])).toHaveLength(3);
  expect(frameWork([position, at('continuity', canon)])).toBe(railgun);
  expect(frameWork([at('continuity', canon)])).toBeNull();
});

test('coordinates that disagree about their Work, or fill one slot twice, are refused', () => {
  const work = at('work', railgun, railgun);
  expect(refusal([work, at('position', episode3, otherWork)])).toBe('work-mismatch');
  expect(refusal([work, at('release', release, otherWork)])).toBe('work-mismatch');
  expect(refusal([at('position', episode3, railgun), at('release', release, otherWork)])).toBe('work-mismatch');
  expect(refusal([at('release', release, railgun), at('realization', realization, otherWork)])).toBe('slot-repeated');
  expect(refusal([work, at('work', otherWork, otherWork)])).toBe('slot-repeated');
  expect(refusal([at('position', episode3, railgun), at('position', id(8), railgun)])).toBe('slot-repeated');
  expect(refusal([at('release', release, railgun), at('realization', realization, railgun)])).toBe('slot-repeated');
  expect(refusal([at('continuity', canon), at('continuity', legends)])).toBe('slot-repeated');
  expect(refusal([at('event', battle), at('event', id(9))])).toBe('slot-repeated');
});

test('a Resource known only by its types has a dimension when structural owner types or the registry give one', () => {
  expect(dimensionOfTypes(['https://schema.org/CreativeWork', 'https://schema.org/Event'])).toBe('work');
  expect(dimensionOfTypes([rv('FixedRelease')])).toBe('release');
  expect(dimensionOfTypes(['https://schema.org/ListItem'])).toBe('position');
  expect(dimensionOfTypes([rv('TextContribution')])).toBe('realization');
  expect(dimensionOfTypes([rv('NarrativeContinuity'), rv('Character')])).toBe('continuity');
  expect(dimensionOfTypes(['https://schema.org/Event'])).toBe('event');
  // Two structural owners, a Projection and a type without a dimension are not coordinates.
  expect(dimensionOfTypes(['https://schema.org/CreativeWork', 'https://schema.org/ListItem'])).toBeNull();
  expect(dimensionOfTypes([rv('Projection')])).toBeNull();
  expect(dimensionOfTypes([rv('Realm')])).toBeNull();
  expect(dimensionOfTypes([])).toBeNull();
});
