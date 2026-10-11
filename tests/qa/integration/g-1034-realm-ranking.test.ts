import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { integrationOrderPrelude } from '../support/integration-order.ts';
import { assertWorkCostAtScales, type WorkProfile } from '../support/work-profile.ts';

// Keep this qualification in the ranking file's large-stack allocation. These
// files run in this Bun process and retain a real shared administrator/graph.
if (process.env.G1034_SHARED_SHARD_PROBE === '1') {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  await import('./g-571-screen.test.ts');
  await import('./agent-profile.test.ts');
}

test('G1034: complete Realm Best/Top and fixed header work at 100/400/1600 real threads with retained history', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const started = performance.now();
  await integrationOrderPrelude('g-1034-realm-ranking');
  const { resultPath } = await runWorkProfileChild('services/main/tests/g-1034-profile-child.ts', {
    timeoutMs: Math.max(1, 590_000 - (performance.now() - started)),
  });
  const measured = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    ownerDatabases: Record<string, string>;
    profiles: {
      size: number;
      operation: string;
      viewer: string;
      temperature: string;
      profile: WorkProfile;
    }[];
    replyWrites: {
      size: number;
      populatedSlots: number;
      profile: WorkProfile;
      fusekiQueryCalls: number;
    }[];
  };
  // The immutable administrator and recovery fence must never use shard owners.
  for (const [owner, url] of [
    ['access', process.env.ACCESS_DATABASE_URL],
    ['content', process.env.CONTENT_DATABASE_URL],
    ['relay', process.env.ACCOUNT_RELAY_DATABASE_URL],
  ] as const) {
    expect(measured.ownerDatabases[owner]).toBeString();
    expect(measured.ownerDatabases[owner]).not.toBe(new URL(url!).pathname.slice(1));
  }
  expect(measured.profiles).toHaveLength(24);
  // Three geometric cuts make the growth class observable between endpoints;
  // this replaces the former 10,000-thread cut while preserving absolute caps.
  for (const operation of ['best', 'top'])
    for (const viewer of ['anonymous', 'member'])
      for (const temperature of ['first', 'warm']) {
        const profiles = measured.profiles
          .filter(
            (row) =>
              row.operation === operation &&
              row.viewer === viewer &&
              row.temperature === temperature,
          )
          .map((row) => ({ ...row.profile, dimensions: { threads: row.size } }));
        assertWorkCostAtScales(
          profiles,
          {
            fusekiRequests: 16,
            fusekiReceivedBytes: 16_000,
            postgresStatements: viewer === 'anonymous' ? 44 : 49,
            accountCalls: 0,
            mainCalls: 0,
            otherFetches: 0,
            growth: {
              postgresStatements: { class: 'constant', dimension: 'threads' },
              fusekiRequests: { class: 'constant', dimension: 'threads' },
              fusekiReceivedBytes: { class: 'logarithmic', dimension: 'threads' },
            },
          },
          `g1034-${operation}-${viewer}-${temperature}`,
        );
        expect(new Set(profiles.map((profile) => profile.postgresStatements)).size).toBe(1);
        // Hydrated page contents stay identical while complete populations grow 16×.
        expect(
          Math.max(...profiles.map((profile) => profile.fusekiReceivedBytes!)) -
            Math.min(...profiles.map((profile) => profile.fusekiReceivedBytes!)),
        ).toBeLessThan(1024);
      }
  expect(measured.replyWrites).toHaveLength(3);
  expect(measured.replyWrites.map((row) => [row.size, row.populatedSlots])).toEqual([
    [100, 100],
    [400, 400],
    [1600, 1640],
  ]);
  const replyProfiles = measured.replyWrites.map(({ size, profile }) => ({
    ...profile,
    dimensions: { threads: size },
  }));
  assertWorkCostAtScales(
    replyProfiles,
    {
      postgresStatements: 840,
      fusekiRequests: 130,
      growth: {
        postgresStatements: { class: 'constant', dimension: 'threads' },
        fusekiRequests: { class: 'constant', dimension: 'threads' },
      },
    },
    'g1034-reply-write',
  );
  expect(new Set(replyProfiles.map((profile) => profile.postgresStatements)).size).toBe(1);
  expect(new Set(replyProfiles.map((profile) => profile.fusekiRequests)).size).toBe(1);
  expect(new Set(measured.replyWrites.map((row) => row.fusekiQueryCalls)).size).toBe(1);
  expect(
    replyProfiles.every(
      (profile) => profile.postgresStatements! > 0 && profile.fusekiRequests! > 0,
    ),
  ).toBe(true);
  expect(measured.replyWrites.every((row) => row.fusekiQueryCalls > 0)).toBe(true);
}, 600_000);
