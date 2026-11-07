import type { Pool } from 'pg';
import { requestDigest } from '../http/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { noEffect, runCommand, type CommandAuthorization, type CommandEvent } from '../command/command.ts';
import type { AccountActor, Resource } from '../request/access.ts';
import { subjectPageSlot, recordSubjectPageDiff } from './subject-page-publication-native.ts';
import { expandSlot, slotView } from './slots.ts';
import { moderationLinks } from './moderation.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { readRelease } from './definition-release-read.ts';
import { redirectOf } from './subject-redirect.ts';
import { writeContributionRetentionLifecycle } from './retention-lifecycle.ts';
import readSubject from './moderation-read-subject.sql';
import readState from './contribution-lifecycle-read-state.sql';
import bumpSecurity from './moderation-bump-security.sql';
import listRelationContexts from './relation-context-list.sql';
import { RECORD_DELETED, RECORD_RESTORED } from './events.ts';
import { revisionResource } from './authorship.ts';
import readLocator from './contribution-lifecycle-read-locator.sql';

export class ContributionLifecycleNotFoundError extends Error {
  constructor() {
    super('Contribution not found');
    this.name = 'ContributionLifecycleNotFoundError';
  }
}
export class ContributionLifecycleConflictError extends Error {
  constructor() {
    super('Contribution lifecycle conflict');
    this.name = 'ContributionLifecycleConflictError';
  }
}

export type ContributionLifecycleResult = {
  subject: string;
  candidate: string;
  deleted: boolean;
  component: { partition: number; epoch: number; position: bigint };
  replayed: boolean;
};

export class SubjectPagePublicationUnavailableError extends Error {
  constructor() {
    super('Subject page publication transition is unavailable');
    this.name = 'SubjectPagePublicationUnavailableError';
  }
}

async function changeContribution(
  pool: Pool,
  input: {
    subject: string;
    candidate: string;
    actor: AccountActor;
    idempotencyKey: string;
    action: 'delete' | 'restore';
    authorization: CommandAuthorization;
    deadline: number;
    clock?: () => Date;
    routeKey: Uint8Array;
  },
): Promise<ContributionLifecycleResult> {
  const route = routeOf(input.subject);
  if (route === null || routeOf(input.candidate) !== route) throw new ContributionLifecycleNotFoundError();
  const kind = input.action === 'delete' ? 'semantic.contribution.delete' : 'semantic.contribution.restore';
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: input.deadline,
      clock: input.clock,
      authorization: input.authorization,
      basis: {
        actorAccountId: input.actor.accountId,
        clientId: input.actor.clientId,
        requestedBy: input.actor.requestedBy,
      },
      receipt: {
        actorAccountId: input.actor.accountId,
        kind,
        key: input.idempotencyKey,
        digest: requestDigest(kind, input.actor, { subject: input.subject, candidate: input.candidate }),
      },
    },
    async (tx, { transactionId }) => {
      const located = await readLocator.run(tx, { route, subject_id: input.subject, candidate_id: input.candidate });
      if (!located || located.property === null || located.slot_id === null)
        throw new ContributionLifecycleNotFoundError();
      const current = await readSubject.run(tx, { route, subject_id: input.subject });
      if (!current || current.visibility !== 'visible' || (await redirectOf(tx, input.subject)))
        throw new ContributionLifecycleNotFoundError();
      const state = await readState.run(tx, { route, subject_id: input.subject, candidate_id: input.candidate });
      if (input.action === 'delete' && state?.state === 'deleted')
        return noEffect({ subject: input.subject, candidate: input.candidate, deleted: true });
      if (input.action === 'restore' && state?.state !== 'deleted') throw new ContributionLifecycleConflictError();
      const release = await readRelease(tx, current.release);
      if (!release) throw new Error('Subject release is missing');
      const publicationBefore = await subjectPageSlot(
        tx,
        input.subject,
        located.property,
        located.slot_id,
        release,
        input.routeKey,
      );
      const before = (await slotView(tx, input.subject, located.property, GLOBAL_CONTEXT, {}, located.slot_id)).facts;
      const contexts = new Map<string, { before: typeof before; after: typeof before }>();
      if (located.relation)
        for (const { context_id } of await listRelationContexts.run(tx, {
          route,
          subject_id: input.subject,
          slot_id: located.slot_id,
        }))
          contexts.set(context_id, {
            before: (await slotView(tx, input.subject, located.property, context_id, {}, located.slot_id)).facts,
            after: [],
          });
      // Physical expansion preserves each original assertion's revision, acceptance and selection.
      await expandSlot(tx, input.subject, located.property, transactionId, located.slot_id, located.relation);
      try {
        if (
          !(await writeContributionRetentionLifecycle(tx, {
            subject: input.subject,
            candidate: input.candidate,
            state: input.action === 'delete' ? 'deleted' : 'active',
            transactionId,
          }))
        )
          throw new ContributionLifecycleConflictError();
      } catch (error) {
        if (error instanceof Error && ['record_restore_expired', 'record_lifecycle_changed'].includes(error.message))
          throw new ContributionLifecycleConflictError();
        throw error;
      }
      const row = await readState.run(tx, { route, subject_id: input.subject, candidate_id: input.candidate });
      if (!row) throw new ContributionLifecycleConflictError();
      const updated = await bumpSecurity.run(tx, {
        route,
        subject_id: input.subject,
        expected_security_revision: current.securityRevision,
      });
      if (!updated) throw new ContributionLifecycleConflictError();
      const after = (await slotView(tx, input.subject, located.property, GLOBAL_CONTEXT, {}, located.slot_id)).facts;
      for (const [context, facts] of contexts)
        facts.after = (await slotView(tx, input.subject, located.property, context, {}, located.slot_id)).facts;
      const event: CommandEvent = {
        type: input.action === 'delete' ? RECORD_DELETED : RECORD_RESTORED,
        subject: input.subject,
        data: {
          kind: 'candidate',
          id: input.candidate,
          subject: input.subject,
          version: String(row.security_revision),
          deletedAt: row.deleted_at,
          purgeAfter: row.purge_after,
        },
      };
      const events: CommandEvent[] = [event];
      const links = await moderationLinks(
        tx,
        input.subject,
        current.revision,
        Number(updated.security_revision),
        current.release,
        before,
        after,
        contexts,
      );
      if (links) events.push(links);
      await recordSubjectPageDiff(
        tx,
        input.subject,
        transactionId,
        publicationBefore,
        await subjectPageSlot(tx, input.subject, located.property, located.slot_id, release, input.routeKey),
        events,
      );
      return {
        value: { subject: input.subject, candidate: input.candidate, deleted: input.action === 'delete' },
        events,
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

export function deleteContribution(pool: Pool, input: Omit<Parameters<typeof changeContribution>[1], 'action'>) {
  return changeContribution(pool, { ...input, action: 'delete' });
}

export function restoreContribution(pool: Pool, input: Omit<Parameters<typeof changeContribution>[1], 'action'>) {
  return changeContribution(pool, { ...input, action: 'restore' });
}

export function contributionAuthorResource(subject: string, revision: number): Resource {
  const route = routeOf(subject);
  if (route === null) throw new ContributionLifecycleNotFoundError();
  return revisionResource(subject, revision);
}
