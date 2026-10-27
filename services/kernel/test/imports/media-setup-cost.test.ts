import { expect, test } from 'bun:test';
import { convertBangumi } from '../../../../packages/conversion/src/bangumi.ts';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { MediaBoundaryDriver } from '../../../../specs/imports-media-boundary-driver.ts';
import { createMediaBoundaryDriver } from './media-boundary-driver.ts';

type ApiCall = { containerId: string };
type MediaBoundaryCostDriver = MediaBoundaryDriver & {
  counters(): Promise<{ identityOpens: number; publicApiCalls: readonly ApiCall[] }>;
  seedGrowthStep(input: { request: MediaImportRequest; previousScale: number; scale: number }): Promise<void>;
};

function growthRequest(containerId: string): MediaImportRequest {
  return convertBangumi(
    {
      external_id: '42',
      record_revision: 'native:7',
      record: { id: 42, type: 1, name: 'Book', images: { large: 'https://lain.bgm.tv/pic/cover/l/ab/cd/42.jpg' } },
    },
    { source: 'bangumi', subjectId: containerId },
  ).mediaImportIntents[0]!;
}

test('media growth seeding makes the same number of public API calls at every scale', async () => {
  const driver = (await createMediaBoundaryDriver()) as MediaBoundaryCostDriver;
  try {
    const request = growthRequest(driver.containerId);
    await driver.seedGrowthStep({ request, previousScale: 0, scale: 1 });
    const afterSmall = await driver.counters();
    await driver.seedGrowthStep({ request, previousScale: 1, scale: 8 });
    const afterLarge = await driver.counters();

    const smallCalls = afterSmall.publicApiCalls;
    const largeCalls = afterLarge.publicApiCalls.slice(smallCalls.length);
    expect(smallCalls.length).toBeGreaterThan(0);
    expect(largeCalls).toHaveLength(smallCalls.length);
    expect([...smallCalls, ...largeCalls].every((call) => call.containerId === driver.containerId)).toBe(true);
  } finally {
    await driver.close();
  }
}, 600_000);

test('media boundary scenarios in one file share one identity', async () => {
  const drivers: MediaBoundaryCostDriver[] = [];
  try {
    for (let index = 0; index < 3; index++)
      drivers.push((await createMediaBoundaryDriver()) as MediaBoundaryCostDriver);

    const counters = await drivers[2]!.counters();
    expect(counters.identityOpens).toBe(1);
  } finally {
    for (const driver of drivers) await driver.close();
  }
}, 600_000);
