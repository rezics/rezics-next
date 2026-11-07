import { expect, test } from 'bun:test';
import {
  applyWalkResults,
  checkoutSessionIdFromUrl,
  FIRST_PUBLIC_JOURNEYS,
  publicFields,
  summarizeWalk,
  waitUntilIdentityBootstrapRemainingZero,
  walkStripeOrigin,
  type JourneyWalkRow,
} from './support/goal-journey-walk.ts';

test('walk evidence keeps all twenty-six first-public rows', () => {
  const rows: JourneyWalkRow[] = FIRST_PUBLIC_JOURNEYS.map((journey) => ({
    journey: journey.id,
    title: journey.title,
    result: 'FAIL',
    revision: '4634deb2ed9def2f2e57bb3aa8b370c52880ad4b',
    utc: '2026-11-07T03:10:51.023Z',
    elapsedSeconds: 144,
    persona: 'setup',
    firstDiffering: {
      command: 'seeded walk setup',
      expected: 'admitted seeded walk setup',
      observed: 'seed exited 1: Cross-media vndb/entry_meta exceeded its bounded scan',
    },
    evidence: '.temp/commerce-walk/results.json',
    steps: [],
    pages: [...journey.pages],
  }));
  const report = publicFields(summarizeWalk(rows[0]!.revision, rows)) as { rows: JourneyWalkRow[]; passing: number };
  expect(FIRST_PUBLIC_JOURNEYS).toHaveLength(26);
  expect(report.rows).toHaveLength(26);
  expect(report.rows.at(-1)?.journey).toBe('follower-counts');
  expect(report.passing).toBe(0);
});

test('walk checkout URLs yield the hosted session and loopback Stripe origin', () => {
  expect(checkoutSessionIdFromUrl('https://checkout.stripe.com/c/pay/cs_000000000001')).toBe('cs_000000000001');
  expect(checkoutSessionIdFromUrl('https://checkout.stripe.com/c/pay/cs_test_walkSession')).toBe('cs_test_walkSession');
  expect(walkStripeOrigin({ STRIPE_API_HOST: 'http://127.0.0.1:18765' })).toBe('http://127.0.0.1:18765');
  expect(walkStripeOrigin({ STRIPE_API_HOST: 'https://api.stripe.com' })).toBeUndefined();
});

test('walk results replace finishing-register cells and the measured summary', () => {
  const rows: JourneyWalkRow[] = FIRST_PUBLIC_JOURNEYS.map((journey) => ({
    journey: journey.id,
    title: journey.title,
    result: 'FAIL',
    revision: 'e68f0eb31ddd8857e27ad7ff794487b1672c9d8b',
    utc: '2026-11-07T04:46:25.021Z',
    elapsedSeconds: 278,
    persona: 'setup',
    firstDiffering: {
      command: 'seeded walk setup',
      expected: 'admitted seeded walk setup',
      observed: 'seed-retry exited 1: Import transport request failed',
    },
    evidence: '.temp/commerce-walk/results.json',
    steps: [],
    pages: [...journey.pages],
  }));
  const next = applyWalkResults(
    [
      'Latest measured result: **1/26**.',
      '| Journey | User-visible path | Latest dev walk | Evidence / elapsed |',
      '| Offer management | Creator opens /creator/offers. | Pending first walk | — |',
    ].join('\n'),
    rows,
  );
  expect(next).toContain(
    'Latest measured result: **0/26**. Slowest failing path: Offer management (setup, 278s); first differing command `seeded walk setup` / result `seed-retry exited 1: Import transport request failed`.',
  );
  expect(next).toContain(
    '| Offer management | Creator opens /creator/offers. | FAIL e68f0eb31ddd 2026-11-07T04:46:25.021Z setup | .temp/commerce-walk/results.json 278s; seeded walk setup → seed-retry exited 1: Import transport request failed |',
  );
});

test('walk results keep the finishing-register heading', () => {
  const rows: JourneyWalkRow[] = FIRST_PUBLIC_JOURNEYS.map((journey) => ({
    journey: journey.id,
    title: journey.title,
    result: 'FAIL',
    revision: '48f34b7b8910087b3146aad968b8d97201736066',
    utc: '2026-11-07T06:13:14.996Z',
    elapsedSeconds: 466,
    persona: 'setup',
    firstDiffering: {
      command: 'seeded walk setup',
      expected: 'admitted seeded walk setup',
      observed: 'seed-retry exited 1: Import transport request failed',
    },
    evidence: '.temp/commerce-walk/results.json',
    steps: [],
    pages: [...journey.pages],
  }));
  const next = applyWalkResults(
    [
      '## First-public journeys on dev',
      'Latest measured result: **0/26**. Slowest failing path: Offer management (setup, 278s); first differing command `seeded walk setup` / result `seed-retry exited 1: Import transport request failed`.',
      '| Journey | User-visible path | Latest dev walk | Evidence / elapsed |',
      '| Offer management | Creator opens /creator/offers. | FAIL e68f0eb31ddd 2026-11-07T04:46:25.021Z setup | .temp/commerce-walk/results.json 278s; seeded walk setup → seed-retry exited 1: Import transport request failed |',
    ].join('\n'),
    rows,
  );
  expect(next.startsWith('## First-public journeys on dev')).toBe(true);
  expect(next).toContain('FAIL 48f34b7b8910 2026-11-07T06:13:14.996Z setup');
});

test('identity remaining wait returns once topology remaining is zero', async () => {
  const seen: number[] = [];
  await waitUntilIdentityBootstrapRemainingZero(
    async () => {
      seen.push(seen.length === 0 ? 12 : 0);
      return seen.at(-1)!;
    },
    { sleep: async () => {}, ms: 5_000 },
  );
  expect(seen).toEqual([12, 0]);
});

test('identity remaining wait names the last remaining count', async () => {
  let now = 0;
  await expect(
    waitUntilIdentityBootstrapRemainingZero(async () => 17, {
      now: () => (now += 600),
      sleep: async () => {},
      ms: 1_000,
    }),
  ).rejects.toThrow('identity epoch bootstrap not caught up: remaining 17');
});
