import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { integrationOrderPrelude } from '../support/integration-order.ts';
import { assertWorkCostAtScales, type WorkProfile } from '../support/work-profile.ts';

test('G1034: complete Realm Best/Top and fixed header work at 100/1000/10000 real threads with retained history', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const started = performance.now();
  await integrationOrderPrelude('g-1034-realm-ranking');
  const { resultPath } = await runWorkProfileChild('services/main/tests/g-1034-profile-child.ts', {
    timeoutMs: Math.max(1, 590_000 - (performance.now() - started)),
  });
  const measured = JSON.parse(readFileSync(resultPath, 'utf8')) as {
    profiles: {
      size: number;
      operation: string;
      viewer: string;
      temperature: string;
      profile: WorkProfile;
    }[];
  };
  expect(measured.profiles).toHaveLength(24);
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
          .map((row) => row.profile);
        assertWorkCostAtScales(profiles, {
          fusekiRequests: 16,
          fusekiReceivedBytes: 16_000,
          postgresStatements: viewer === 'anonymous' ? 44 : 49,
          accountCalls: 0,
          mainCalls: 0,
          otherFetches: 0,
        });
        expect(new Set(profiles.map((profile) => profile.postgresStatements)).size).toBe(1);
        // Hydrated page contents stay identical while complete populations grow 100×.
        expect(
          Math.max(...profiles.map((profile) => profile.fusekiReceivedBytes!)) -
            Math.min(...profiles.map((profile) => profile.fusekiReceivedBytes!)),
        ).toBeLessThan(1024);
      }
}, 600_000);
