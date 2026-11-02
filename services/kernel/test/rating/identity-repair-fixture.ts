import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  currentCommand,
  type CommandTransaction,
} from "../../src/command/command.ts";
import { createRatingIdentityRepairCommands } from "../../src/rating/identity-repair.ts";
import type {
  IdentityRepairPage,
  IdentityWorkRef,
} from "../../src/rating/identity-work-frame.ts";
import type { RatingIdentityProducer } from "../../src/rating/segment-identity-guard.ts";
import { STANDARD_QUESTION_ID } from "../../src/rating/votes.ts";
import type { AccountActor } from "../../src/request/access.ts";
import { newId } from "../../src/route/route.ts";
import { type GrowthDatabase } from "../support/growth.ts";

export const route = 0x3a07;
export const at = "2026-11-03T08:00:00Z";

// Shared outcome fixtures; the injected producer proves only Rating's native transaction/page seam.
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
      kind: "account",
      accountId,
      scopes: ["rating:vote"],
      clientId: "identity-repair-test",
      requestedBy: null,
      authnEpoch: 1,
    };
  }
  async function seed(
    actor: AccountActor,
    targetId: string,
    units: number | null = 7,
  ) {
    await getDatabase().admin.query(
      `INSERT INTO rating.vote
      (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [
        route,
        actor.accountId,
        STANDARD_QUESTION_ID,
        targetId,
        units,
        at,
        newId(route),
      ],
    );
  }
  function producer(destination: (original: string) => string = (id) => id) {
    let handoff = true;
    let pending = "";
    const held = new WeakSet<CommandTransaction>();
    const port: RatingIdentityProducer = {
      async hold(tx, page) {
        expect(currentCommand(tx).transactionId).toBeTruthy();
        held.add(tx);
        if (pending) return { status: "pending", reason: pending };
        return {
          status: "current",
          obligationId: "fixture-retained-obligation",
          mappings: [...new Set(page.votes.map((vote) => vote.targetId))].map(
            (originalId) => ({
              originalId,
              terminalId: destination(originalId),
              epoch: "1",
            }),
          ),
        };
      },
      async complete(tx, input) {
        expect(held.has(tx)).toBe(true);
        expect(currentCommand(tx).transactionId).toBe(input.transactionId);
        const receipt = await tx.query(
          "SELECT transaction_id FROM rating.identity_repair_receipt WHERE page_id = $1",
          [input.page.pageId],
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
      setPending: (value: string) => {
        pending = value;
      },
    };
  }
  type Commands = ReturnType<typeof createRatingIdentityRepairCommands>;
  async function admit(
    commands: Commands,
    actor: AccountActor,
  ): Promise<IdentityWorkRef> {
    const result = (
      await commands.admit(
        actor,
        { workId: newId(route), expectedGeneration: null },
        key(),
      )
    ).value;
    if (result.status !== "admitted") throw new Error(result.reason);
    return { workId: result.frame.workId, generation: result.frame.generation };
  }
  async function select(
    commands: Commands,
    actor: AccountActor,
    ref: IdentityWorkRef,
  ): Promise<IdentityRepairPage> {
    const result = (await commands.select(actor, ref, key())).value;
    if (result.status !== "selected") throw new Error(result.reason);
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

  return { key, voter, seed, producer, admit, select, binding, rows, effects };
}
