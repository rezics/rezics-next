import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
// Load the same permanent kind bindings even when Stripe is unconfigured.
import './erasure-history.ts';
import account from './erasure-account.sql';
import obligation from './erasure-obligation.sql';
import proof from './erasure-proof.sql';
import initialize from './erasure-progress.sql';
import read from './erasure-read.sql';
import page from './erasure-page.sql';
import purge from './erasure-purge.sql';
import purgeSales from './erasure-creator-sales.sql';
import checkpoint from './erasure-checkpoint.sql';
import { readHistoryOwnerCoverage } from '../history/application/index.ts';

export const COMMERCE_ERASURE_WORKFLOW = 'commerce.eraseAccount';
export const commerceErasureWorkflowId = (accountId: string) => `commerce:erasure:${accountId}:v1`;
export const FINANCIAL_ERASURE_BLOCKER =
  'Financial field/purpose/jurisdiction/expiry schedule; receipt/outbox/write-basis and DBOS minimizers; ' +
  'delegation/operator historical locators; Stripe Session/PaymentIntent/Charge/Product/refund custody and backup expiry unresolved';

export const COMMERCE_CUSTODY_BLOCKER =
  'UNKNOWN: Commerce command/outbox/durable producer conversion and receiving custody; ' +
  'write-basis/operational intent minimizers; foreign seller/creator locators and sealed coverage';

/** One committed, bounded page. No initiator, provider call, callback proof or fabricated Actor. */
export async function advanceCommerceErasure(pool: Pool, accountId: string): Promise<'none' | 'more' | 'pending'> {
  const route = routeOf(accountId);
  if (route === null) throw new Error('Invalid commerce erasure account');
  const key = { route, account_id: accountId };
  const result = await runCommand<'none' | 'more' | 'pending'>(
    pool,
    {
      partition: partitionOf(route),
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'internal-commerce-erasure',
        requestedBy: null,
      },
    },
    async (tx) => {
      const current = await account.run(tx, key);
      const barrier = await obligation.run(tx, key);
      if (current?.state !== 'deleted' || barrier?.version !== 1)
        throw new Error('Commerce erasure requires the committed native version 1 tombstone');
      const found = await proof.run(tx, key);
      if (!found) throw new Error('Commerce native ownership proof unavailable');
      await initialize.run(tx, { ...key, had_data: found.hasData });
      const progress = await read.run(tx, key);
      if (!progress) throw new Error('Commerce erasure progress unavailable');
      // Projection cleanup also runs for already-pending financial accounts. It cannot ACK
      // foreign/source receipt or shared work custody, which remains an exact obligation.
      const removedSales = await purgeSales.run(tx, key);
      if (removedSales.length)
        return {
          value: 'more' as const,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };
      // Terminal progress never reopens; the coordinator acknowledgement is also immutable.
      if (progress.phase === 'pending') return noEffect('pending' as const);
      const keys = await page.run(tx, { ...key, after: progress.cursor });
      if (keys.length) await purge.run(tx, { ...key, ids: keys.map((row) => row.id) });
      // These are local positive observations, never proof of foreign/shared absence.
      // No acknowledgement is possible until the real producer supplies sealed coverage.
      const phase = keys.length === 100 ? 'entitlements' : 'pending';
      await checkpoint.run(tx, {
        ...key,
        cursor: keys.at(-1)?.id ?? progress.cursor,
        phase,
        blocker: phase === 'pending' ? (progress.hadData ? FINANCIAL_ERASURE_BLOCKER : COMMERCE_CUSTODY_BLOCKER) : '',
      });
      // Progress, physical purge and effect commit together. No payload is copied into progress.
      return {
        value: phase === 'entitlements' ? ('more' as const) : phase,
        events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
      };
    },
  );
  // Local cleanup commits and releases its home before asking the real receiving
  // runtime. Its registry/progress gaps are evidence of unavailability, never none.
  if (result.value === 'pending') {
    const barrier = await withConnection(pool, (client) => obligation.run(client, key));
    if (!barrier || barrier.version !== 1)
      throw new Error('Commerce erasure requires the committed native version 1 tombstone');
    const coverage = await readHistoryOwnerCoverage(
      { pool },
      { accountId, accountRoute: route, version: barrier.version, at: barrier.at },
      'commerce',
      { deadline: Date.now() + 5_000 },
    );
    // Even complete shared coverage would not discharge Commerce's foreign
    // financial-role inventory or its undecided lawful field/expiry policy.
    const blocker =
      COMMERCE_CUSTODY_BLOCKER + (coverage.state === 'pending' ? `; shared-history: ${coverage.gaps.join(',')}` : '');
    await runCommand(
      pool,
      {
        partition: partitionOf(route),
        basis: {
          actorAccountId: '00000000-0000-8000-8000-000000000001',
          clientId: 'internal-commerce-erasure',
          requestedBy: null,
        },
      },
      async (tx) => {
        const current = await account.run(tx, key);
        if (current?.state !== 'deleted') throw new Error('Commerce erasure requires the committed native tombstone');
        const progress = await read.run(tx, key);
        if (!progress) throw new Error('Commerce erasure progress unavailable');
        if (progress.hadData || progress.phase !== 'pending' || progress.blocker === blocker) return noEffect(null);
        await checkpoint.run(tx, { ...key, cursor: progress.cursor, phase: 'pending', blocker });
        return {
          value: null,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };
      },
    );
  }
  return result.value;
}

export function registerCommerceErasure({ pool, client, addEffects }: WorkContext) {
  const advance = DBOS.registerStep((accountId: string) => advanceCommerceErasure(pool, accountId), {
    name: 'commerce.erasure.advance',
    retriesAllowed: true,
    maxAttempts: 5,
    intervalSeconds: 1,
  });
  DBOS.registerWorkflow(
    async (accountId: string) => {
      let state = await advance(accountId);
      while (state === 'more') state = await advance(accountId);
      // Dispatch and entitlement exhaustion cannot attest full-role/custody absence.
      // The missing owner-home proof must be delivered before an ACK path can be enabled.
    },
    { name: COMMERCE_ERASURE_WORKFLOW },
  );
  addEffects([
    {
      name: 'commerce_erasure',
      types: ['com.rezics.access.account-tombstoned.v1'],
      async run(event) {
        const { accountId } = event.data as { accountId: string };
        await client.enqueue(
          {
            workflowName: COMMERCE_ERASURE_WORKFLOW,
            workflowID: commerceErasureWorkflowId(accountId),
            workflowIDReusePolicy: 'return-existing',
            queueName: 'workflows',
          },
          accountId,
        );
      },
    },
  ]);
}
