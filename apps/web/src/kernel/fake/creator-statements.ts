import type { CreatorStatement, CreatorStatementLine } from '../../checkout/creator-statements';
import type { FakeRoute } from '../fake-modules';

// Contract-shaped story responses only; these do not establish native authorization or payment evidence.
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const creatorStatementFixture: CreatorStatement = {
  id: id(3),
  creatorAccountId: id(20),
  period: '2026-10',
  currency: 'usd',
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

export type CreatorStatementStory =
  | 'creator'
  | 'empty'
  | 'denied'
  | 'unavailable'
  | 'error'
  | 'stale'
  | 'lines-unavailable';
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
      if (!statementId)
        return {
          status: 200,
          payoutStatements:
            selected === 'empty'
              ? []
              : url.searchParams.has('cursor')
                ? [paidCreatorStatementFixture]
                : [creatorStatementFixture, euro],
          next: selected === 'empty' || url.searchParams.has('cursor') ? null : 'story-statements-next',
        };
      const statement = [creatorStatementFixture, euro, paidCreatorStatementFixture].find(
        (row) => row.id === statementId,
      );
      if (!statement) return { status: 404, code: 'not_found' };
      if (!match?.[2]) return { status: 200, statement };
      if (selected === 'lines-unavailable') return { status: 503, code: 'overloaded' };
      const line = {
        ...creatorLineFixture,
        statementId,
        currency: statement.currency,
        period: statement.period,
        ...(statement.state === 'paid' ? { recordedAt: '2026-09-30T23:31:00Z' } : {}),
      };
      return {
        status: 200,
        lines:
          selected === 'empty'
            ? []
            : url.searchParams.has('cursor')
              ? [{ ...refund, statementId, currency: statement.currency, period: statement.period }]
              : [line],
        next:
          selected === 'empty' ||
          statement.state === 'paid' ||
          statement.currency === 'eur' ||
          url.searchParams.has('cursor')
            ? null
            : 'story-lines-next',
      };
    },
  },
];
