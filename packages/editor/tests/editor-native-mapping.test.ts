import { expect, test } from 'bun:test';
import { Mapping, StepMap, type Mappable } from '@tiptap/pm/transform';
import { NativeMappingIndex } from '../src/components/editor-native-mapping.ts';

function result(mapping: Mappable, position: number, assoc: number) {
  const value = mapping.mapResult(position, assoc);
  return [
    value.pos,
    value.deleted,
    value.deletedBefore,
    value.deletedAfter,
    value.deletedAcross,
    (value as unknown as { delInfo: number }).delInfo,
    (value as unknown as { recover: number | null }).recover,
  ];
}

function compare(mapping: Mapping, index = new NativeMappingIndex(), tag = '') {
  const indexed = index.mappable(mapping);
  for (let position = -4; position <= 64; position++)
    for (const assoc of [-1, 1]) {
      const expected = result(mapping, position, assoc),
        actual = result(indexed, position, assoc);
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        indexed.map(position, assoc) !== mapping.map(position, assoc)
      ) {
        throw new Error(
          JSON.stringify({
            tag,
            position,
            assoc,
            from: mapping.from,
            to: mapping.to,
            maps: mapping.maps,
            mirror: (mapping as unknown as { mirror?: number[] }).mirror,
            expected,
            actual,
          }),
        );
      }
    }
}

test('native indexed evaluation preserves adjacent/collapsed/inverted maps and mirror recovery flags', () => {
  const adjacent = new Mapping([new StepMap([2, 1, 2]), new StepMap([1, 1, 2])]);
  compare(adjacent);
  compare(adjacent.invert());
  const collapsed = new Mapping([new StepMap([1, 1, 0, 2, 1, 0]).invert(), new StepMap([1, 0, 2])]);
  compare(collapsed);
  const mirrored = new Mapping();
  const change = new StepMap([2, 8, 3]);
  mirrored.appendMap(change);
  mirrored.appendMap(new StepMap([0, 0, 2]));
  mirrored.appendMap(change.invert(), 0);
  compare(mirrored);
  compare(mirrored.slice(0, 2));
  compare(mirrored.slice(1, 3));
  compare(mirrored.invert());
  compare(new Mapping([change, StepMap.empty, change.invert()], [0, 2, 0, 1]));
  compare(new Mapping([change, change.invert(), change.invert()], [0, 1, 1, 2]));
  const shiftedInverse = new Mapping([new StepMap([0, 0, 10, 20, 0, 1]).invert()]);
  compare(shiftedInverse);
  expect(new NativeMappingIndex().mappable(shiftedInverse).map(25)).toBe(shiftedInverse.map(25));
  const endpoints = new NativeMappingIndex();
  const endpointMap = new Mapping([new StepMap([4, 2, 0])]);
  endpoints.mappable(endpointMap).mapResult(4);
  endpoints.mappable(endpointMap).mapResult(6);
  expect(endpoints.leafVisits).toBe(2);
});

test('append-only map/mirror caches and retained facades observe native append and copy-on-write updates', () => {
  const index = new NativeMappingIndex();
  const mapping = new Mapping();
  const retained = index.mappable(mapping);
  for (let sequence = 0; sequence < 60; sequence++) {
    const step = new StepMap([sequence % 20, sequence % 3, (sequence + 1) % 4]);
    mapping.appendMap(step);
    if (sequence % 3 === 0) mapping.appendMap(step.invert(), mapping.maps.length - 1);
    compare(mapping, index, `append${sequence}`);
    for (const assoc of [-1, 1]) expect(result(retained, 15, assoc)).toEqual(result(mapping, 15, assoc));
  }
  const copied = mapping.slice();
  const retainedCopy = index.mappable(copied);
  copied.appendMap(new StepMap([3, 2, 0]));
  expect(result(retainedCopy, 4, 1)).toEqual(result(copied, 4, 1));
  const owner = new Mapping();
  const change = new StepMap([2, 5, 1]);
  owner.appendMap(change);
  const older = owner.slice();
  const retainedOlder = index.mappable(older);
  owner.appendMap(change.invert(), 0);
  compare(owner, index);
  for (const assoc of [-1, 1]) expect(result(retainedOlder, 4, assoc)).toEqual(result(older, 4, assoc));
});

test('seeded differential mapping fuzz covers slices, inversions, multiple ranges and first mirror pairs', () => {
  let state = 0x9e3779b9;
  const random = (bound: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % bound;
  };
  for (let sample = 0; sample < 1_000; sample++) {
    const mapping = new Mapping();
    const appendIndex = new NativeMappingIndex();
    const count = random(18) + 1;
    for (let i = 0; i < count; i++) {
      if (i && random(4) === 0) {
        const original = random(mapping.maps.length);
        mapping.appendMap(mapping.maps[original]!.invert(), original);
      } else {
        const from = random(35),
          old = random(5),
          next = random(5);
        const ranges =
          random(3) === 0 ? [from, old, next, from + old + random(4), random(4), random(4)] : [from, old, next];
        const map = new StepMap(ranges);
        mapping.appendMap(random(3) === 0 ? map.invert() : map);
      }
      if (sample < 200 && i % 2 === 0)
        compare(mapping.slice(random(mapping.maps.length + 1)), appendIndex, `growing${sample}/${i}`);
    }
    const index = new NativeMappingIndex();
    compare(mapping, index, `forward${sample}`);
    const from = random(mapping.maps.length + 1),
      to = from + random(mapping.maps.length - from + 1);
    compare(mapping.slice(from, to), index, `slice${sample}`);
    compare(mapping.invert(), index, `inverse${sample}`);
  }
});

test('unknown native-map overrides and foreign Mappables retain the exact maintained fallback', () => {
  const index = new NativeMappingIndex();
  const foreign: Mappable = {
    map: (position) => position + 2,
    mapResult: (position) => new Mapping([StepMap.offset(2)]).mapResult(position),
  };
  expect(index.mappable(foreign) === foreign).toBe(true);
  const map = new StepMap([1, 2, 3]);
  Object.defineProperty(map, 'mapResult', {
    value: (position: number, assoc: number) => StepMap.prototype.mapResult.call(map, position, assoc),
  });
  const mapping = new Mapping([map]);
  expect(index.mappable(mapping) === mapping).toBe(true);
  const nonfinite = new Mapping([new StepMap([0, 1, Infinity])]);
  expect(index.mappable(nonfinite) === nonfinite).toBe(true);
});
