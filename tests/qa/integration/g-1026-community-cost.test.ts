import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertWorkCost, assertWorkCostAtScales, type WorkProfile } from '../support/work-profile.ts';
import { COMMUNITY_PROFILE_COST, type CommunityProfileOperation } from '../../../services/main/src/modules/realm/profile-cost.ts';
import { workProfileProbe } from '../support/work-profile-probe.ts';

test('G1026: native request counters reject deliberate repeated database and graph work', async () => {
  const { result,profile } = await workProfileProbe(4, true);
  expect(result.rows).toEqual(['1','1','1','1']);
  expect(profile.fusekiRequests).toBe(4);
  expect(profile.postgresStatements).toBe(4);
  expect(() => assertWorkCost(profile, { fusekiRequests: 3,postgresStatements: 3 })).toThrow();
}, 60_000);

test('G1026: community and site API profiles keep bounded hydration across public command corpora', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const child = Bun.spawn([process.execPath, 'services/main/tests/g-1026-profile-child.ts'], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Community cost probe failed (${exit}): ${errors}\n${output.slice(-2000)}`);
  const measured = JSON.parse(readFileSync(`.temp/work-profiles/g-1026-${process.env.G1026_PHASE ?? 'after'}.json`, 'utf8')) as { profiles: Array<{ dimension: string; scale: string;
    operation: string; viewer: string; temperature: string; profile: WorkProfile }> };
  expect(measured.profiles.length).toBeGreaterThan(100);
  if (process.env.G1026_PHASE === 'before') return;
  const dimensions = ['realmSize','historyDepth','follows','memberships','unrelatedWorks']
    .filter(dimension=>!process.env.G1026_DIMENSIONS || process.env.G1026_DIMENSIONS.split(',').includes(dimension));
  expect(dimensions.length).toBeGreaterThan(0);
  for (const dimension of dimensions) {
    for (const operation of ['header','threads-best','threads-new','threads-top','thread','roster','zone-home','zone-presentation'] satisfies CommunityProfileOperation[]) {
      for (const viewer of ['anonymous','member']) for (const temperature of ['first','warm']) {
        const profiles = measured.profiles.filter(item => item.dimension === dimension && item.operation === operation
          && item.viewer === viewer && item.temperature === temperature).map(item => item.profile);
        const contract = COMMUNITY_PROFILE_COST[operation];
        assertWorkCostAtScales(profiles, { fusekiRequests: contract.fusekiRequests,
          postgresStatements: viewer === 'anonymous' ? contract.anonymousStatements : contract.memberStatements,
          accountCalls: 0, mainCalls: 0, otherFetches: contract.otherFetches });
        // Fixed page contents / owner probes may not cause SQL N+1 as background grows.
        expect(new Set(profiles.map(profile => profile.postgresStatements)).size).toBe(1);
      }
    }
  }
  for (const operation of ['header-rules', 'zone-banners'] satisfies CommunityProfileOperation[]) for (const viewer of ['anonymous','member']) {
    const profiles = measured.profiles.filter(item => item.operation === operation && item.viewer === viewer).map(item => item.profile);
    const contract = COMMUNITY_PROFILE_COST[operation];
    assertWorkCostAtScales(profiles, { fusekiRequests: contract.fusekiRequests,
      postgresStatements: viewer === 'anonymous' ? contract.anonymousStatements : contract.memberStatements,
      otherFetches: contract.otherFetches });
    expect(new Set(profiles.map(profile => profile.postgresStatements)).size).toBe(1);
  }
}, 600_000);
