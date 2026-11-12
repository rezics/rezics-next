import { expect, test } from 'bun:test';
import {
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
