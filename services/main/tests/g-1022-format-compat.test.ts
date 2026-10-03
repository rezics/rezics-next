import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkStructurePage, STRUCTURE_PAGE_FORMAT } from '../src/modules/structure/format.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
test('G1022: current alias mounts and historical name mounts retain their exact immutable v1 representation', () => {
  for (const key of ['alias', 'name'] as const) {
    const original = { format: STRUCTURE_PAGE_FORMAT, tree: 'record', level: 0, entries: [{
      occurrence: id(), state: 'active', parent: id(), segmentKey: 'a', orderKey: 'a', role: 'mount',
      target: id(), introducedBy: id(), labels: [], qualifier: { type: 'zone-mount', zone: id(), key,
        routeSegment: 'reading', disclosure: 'public' },
    }] };
    const encoded = JSON.stringify(original);
    expect(JSON.stringify(checkStructurePage(new TextEncoder().encode(encoded)))).toBe(encoded);
  }
});
