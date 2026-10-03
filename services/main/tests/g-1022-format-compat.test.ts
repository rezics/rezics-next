import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkStructurePage, STRUCTURE_PAGE_FORMAT } from '../src/modules/structure/format.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
test('G1022: Zone mount pages accept alias/id and reject the retired name vocabulary', () => {
  for (const key of ['alias', 'id'] as const) {
    const original = { format: STRUCTURE_PAGE_FORMAT, tree: 'record', level: 0, entries: [{
      occurrence: id(), state: 'active', parent: id(), segmentKey: 'a', orderKey: 'a', role: 'mount',
      target: id(), introducedBy: id(), labels: [], qualifier: { type: 'zone-mount', zone: id(), key,
        routeSegment: 'reading', disclosure: 'public' },
    }] };
    const encoded = JSON.stringify(original);
    expect(JSON.stringify(checkStructurePage(new TextEncoder().encode(encoded)))).toBe(encoded);
    const retired = { ...original, entries: [{ ...original.entries[0]!,
      qualifier: { ...original.entries[0]!.qualifier, key: 'name' } }] };
    expect(() => checkStructurePage(new TextEncoder().encode(JSON.stringify(retired)))).toThrow('Structure page format differs');
  }
});
