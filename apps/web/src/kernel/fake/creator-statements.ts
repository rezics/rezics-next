import type { CreatorStatement, CreatorStatementLine } from '../../checkout/creator-statements';
import type { FakeRoute } from '../fake-modules';

// Contract-shaped story responses only; these do not establish native authorization or payment evidence.
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const capturedMoneyUnit = { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' } as const;
export const creatorStatementFixture: CreatorStatement = {
  id: id(3),
  creatorAccountId: id(20),
  period: '2026-10',
  currency: 'usd',
  moneyUnit: capturedMoneyUnit,
  grossMinor: -200,
  taxMinor: 100,
  feeMinor: 50,
  disputeFeeMinor: 0,
  refundsMinor: -1200,
  chargebacksMinor: 0,
  netReceiptsMinor: -350,
  creatorShareMinor: -315,
  rezicsShareMinor: -35,
  weightedNetMinor: '-3150000',
  state: 'open',
  paidAt: null,
  paidReference: null,
  revision: 2,
};
export const paidCreatorStatementFixture: CreatorStatement = {
  ...creatorStatementFixture,
  id: id(1),
  period: '2026-09',
  grossMinor: 1000,
  taxMinor: 200,
  refundsMinor: 0,
  netReceiptsMinor: 750,
  creatorShareMinor: 675,
  rezicsShareMinor: 75,
  weightedNetMinor: '6750000',
  state: 'paid',
  paidAt: '2026-10-04T09:00:00Z',
  paidReference: 'External bank reference • 2026-09 / USD',
  revision: 3,
};
const euro: CreatorStatement = {
  ...paidCreatorStatementFixture,
  id: id(2),
  period: '2026-10',
  currency: 'eur',
  state: 'open',
  paidAt: null,
  paidReference: null,
};
export const creatorLineFixture: CreatorStatementLine = {
  balanceTransactionId: 'txn_creatorCharge',
  orderId: id(30),
  offerId: id(40),
  creatorAccountId: creatorStatementFixture.creatorAccountId,
  statementId: creatorStatementFixture.id,
  currency: 'usd',
  moneyUnit: capturedMoneyUnit,
  kind: 'charge',
  created: '2026-09-30T23:30:00Z',
  recordedAt: '2026-10-01T00:01:00Z',
  period: '2026-10',
  grossMinor: 1000,
  taxMinor: 200,
  feeMinor: 50,
  disputeFeeMinor: 0,
  netReceiptsMinor: 750,
  royaltyBasisPoints: 9000,
};
const refund: CreatorStatementLine = {
  ...creatorLineFixture,
  balanceTransactionId: 'txn_creatorRefund',
  kind: 'refund',
  created: '2026-10-06T12:00:00Z',
  recordedAt: '2026-10-06T12:01:00Z',
  grossMinor: -1200,
  taxMinor: -100,
  feeMinor: 0,
  netReceiptsMinor: -1100,
};

// Historical evidence has no recorded unit. Keep its captured amounts and external-payment meaning.
export const historicalCreatorStatementFixture: CreatorStatement = {
  ...paidCreatorStatementFixture,
  id: id(4),
  period: '2025-09',
  moneyUnit: null,
  paidAt: '2025-10-04T09:00:00Z',
  paidReference: 'External bank reference • 2025-09 / USD',
};
export const historicalCreatorLineFixture: CreatorStatementLine = {
  ...creatorLineFixture,
  statementId: historicalCreatorStatementFixture.id,
  period: historicalCreatorStatementFixture.period,
  created: '2025-09-30T23:30:00Z',
  recordedAt: '2025-09-30T23:31:00Z',
  moneyUnit: null,
};

export type CreatorStatementStory =
  | 'creator'
  | 'unknown-unit'
  | 'empty'
  | 'later-empty'
  | 'denied'
  | 'unavailable'
  | 'error'
  | 'stale'
  | 'lines-unavailable'
  | 'later-stale-lines'
  | 'later-empty-lines';
let selected: CreatorStatementStory = 'creator';
export function selectCreatorStatementStory(value: CreatorStatementStory): void {
  selected = value;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/payoutStatements(?:\/([^/]+)(\/lines)?)?$/,
    story: ({ request, match }) => {
      if (selected === 'denied') return { status: 404, code: 'not_found' };
      if (selected === 'unavailable') return { status: 503, code: 'overloaded' };
      if (selected === 'error') return { status: 400, code: 'invalid_cursor' };
      if (selected === 'stale') return { status: 409, code: 'stale_cursor' };
      const url = new URL(request.url);
      const statementId = match?.[1];
      const later = url.searchParams.has('cursor');
      if (!statementId) {
        if (selected === 'later-empty')
          return {
            status: 200,
            payoutStatements: later ? [] : [creatorStatementFixture, euro],
            next: later ? 'story-statements-later' : 'story-statements-next',
          };
        return {
          status: 200,
          payoutStatements:
            selected === 'empty'
              ? []
              : selected === 'unknown-unit'
                ? [historicalCreatorStatementFixture]
                : later
                  ? [paidCreatorStatementFixture]
                  : [creatorStatementFixture, euro],
          next:
            selected === 'empty' || selected === 'unknown-unit' || later ? null : 'story-statements-next',
        };
      }
      const statements =
        selected === 'unknown-unit'
          ? [historicalCreatorStatementFixture]
          : [creatorStatementFixture, euro, paidCreatorStatementFixture];
      const statement = statements.find((row) => row.id === statementId);
      if (!statement) return { status: 404, code: 'not_found' };
      if (!match?.[2]) return { status: 200, statement };
      if (selected === 'lines-unavailable') return { status: 503, code: 'overloaded' };
      if (selected === 'later-stale-lines' && later) return { status: 409, code: 'stale_cursor' };
      if (selected === 'later-empty-lines' && later) return { status: 200, lines: [], next: null };
      const laterLinePage = selected === 'later-stale-lines' || selected === 'later-empty-lines';
      const line = {
        ...(selected === 'unknown-unit' ? historicalCreatorLineFixture : creatorLineFixture),
        statementId,
        currency: statement.currency,
        period: statement.period,
        ...(statement.id === paidCreatorStatementFixture.id ? { recordedAt: '2026-09-30T23:31:00Z' } : {}),
      };
      return {
        status: 200,
        lines:
          selected === 'empty'
            ? []
            : selected === 'unknown-unit'
              ? [line]
              : later
                ? [
                    {
                      ...refund,
                      statementId,
                      currency: statement.currency,
                      period: statement.period,
                      moneyUnit: line.moneyUnit,
                    },
                  ]
                : [line],
        next:
          selected === 'empty' ||
          later ||
          (!laterLinePage && (statement.state === 'paid' || statement.currency === 'eur'))
            ? null
            : 'story-lines-next',
      };
    },
  },
];
