import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CompositionConflict } from '../src/modules/structure/change.ts';
import type { PlacementState } from '../src/modules/structure/graph.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { ZONE_RESERVED_SEGMENTS } from '../src/modules/zone/route-path.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
// Structure discovery loads this profile while the profile module is still evaluating.
// Importing that module directly never finishes; the registry returns the same validator.
const validate = structureProfileFor('zone-navigation').qualifierValidations!;

function fixture() {
  const zone = id(), structure = id(), generation = id(), queries: string[] = [];
  const env = { fuseki: {
    query: async (query: string) => { queries.push(query); return { boolean: true }; },
    commandHealth: async () => ({ profiles: { 'zone-capability-v1': profileRegistry['zone-capability-v1'].sha256 } }),
  } } as unknown as WorkActivationEnvironment;
  const mount = (segment: string): PlacementState => ({ occurrence: id(), placement: id(), active: true,
    role: 'mount', parent: structure, target: id(), introducedBy: id(),
    qualifier: { type: 'zone-mount', zone, routeSegment: segment, disclosure: 'public' } });
  return { env, mount, queries, context: { structure, generation, replacement: true } };
}

test('G630/G830: replacement mount validation ignores live placement IDs and preserves ordinary collision checks', async () => {
  const f = fixture(), mounts = [f.mount('picks'), f.mount('guide')];
  expect(await validate(f.env, mounts, { ...f.context, placements: mounts })).toHaveLength(1);
  expect(f.queries).toHaveLength(0);
  await expect(validate(f.env, mounts.slice(0, 1), { ...f.context, replacement: false }))
    .rejects.toBeInstanceOf(CompositionConflict);
  expect(f.queries).toHaveLength(1);
});

test('G630/G830: complete replacement candidates reject duplicate mounts beyond the changed batch and every reserved segment', async () => {
  const f = fixture(), first = f.mount('picks');
  const candidate = [first, ...Array.from({ length: 128 }, (_, index) => f.mount(`page-${index}`)), f.mount('picks')];
  await expect(validate(f.env, [first], { ...f.context, placements: candidate }))
    .rejects.toBeInstanceOf(CompositionConflict);
  for (const segment of ZONE_RESERVED_SEGMENTS) {
    await expect(validate(f.env, [first], { ...f.context, placements: [first, f.mount(segment)] }))
      .rejects.toBeInstanceOf(CompositionConflict);
  }
  expect(f.queries).toHaveLength(0);
});
