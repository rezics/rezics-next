import type { Pool } from 'pg';
import { runCommand, type CommandAuthorization } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { SubjectInputError, type Violation } from './item.ts';
import readVisibility from './read-visibility.sql';

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
    expected?: SubjectVisibilityState;
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
    },
    async (tx, { transactionId }) => {
      const current = (await readVisibility.run(tx, {
        route,
        subject_id: options.subject,
      })) as SubjectVisibilityState | null;
      if (!current) throw new ModerationSubjectNotFoundError();
      if (
        options.expected &&
        (current.visibility !== options.expected.visibility ||
          current.securityRevision !== options.expected.securityRevision)
      )
        throw new ModerationConflictError();

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
      const updated = await tx.query<{ security_revision: string }>(
        `UPDATE semantic.subject
         SET visibility = $3, security_revision = security_revision + 1
         WHERE route = $1 AND subject_id = $2 AND visibility = $4 AND security_revision = $5
         RETURNING security_revision::text AS security_revision`,
        [route, options.subject, nextVisibility, current.visibility, current.securityRevision],
      );
      const revision = updated.rows[0]?.security_revision;
      if (revision === undefined) throw new ModerationConflictError();
      await tx.query(
        `INSERT INTO semantic.moderation
         (route, subject_id, security_revision, action, visibility, actor, body, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          route,
          options.subject,
          revision,
          options.action,
          nextVisibility,
          options.actor.accountId,
          JSON.stringify(body),
          transactionId,
        ],
      );
      const securityRevision = Number(revision);
      return {
        value: { subject: options.subject, visibility: nextVisibility, security_revision: securityRevision },
        events: [
          {
            type: 'com.rezics.subject.visibility_changed.v1',
            subject: options.subject,
            data: { id: options.subject, visibility: nextVisibility, security_revision: securityRevision },
          },
        ],
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}
