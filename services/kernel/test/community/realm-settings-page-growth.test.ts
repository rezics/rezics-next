import { afterEach, expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth, seed } from '../support/growth.ts';
import { axes, scales } from './support/growth-realm-presentation-settings-fixture.ts';
import { aggregateBanReviewPageCapture, banReviewPageWireCounts } from './support/ban-review-page-capture.ts';
import {
  assertSettingsSourcePrefixes,
  settingsPageGrowthFixture,
  type SettingsAxis,
  type SettingsBranch,
} from './support/realm-settings-page-growth-fixture.ts';

let f: Awaited<ReturnType<typeof settingsPageGrowthFixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
}, 120_000);

const branches = [
  'available',
  'empty',
  'denied',
  'revoked',
  'unavailable',
  'retry',
  'withheld',
] as const satisfies readonly SettingsBranch[];
const cases: readonly { axis: SettingsAxis; branch: SettingsBranch }[] = [
  ...axes.flatMap((axis) => branches.map((branch) => ({ axis, branch }))),
  { axis: 'selected-media-history', branch: 'available' },
  { axis: 'authority-history', branch: 'available' },
  { axis: 'unrelated-realms', branch: 'deadline' },
];

// The mounted read, authentication and all source/final rounds are captured;
// setup and each independent history population remain outside the measured path.
for (const { axis, branch } of cases)
  test.serial(
    `mounted settings GET ${branch}: ${axis} at ${scales.join('/')}`,
    async () => {
      const fixture = (f = await settingsPageGrowthFixture());
      const withImages = branch === 'available' || (branch === 'unavailable' && axis === 'rules-revisions');
      const maximalAncestry = branch === 'available' && axis === 'unrelated-realms';
      const s = await fixture.select({ images: withImages, maximalAncestry });
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
          if (axis === 'selected-media-history' || axis === 'authority-history') {
            assertSettingsSourcePrefixes(primary, 'unrelated-realms');
            assertSettingsSourcePrefixes(primary, 'rules-revisions');
          } else if (
            branch !== 'deadline' &&
            (axis !== 'rules-revisions' || !['empty', 'denied', 'revoked', 'unavailable'].includes(branch))
          )
            assertSettingsSourcePrefixes(primary, axis);
          return aggregateBanReviewPageCapture(primary, value);
        },
        counted: {
          bounds: {
            applicationRequestBytes: 'constant',
            applicationResponseBytes: 'constant',
            jwksRequestBytes: 'constant',
            jwksResponseBytes: 'constant',
          },
          read: banReviewPageWireCounts,
        },
        async grow(_, scale, previous) {
          await seed(fixture.db, population, { from: previous, to: scale });
          if (axis === 'selected-media-history' || axis === 'authority-history')
            expect(await fixture.historyCount(s, axis)).toBe(scale);
        },
        async operation() {
          const before = await fixture.snapshot(s);
          // Each explicit retry pays a separate complete HTTP/authentication attempt.
          // The first response is unavailable, and identical input then recovers.
          if (branch === 'retry') {
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
      if (branch !== 'denied' && branch !== 'revoked' && branch !== 'deadline') {
        const growing =
          axis === 'unrelated-realms'
            ? ['community.realm']
            : axis === 'realm-revisions'
              ? ['community.realm_revision']
              : axis === 'rules-revisions'
                ? ['content.revision']
                : axis === 'selected-media-history'
                  ? ['content.media', 'content.media_variant']
                  : ['access.resource_grant'];
        const checked = growing.filter(
          (relation) =>
            !['content.revision', 'content.media', 'content.media_variant', 'access.resource_grant'].includes(
              relation,
            ) ||
            (withImages && branch !== 'unavailable'),
        );
        if (checked.length) assertGrowthAccessPaths(`Mounted settings ${branch} ${axis}`, report.samples, checked);
      }
    },
    600_000,
  );
