import { expect } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assertWorkCostAtScales, type WorkProfile } from '../support/work-profile.ts';
import {
  COMMUNITY_PROFILE_COST,
  type CommunityProfileOperation,
} from '../../../services/main/src/modules/realm/profile-cost.ts';

export async function communityCostDimension(
  dimension: 'realmSize' | 'historyDepth' | 'follows' | 'memberships' | 'unrelatedWorks',
  group: 'threads' | 'surfaces',
) {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  mkdirSync('.temp/work-profiles', { recursive: true });
  const operations: CommunityProfileOperation[] =
    group === 'threads'
      ? ['threads-best', 'threads-new', 'threads-top', 'thread']
      : ['header', 'roster', 'zone-home', 'zone-presentation', 'header-rules', 'zone-banners'];
  const log = `.temp/work-profiles/g-1026-${dimension}-${group}.log`;
  writeFileSync(log, '');
  const child = Bun.spawn([process.execPath, 'services/main/tests/g-1026-profile-child.ts'], {
    env: {
      ...process.env,
      G1026_DIMENSIONS: dimension,
      G1026_GROUP: group,
      G1026_OPERATIONS: operations.join(','),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const capture = async () => {
    let tail = '';
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      appendFileSync(log, text);
      tail = (tail + text).slice(-4000);
    }
    return tail;
  };
  const [exit, output, errors] = await Promise.all([
    child.exited,
    capture(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0)
    throw new Error(`Community cost probe failed (${exit}): ${errors}\n${output.slice(-2000)}`);
  const measured = JSON.parse(
    readFileSync(
      `.temp/work-profiles/g-1026-${process.env.G1026_PHASE ?? 'after'}-${dimension}-${group}.json`,
      'utf8',
    ),
  ) as {
    profiles: Array<{
      dimension: string;
      scale: string;
      operation: string;
      viewer: string;
      temperature: string;
      profile: WorkProfile;
    }>;
  };
  expect(measured.profiles).toHaveLength(group === 'threads' ? 48 : 72);
  expect(
    new Set(
      measured.profiles.filter((item) => item.dimension === dimension).map((item) => item.scale),
    ).size,
  ).toBe(3);
  if (process.env.G1026_PHASE === 'before') return;
  const dimensions = [dimension];
  expect(dimensions.length).toBeGreaterThan(0);
  for (const dimension of dimensions) {
    for (const operation of (
      [
        'header',
        'threads-best',
        'threads-new',
        'threads-top',
        'thread',
        'roster',
        'zone-home',
        'zone-presentation',
      ] satisfies CommunityProfileOperation[]
    ).filter((operation) => operations.includes(operation))) {
      for (const viewer of ['anonymous', 'member'])
        for (const temperature of ['first', 'warm']) {
          const profiles = measured.profiles
            .filter(
              (item) =>
                item.dimension === dimension &&
                item.operation === operation &&
                item.viewer === viewer &&
                item.temperature === temperature,
            )
            .map((item) => item.profile);
          const contract = COMMUNITY_PROFILE_COST[operation];
          assertWorkCostAtScales(profiles, {
            fusekiRequests: contract.fusekiRequests,
            postgresStatements:
              viewer === 'anonymous' ? contract.anonymousStatements : contract.memberStatements,
            accountCalls: 0,
            mainCalls: 0,
            otherFetches: contract.otherFetches,
          });
          // Fixed page contents / owner probes may not cause SQL N+1 as background grows.
          expect(new Set(profiles.map((profile) => profile.postgresStatements)).size).toBe(1);
        }
    }
  }
  for (const operation of (
    ['header-rules', 'zone-banners'] satisfies CommunityProfileOperation[]
  ).filter((operation) => operations.includes(operation)))
    for (const viewer of ['anonymous', 'member']) {
      const profiles = measured.profiles
        .filter((item) => item.operation === operation && item.viewer === viewer)
        .map((item) => item.profile);
      const contract = COMMUNITY_PROFILE_COST[operation];
      assertWorkCostAtScales(profiles, {
        fusekiRequests: contract.fusekiRequests,
        postgresStatements:
          viewer === 'anonymous' ? contract.anonymousStatements : contract.memberStatements,
        otherFetches: contract.otherFetches,
      });
      expect(new Set(profiles.map((profile) => profile.postgresStatements)).size).toBe(1);
    }
}
