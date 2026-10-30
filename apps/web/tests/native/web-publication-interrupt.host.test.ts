import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import data from '../../../../specs/fixtures/web-publication.json';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';

setDefaultTimeout(600_000);

describe('native web publication driver interruptions', () => {
  let driver: WebPublicationDriver;
  let fixture: Awaited<ReturnType<WebPublicationDriver['provision']>>;

  beforeAll(async () => {
    const binding = await import('./web-publication-driver.ts');
    driver = await binding.createWebPublicationDriver();
    fixture = await driver.provision(data);
  });

  afterAll(async () => driver?.close());

  test('owner-read makes the unavailable view owner fail at the served page and restores it', async () => {
    const reachable = await driver.request(fixture.unavailableView);
    expect(reachable.status).toBe(200);
    await reachable.body?.cancel();

    const restore = await driver.interrupt('owner-read');
    try {
      const unavailable = await driver.request(fixture.unavailableView);
      expect(unavailable.status).not.toBe(200);
      await unavailable.body?.cancel();
    } finally {
      await restore();
    }

    const restored = await driver.request(fixture.unavailableView);
    expect(restored.status).toBe(200);
    await restored.body?.cancel();
  });

  test('subject-view keeps a cold view unprojected until the durable worker resumes', async () => {
    const binding = await import('./web-publication-driver.ts');
    const isolated = await binding.createWebPublicationDriver();
    const restore = await isolated.interrupt('subject-view');
    try {
      const isolatedFixture = await isolated.provision(data);
      const cold = await isolated.request(isolatedFixture.preparingView);
      expect(cold.status).toBe(200);
      expect(await cold.text()).not.toContain(data.subjects.book.title);

      const restoredAt = performance.now();
      await restore();
      const projectionDeadline = restoredAt + 120_000;
      let projected = false;
      let delay = 50;
      while (performance.now() < projectionDeadline) {
        const ready = await isolated.request(isolatedFixture.preparingView);
        const html = await ready.text();
        if (ready.status === 200 && html.includes(data.subjects.book.title)) {
          projected = true;
          break;
        }
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 1000);
      }
      console.info(`web-publication-interrupt: subject-view-restore-to-projection=${Math.round(performance.now() - restoredAt)}ms`);
      expect(projected).toBe(true);
    } finally {
      await restore();
      await isolated.close();
    }
  });

  test('restore is idempotent and close restores an active interruption', async () => {
    const restore = await driver.interrupt('owner-read');
    await restore();
    await restore();

    const isolatedBinding = await import('./web-publication-driver.ts');
    const isolated = await isolatedBinding.createWebPublicationDriver();
    const closeRestore = await isolated.interrupt('owner-read');
    await isolated.close();
    // close owns cleanup of its listener/process even when its restore was not called.
    await expect(closeRestore()).resolves.toBeUndefined();
  });
});
