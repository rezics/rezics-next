import { afterEach, expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth, seed } from '../support/growth.ts';
import { axes, scales } from './support/growth-realm-presentation-settings-fixture.ts';
import { aggregateBanReviewPageCapture, banReviewPageWireCounts } from './support/ban-review-page-capture.ts';
import { assertSettingsSourcePrefixes, settingsPageGrowthFixture, type SettingsBranch } from './support/realm-settings-page-growth-fixture.ts';

let f: Awaited<ReturnType<typeof settingsPageGrowthFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; }, 120_000);

// These populations are independent. The mounted read, authentication and all
// source/final rounds are inside capture; setup and growth are outside it.
for (const axis of axes)
  for (const branch of ['available', 'empty', 'denied', 'revoked', 'unavailable', 'retry', 'withheld'] as const satisfies readonly SettingsBranch[])
    test.serial(`mounted settings GET ${branch}: ${axis} at ${scales.join('/')}`, async () => {
      const fixture = f = await settingsPageGrowthFixture();
      const s = await fixture.select();
      if (branch !== 'empty') {
        const saved = await fixture.patch(s, { presentation: s.presentation });
        expect(saved.response.status, saved.text).toBe(200);
        s.head = saved.value.realm.headRevisionId;
      }
      if (branch === 'revoked') {
        await fixture.manage(s, fixture.base.other);
        await fixture.manage(s, fixture.base.other, true);
      }
      const population = await fixture.population(s, axis);
      const report = await checkGrowth(fixture.db, {
        name: `Mounted settings ${branch} ${axis}`,
        scales,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        aggregateCaptures(primary, value) {
          if (axis !== 'rules-revisions' || !['empty', 'denied', 'revoked', 'unavailable'].includes(branch))
            assertSettingsSourcePrefixes(primary, axis);
          return aggregateBanReviewPageCapture(primary, value);
        },
        counted: {
          bounds: {
            applicationRequestBytes: 'constant', applicationResponseBytes: 'constant',
            jwksRequestBytes: 'constant', jwksResponseBytes: 'constant',
          },
          read: banReviewPageWireCounts,
        },
        async grow(_, scale, previous) { await seed(fixture.db, population, { from: previous, to: scale }); },
        async operation() {
          const before = await fixture.snapshot(s);
          // Each explicit retry pays a separate complete HTTP/authentication attempt.
          // The first response is unavailable, and identical input then recovers.
          if (branch === 'retry') {
            // Kept inside the same operation, including its separate Auth capture.
            const first = await fixture.read(s, branch, true);
            const second = await fixture.read(s, branch, false);
            const merged = aggregateBanReviewPageCapture(first.authCapture, second).capture;
            expect(await fixture.snapshot(s)).toEqual(before);
            return {
              authCapture: merged,
              applicationRequestBytes: first.applicationRequestBytes + second.applicationRequestBytes,
              applicationResponseBytes: first.applicationResponseBytes + second.applicationResponseBytes,
              jwksRequestBytes: first.jwksRequestBytes + second.jwksRequestBytes,
              jwksResponseBytes: first.jwksResponseBytes + second.jwksResponseBytes,
            };
          }
          const result = await fixture.read(s, branch);
          expect(await fixture.snapshot(s)).toEqual(before);
          return result;
        },
      });
      if (branch !== 'denied' && branch !== 'revoked')
        assertGrowthAccessPaths(`Mounted settings ${branch} ${axis}`, report.samples, [
          axis === 'unrelated-realms' ? 'community.realm' : axis === 'realm-revisions' ? 'community.realm_revision' : 'content.revision',
        ].filter((relation) => relation !== 'content.revision' || (branch !== 'empty' && branch !== 'unavailable')));
    }, 600_000);
