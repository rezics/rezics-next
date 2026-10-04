import { expect, test } from 'bun:test';
import { assertWorkCost } from '../support/work-profile.ts';
import { communityCostDimension } from './g-1042-community-cost-support.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';

test('G1026: native request counters reject deliberate repeated database and graph work', async () => {
  const { result, profile } = await workProfileProbe(4, true);
  expect(result.rows).toEqual(['1', '1', '1', '1']);
  expect(profile.fusekiRequests).toBe(4);
  expect(profile.postgresStatements).toBe(4);
  expect(() => assertWorkCost(profile, { fusekiRequests: 3, postgresStatements: 3 })).toThrow();
}, 60_000);

// One growth dimension per QA file keeps each shard within 480 seconds.
test(
  'G1026: community and site API profiles keep bounded hydration as realmSize grows',
  () => communityCostDimension('realmSize', 'threads'),
  470_000,
);
