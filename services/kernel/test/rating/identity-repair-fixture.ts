import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { currentCommand, type CommandEvent, type CommandTransaction } from '../../src/command/command.ts';
import { IDENTITY_REPAIR_MEMBERSHIP_CAP } from '../../src/rating/identity-repair-bounds.ts';
import { createRatingIdentityRepairCommands } from '../../src/rating/identity-repair.ts';
import type { IdentityRepairPage, IdentityWorkRef } from '../../src/rating/identity-work-frame.ts';
import {
  IDENTITY_REPAIR_CROSS_HOME_REASON,
  type RatingIdentityProducer,
} from '../../src/rating/segment-identity-guard.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { IDENTITY_RATING_REPAIR_CONTINUATION } from '../../src/semantic/events.ts';
import { type GrowthDatabase } from '../support/growth.ts';

export const route = 0x3a07;
export const at = '2026-11-03T08:00:00Z';

// Injected producer proves Rating's transaction/page seam. Installed Semantic hold/complete is identity-repair-native.test.ts.
export function ratingIdentityFixture(getDatabase: () => GrowthDatabase) {
  const key = () => randomUUID();

  async function voter(): Promise<AccountActor> {
    const accountId = newId(route);
    await getDatabase().admin.query(
      `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
      VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
      [route, accountId, newId(route)],
    );
    return {
      kind: 'account',
      accountId,
      scopes: ['rating:vote'],
      clientId: 'identity-repair-test',
      requestedBy: null,
      authnEpoch: 1,
    };
  }
  async function seed(actor: AccountActor, targetId: string, units: number | null = 7) {
    await getDatabase().admin.query(
      `INSERT INTO rating.vote
      (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [route, actor.accountId, STANDARD_QUESTION_ID, targetId, units, at, newId(route)],
    );
  }
  async function seedMemberships(actor: AccountActor, count = IDENTITY_REPAIR_MEMBERSHIP_CAP) {
    const ids = Array.from({ length: count }, () => newId(route));
    await getDatabase().admin.query(
      `INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state)
       SELECT $1, $2, id, $3::timestamptz, 'counted' FROM unnest($4::uuid[]) id`,
      [route, actor.accountId, at, ids],
    );
    return ids;
  }
  function continuation(page: IdentityRepairPage, obligationId: string): CommandEvent {
    return {
      type: IDENTITY_RATING_REPAIR_CONTINUATION,
      data: {
        partition: partitionOf(route),
        voterPartition: partitionOf(route),
        obligationId,
        kind: 'prepare',
        originals: page.votes.map((vote) => vote.targetId),
      },
    };
  }
  function producer(destination: (original: string) => string = (id) => id) {
    let handoff = true;
    let pending = '';
    let pendingEvents = false;
    const held = new WeakSet<CommandTransaction>();
    const port: RatingIdentityProducer = {
      async hold(tx, page) {
        expect(currentCommand(tx).transactionId).toBeTruthy();
        held.add(tx);
        if (pending) {
          if (!pendingEvents) return { status: 'pending', reason: pending };
          const obligationId = newId(route);
          return {
            status: 'pending',
            reason: pending === '' ? IDENTITY_REPAIR_CROSS_HOME_REASON : pending,
            obligationId,
            events: [continuation(page, obligationId)],
          };
        }
        return {
          status: 'current',
          obligationId: 'fixture-retained-obligation',
          mappings: [...new Set(page.votes.map((vote) => vote.targetId))].map((originalId) => ({
            originalId,
            terminalId: destination(originalId),
            epoch: '1',
          })),
        };
      },
      async complete(tx, input) {
        expect(held.has(tx)).toBe(true);
        expect(currentCommand(tx).transactionId).toBe(input.transactionId);
        const receipt = await tx.query(
          'SELECT transaction_id FROM rating.identity_repair_receipt WHERE route = $1 AND voter_id = $2 AND page_id = $3',
          [route, input.page.voterId, input.page.pageId],
        );
        expect(receipt.rows[0]?.transaction_id).toBe(input.transactionId);
        return handoff;
      },
    };
    return {
      port,
      setHandoff: (value: boolean) => {
        handoff = value;
      },
      setPending: (value: string, events = false) => {
        pending = value;
        pendingEvents = events;
      },
    };
  }
  type Commands = ReturnType<typeof createRatingIdentityRepairCommands>;
  async function admit(commands: Commands, actor: AccountActor): Promise<IdentityWorkRef> {
    const result = (await commands.admit(actor, { workId: newId(route), expectedGeneration: null }, key())).value;
    if (result.status !== 'admitted') throw new Error(result.reason);
    return { workId: result.frame.workId, generation: result.frame.generation };
  }
  async function select(commands: Commands, actor: AccountActor, ref: IdentityWorkRef): Promise<IdentityRepairPage> {
    const result = (await commands.select(actor, ref, key())).value;
    if (result.status !== 'selected') throw new Error(result.reason);
    return result.page;
  }
  const binding = (page: IdentityRepairPage) => ({
    workId: page.workId,
    generation: page.generation,
    pageId: page.pageId,
    digest: page.digest,
  });
  async function rows(actor: AccountActor) {
    return (
      await getDatabase().admin.query(
        `SELECT target_id, counted_target, units, revision, counted_revision
      FROM rating.vote WHERE route = $1 AND voter_id = $2 ORDER BY target_id`,
        [route, actor.accountId],
      )
    ).rows;
  }
  async function effects(actor: AccountActor) {
    return (
      await getDatabase().admin.query(
        `SELECT data FROM core.outbox
      WHERE subject = $1 AND type = 'com.rezics.rating.vote.changed.v1' ORDER BY position, event_seq`,
        [actor.accountId],
      )
    ).rows.map((row) => row.data);
  }
  async function continuations() {
    return (
      await getDatabase().admin.query(`SELECT data FROM core.outbox WHERE type = $1 ORDER BY position, event_seq`, [
        IDENTITY_RATING_REPAIR_CONTINUATION,
      ])
    ).rows.map((row) => row.data);
  }

  return { key, voter, seed, seedMemberships, producer, admit, select, binding, rows, effects, continuations };
}
