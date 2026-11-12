import { expect, test } from 'bun:test';
import { createZoneFollowTargetAdapter, type FollowableZone } from '../../src/library/adapters/zone-follow-target.ts';
import { createLibraryPresentationApplication } from '../../src/library/application/presentation.ts';

const actor = { kind: 'anonymous' } as const;
const zone: FollowableZone = { id: 'zone-original', revision: '1', visibility: 'public', label: 'Current name' };
const edge = { targetId: zone.id, targetType: 'zone', state: 'following', reason: 'explicit' };

test('Zone projection uses native identity and detects read loss, publication changes and renames', async () => {
  for (const after of [
    null,
    { ...zone, visibility: 'private' as const },
    { ...zone, revision: '2', label: 'Renamed' },
  ]) {
    let current: FollowableZone | null = zone;
    const adapter = createZoneFollowTargetAdapter(async () => current);
    const observation = await adapter.observe(actor, zone.id, 123);
    current = after;
    expect(await observation.current()).toBe(false);
  }
});

test('FULL has one registered owner projection and withholds changes after related reads; BASIC does no reads', async () => {
  const current: FollowableZone | null = zone;
  let calls = 0;
  const adapter = createZoneFollowTargetAdapter(async () => {
    calls++;
    return current;
  });
  const full = createLibraryPresentationApplication({
    subjects: async () => ({ value: new Map(), current: async () => true }),
    account: async () => ({ value: null, current: async () => true }),
    attributions: async () => ({ value: new Map(), current: async () => true }),
    target: async () => {
      throw new Error('Registered Zone must not use a fallback');
    },
    unavailable: () => new Error('unavailable'),
  });
  const options = { nativeFollowTargets: { adapters: [adapter], actor, deadline: 123 } };
  const body = { follows: [edge, edge], next: null };
  expect(await full('BASIC', body, options)).toBe(body);
  expect(calls).toBe(0);
  const shown = await full('FULL', body, options);
  expect(calls).toBe(2); // duplicate occurrences share one observation and final read
  expect(shown.follows[0]).toMatchObject({
    target: { label: zone.label },
    destination: { kind: 'zone', zoneId: zone.id },
  });
  calls = 0;
  const changing = createZoneFollowTargetAdapter(async () => (++calls === 1 ? zone : null));
  const hidden = await full('FULL', body, {
    nativeFollowTargets: { ...options.nativeFollowTargets, adapters: [changing] },
  });
  expect(hidden.follows).toEqual(
    [edge, edge].map((row) => ({ ...row, target: null, destination: { kind: 'unavailable' } })),
  );
  expect(hidden.next).toBeNull();
});
