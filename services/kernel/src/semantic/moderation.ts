import { jsonParameter } from '../database/json.ts';
import { subjectPageSlot, recordSubjectPageDiff, invalidateSubjectPage } from './subject-page-publication-native.ts';
import type { Pool } from 'pg';
import { currentCommand, runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { readRelease } from './definition-release-read.ts';
import { LINKS_CHANGED, LINKS_VISIBILITY_CHANGED } from './events.ts';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import { factDataTypes, SubjectInputError, type FactRow, type Violation } from './item.ts';
import { holderFacts } from './link-keys.ts';
import { contextLinkChanges, linkChanges } from './link-changes.ts';
import listRelationContexts from './relation-context-list.sql';
import moderationBumpSecurity from './moderation-bump-security.sql';
import moderationDeleteHidden from './moderation-delete-hidden.sql';
import moderationHasLiveCandidate from './moderation-has-live-candidate.sql';
import moderationInsertStatement from './moderation-insert-statement.sql';
import moderationInsertSubject from './moderation-insert-subject.sql';
import moderationReadHidden from './moderation-read-hidden.sql';
import moderationReadLiveCandidate from './moderation-read-live-candidate.sql';
import moderationReadSubject from './moderation-read-subject.sql';
import moderationUpdateVisibility from './moderation-update-visibility.sql';
import moderationUpsertHidden from './moderation-upsert-hidden.sql';
import readRedirect from './read-redirect.sql';
import readVisibility from './read-visibility.sql';
import { recordPrivacyReduction } from './public-filter-source.ts';
import { expandSlot, slotView } from './slots.ts';

export type SubjectVisibility = 'visible' | 'hidden' | 'taken_down';
export type SubjectVisibilityState = { visibility: SubjectVisibility; securityRevision: string };
export type ModerationAction = 'hide' | 'take_down' | 'restore';

export class ModerationConflictError extends Error {}
export class ModerationSubjectNotFoundError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(base: string, part: string): string {
  return `${base}/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validRfc3339(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59)
    return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function validateObject(body: unknown, allowed: string[]): { record: Record<string, unknown>; errors: Violation[] } {
  if (!isRecord(body)) return { record: {}, errors: [{ pointer: '', code: 'invalid_type' }] };
  const errors: Violation[] = [];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ pointer: pointer('', key), code: 'unknown_field' });
  }
  return { record: body, errors };
}

function validateModerationBody(action: ModerationAction, raw: unknown): Record<string, unknown> {
  if (action === 'take_down') {
    const outer = validateObject(raw, ['notice']);
    const errors = [...outer.errors];
    const notice = outer.record.notice;
    if (notice === undefined) errors.push({ pointer: '/notice', code: 'required' });
    else if (!isRecord(notice)) errors.push({ pointer: '/notice', code: 'invalid_type' });
    else {
      for (const key of Object.keys(notice)) {
        if (!['complaint', 'received_at', 'scope'].includes(key))
          errors.push({ pointer: pointer('/notice', key), code: 'unknown_field' });
      }
      for (const field of ['complaint', 'received_at'] as const) {
        const value = notice[field];
        const at = `/notice/${field}`;
        if (value === undefined) errors.push({ pointer: at, code: 'required' });
        else if (typeof value !== 'string') errors.push({ pointer: at, code: 'invalid_type' });
        else if (field === 'complaint') {
          if (characterCount(value) < 1 || characterCount(value) > 2000)
            errors.push({ pointer: at, code: 'out_of_range' });
        } else if (!validRfc3339(value)) errors.push({ pointer: at, code: 'invalid_format' });
      }
      if (notice.scope !== undefined) {
        if (typeof notice.scope !== 'string') errors.push({ pointer: '/notice/scope', code: 'invalid_type' });
        else if (characterCount(notice.scope) > 500) errors.push({ pointer: '/notice/scope', code: 'out_of_range' });
      }
    }
    if (errors.length) throw new SubjectInputError(errors);
    return raw as Record<string, unknown>;
  }

  const outer = validateObject(raw, ['reason']);
  const value = outer.record.reason;
  if (value === undefined) outer.errors.push({ pointer: '/reason', code: 'required' });
  else if (typeof value !== 'string') outer.errors.push({ pointer: '/reason', code: 'invalid_type' });
  else if (characterCount(value) < 1 || characterCount(value) > 500)
    outer.errors.push({ pointer: '/reason', code: 'out_of_range' });
  if (outer.errors.length) throw new SubjectInputError(outer.errors);
  return raw as Record<string, unknown>;
}

export async function readSubjectVisibility(pool: Pool, id: string): Promise<SubjectVisibilityState | null> {
  const route = routeOf(id);
  if (route === null) return null;
  return withConnection(pool, async (client) => {
    return (await readVisibility.run(client, { route, subject_id: id })) as SubjectVisibilityState | null;
  });
}

type ModeratedSubject = SubjectVisibilityState & { revision: number; release: string };

async function readModeratedSubject(
  tx: CommandTransaction,
  route: number,
  subject: string,
): Promise<ModeratedSubject | null> {
  return moderationReadSubject.run(tx, { route, subject_id: subject });
}

async function shownFacts(tx: CommandTransaction, subject: string, property: string, slot: string): Promise<FactRow[]> {
  return (await slotView(tx, subject, property, GLOBAL_CONTEXT, {}, slot)).facts;
}

export async function moderationLinks(
  tx: CommandTransaction,
  subject: string,
  revision: number,
  securityRevision: number,
  releaseDigest: string,
  before: FactRow[],
  after: FactRow[],
  contexts: Map<string, { before: FactRow[]; after: FactRow[] }>,
): Promise<{ type: string; subject: string; data: unknown } | null> {
  if (before.length === 0 && after.length === 0 && contexts.size === 0) return null;
  const release = await readRelease(tx, releaseDigest);
  if (!release) throw new Error('Subject revision release is missing');
  const identity = await holderFacts(tx, subject, release);
  const metadata = { subject, release, type: identity.type, identityFacts: identity.facts };
  const changes = linkChanges(before, after, factDataTypes(release, [...before, ...after]), metadata);
  for (const [context, facts] of contexts)
    changes.push(
      ...contextLinkChanges(
        before,
        facts.before,
        facts.after,
        factDataTypes(release, [...before, ...after, ...facts.before, ...facts.after]),
        metadata,
        context,
        after,
      ),
    );
  if (changes.length === 0) return null;
  return {
    type: LINKS_CHANGED,
    subject,
    data: { subject, revision, security_revision: securityRevision, changes },
  };
}

export async function readStatementCandidate(pool: Pool, subject: string, candidate: string): Promise<boolean> {
  const route = routeOf(subject);
  if (route === null || routeOf(candidate) !== route) return false;
  return withConnection(pool, async (client) => {
    return (
      (await moderationHasLiveCandidate.run(client, { route, subject_id: subject, candidate_id: candidate })) !== null
    );
  });
}

export async function moderateSubject(
  pool: Pool,
  options: {
    actor: AccountActor;
    subject: string;
    action: ModerationAction;
    body: unknown;
    idempotencyKey: string;
    digest: Uint8Array;
    authorization: CommandAuthorization;
    deadline: number;
    clock?: () => Date;
    routeKey?: Uint8Array;
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new ModerationSubjectNotFoundError();
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: `subject.${options.action === 'take_down' ? 'take_down' : options.action}`,
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      const current = await readModeratedSubject(tx, route, options.subject);
      if (!current) throw new ModerationSubjectNotFoundError();

      const nextVisibility: SubjectVisibility =
        options.action === 'hide' ? 'hidden' : options.action === 'take_down' ? 'taken_down' : 'visible';
      const allowed =
        options.action === 'hide'
          ? current.visibility === 'visible'
          : options.action === 'take_down'
            ? current.visibility === 'visible' || current.visibility === 'hidden'
            : current.visibility === 'hidden' || current.visibility === 'taken_down';
      if (!allowed) throw new ModerationConflictError();

      const body = validateModerationBody(options.action, options.body);
      const updated = await moderationUpdateVisibility.run(tx, {
        route,
        subject_id: options.subject,
        visibility: nextVisibility,
        expected_visibility: current.visibility,
        expected_security_revision: current.securityRevision,
      });
      const revision = updated?.security_revision;
      if (revision === undefined) throw new ModerationConflictError();
      await moderationInsertSubject.run(tx, {
        route,
        subject_id: options.subject,
        security_revision: revision,
        action: options.action,
        visibility: nextVisibility,
        actor: options.actor.accountId,
        body: jsonParameter(body),
        transaction_id: transactionId,
      });
      if (nextVisibility !== 'visible')
        await recordPrivacyReduction(tx, {
          partition: partitionOf(route),
          transactionId,
          time: currentCommand(tx).time,
          cause: 'subject',
          affected: [{ kind: 'subject', route, subject: options.subject }],
          impacts: [{ kind: 'subject', route, subject: options.subject }],
        });
      const securityRevision = Number(revision);
      const countDelta =
        current.visibility === 'visible' && nextVisibility !== 'visible'
          ? -1
          : current.visibility !== 'visible' && nextVisibility === 'visible'
            ? 1
            : 0;
      if (countDelta !== 0 && !(await readRedirect.run(tx, { route, subject_id: options.subject })))
        await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(route), delta: countDelta });
      const events: { type: string; subject: string; data: unknown }[] = [
        {
          type: 'com.rezics.subject.visibility_changed.v1',
          subject: options.subject,
          data: { id: options.subject, visibility: nextVisibility, security_revision: securityRevision },
        },
        {
          type: LINKS_VISIBILITY_CHANGED,
          subject: options.subject,
          data: {
            subject: options.subject,
            revision: current.revision,
            security_revision: securityRevision,
            release: current.release,
            visible: nextVisibility === 'visible',
            cursor: [],
          },
        },
      ];
      if ((current.visibility === 'visible') !== (nextVisibility === 'visible'))
        await invalidateSubjectPage(tx, options.subject, transactionId, events);
      return {
        value: { subject: options.subject, visibility: nextVisibility, security_revision: securityRevision },
        events,
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

function nextStatementVisibility(action: ModerationAction): SubjectVisibility {
  return action === 'hide' ? 'hidden' : action === 'take_down' ? 'taken_down' : 'visible';
}

function statementTransition(action: ModerationAction, current: SubjectVisibility): boolean {
  if (action === 'hide') return current === 'visible';
  if (action === 'take_down') return current === 'visible' || current === 'hidden';
  return current === 'hidden' || current === 'taken_down';
}

export async function moderateStatement(
  pool: Pool,
  options: {
    actor: AccountActor;
    subject: string;
    candidate: string;
    action: ModerationAction;
    body: unknown;
    idempotencyKey: string;
    digest: Uint8Array;
    authorization: CommandAuthorization;
    deadline: number;
    clock?: () => Date;
    routeKey?: Uint8Array;
  },
) {
  const route = routeOf(options.subject);
  if (route === null || routeOf(options.candidate) !== route) throw new ModerationSubjectNotFoundError();
  const kind = `statement.${options.action === 'take_down' ? 'take_down' : options.action}`;
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind,
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      const current = await readModeratedSubject(tx, route, options.subject);
      const located = await moderationReadLiveCandidate.run(tx, {
        route,
        subject_id: options.subject,
        candidate_id: options.candidate,
      });
      const property = located?.property;
      const slot = located?.slot_id;
      if (!current || !located || property == null || slot == null) throw new ModerationSubjectNotFoundError();
      const hidden = await moderationReadHidden.run(tx, {
        route,
        subject_id: options.subject,
        candidate_id: options.candidate,
      });
      const currentVisibility: SubjectVisibility = hidden?.visibility ?? 'visible';
      if (!statementTransition(options.action, currentVisibility)) throw new ModerationConflictError();
      const body = validateModerationBody(options.action, options.body);
      const nextVisibility = nextStatementVisibility(options.action);
      const publicationRelease = await readRelease(tx, current.release);
      if (!publicationRelease) throw new Error('Subject release is missing');
      const publicationBefore =
        current.visibility === 'visible'
          ? await subjectPageSlot(tx, options.subject, property, slot, publicationRelease, options.routeKey)
          : new Map();
      const before = current.visibility === 'visible' ? await shownFacts(tx, options.subject, property, slot) : [];
      const contexts = new Map<string, { before: FactRow[]; after: FactRow[] }>();
      if (located.relation && current.visibility === 'visible')
        for (const { context_id } of await listRelationContexts.run(tx, {
          route,
          subject_id: options.subject,
          slot_id: slot,
        }))
          contexts.set(context_id, {
            before: (await slotView(tx, options.subject, property, context_id, {}, slot)).facts,
            after: [],
          });
      await expandSlot(tx, options.subject, property, transactionId, slot, located.relation);
      const updated = await moderationBumpSecurity.run(tx, {
        route,
        subject_id: options.subject,
        expected_security_revision: current.securityRevision,
      });
      const revision = updated?.security_revision;
      if (revision === undefined) throw new ModerationConflictError();
      await moderationInsertStatement.run(tx, {
        route,
        subject_id: options.subject,
        security_revision: revision,
        action: options.action,
        visibility: nextVisibility,
        actor: options.actor.accountId,
        body: jsonParameter(body),
        transaction_id: transactionId,
        candidate_id: options.candidate,
      });
      if (nextVisibility === 'visible') {
        await moderationDeleteHidden.run(tx, {
          route,
          subject_id: options.subject,
          candidate_id: options.candidate,
        });
      } else {
        await moderationUpsertHidden.run(tx, {
          route,
          subject_id: options.subject,
          candidate_id: options.candidate,
          visibility: nextVisibility,
          security_revision: revision,
        });
        await recordPrivacyReduction(tx, {
          partition: partitionOf(route),
          transactionId,
          time: currentCommand(tx).time,
          cause: 'candidate',
          affected: [{ kind: 'selection', route, subject: options.subject, slot, candidate: options.candidate }],
          impacts: [{ kind: 'keys', route, subject: options.subject, keys: [{ kind: 'property', property }] }],
        });
      }
      const securityRevision = Number(revision);
      const after = current.visibility === 'visible' ? await shownFacts(tx, options.subject, property, slot) : [];
      for (const [context, facts] of contexts)
        facts.after = (await slotView(tx, options.subject, property, context, {}, slot)).facts;
      const events: { type: string; subject: string; data: unknown }[] = [
        {
          type: 'com.rezics.subject.statement_visibility_changed.v1',
          subject: options.subject,
          data: {
            id: options.subject,
            candidate: options.candidate,
            visibility: nextVisibility,
            security_revision: securityRevision,
          },
        },
      ];
      const links = await moderationLinks(
        tx,
        options.subject,
        current.revision,
        securityRevision,
        current.release,
        before,
        after,
        contexts,
      );
      if (links) events.push(links);
      await recordSubjectPageDiff(
        tx,
        options.subject,
        transactionId,
        publicationBefore,
        current.visibility === 'visible'
          ? await subjectPageSlot(tx, options.subject, property, slot, publicationRelease, options.routeKey)
          : new Map(),
        events,
      );
      return {
        value: {
          subject: options.subject,
          candidate: options.candidate,
          visibility: nextVisibility,
          security_revision: securityRevision,
        },
        events,
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}
