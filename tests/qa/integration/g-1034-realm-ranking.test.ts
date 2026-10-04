import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertWorkCostAtScales, type WorkProfile } from '../support/work-profile.ts';

test('G1034: complete Realm Best/Top and fixed header work at 100/1000/10000 real threads with retained history', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const child = Bun.spawn([process.execPath, 'services/main/tests/g-1034-profile-child.ts'], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`Realm ranking profile failed (${code}): ${errors}\n${output.slice(-2000)}`);
  const measured = JSON.parse(readFileSync('.temp/work-profiles/g-1034.json', 'utf8')) as {
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
