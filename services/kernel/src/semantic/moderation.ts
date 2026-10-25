import type { Pool } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readRelease } from './definitions.ts';
import { LINKS_CHANGED } from './events.ts';
import { factDataTypes, SubjectInputError, type FactRow, type Violation } from './item.ts';
import { linkChanges } from './link-changes.ts';
import readVisibility from './read-visibility.sql';
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
  const result = await tx.query<ModeratedSubject>(
    `SELECT s.visibility, s.security_revision::text AS "securityRevision", latest.revision, latest.release
     FROM semantic.subject s
     JOIN LATERAL (
       SELECT revision, release FROM semantic.revision
       WHERE route = s.route AND subject_id = s.subject_id
       ORDER BY revision DESC LIMIT 1
     ) latest ON true
     WHERE s.route = $1 AND s.subject_id = $2`,
    [route, subject],
  );
  return result.rows[0] ?? null;
}

async function shownFacts(tx: CommandTransaction, subject: string, property?: string): Promise<FactRow[]> {
  const properties = property
    ? [property]
    : (
        await tx.query<{ property: string }>(
          `SELECT DISTINCT property FROM semantic.fact
           WHERE route = $1 AND subject_id = $2 AND kind = 'statement' AND property IS NOT NULL`,
          [routeOf(subject), subject],
        )
      ).rows.map((row) => row.property);
  const facts: FactRow[] = [];
  for (const name of properties) facts.push(...(await slotView(tx, subject, name)).facts);
  return facts;
}

async function moderationLinks(
  tx: CommandTransaction,
  subject: string,
  revision: number,
  securityRevision: number,
  releaseDigest: string,
  before: FactRow[],
  after: FactRow[],
): Promise<{ type: string; subject: string; data: unknown } | null> {
  if (before.length === 0 && after.length === 0) return null;
  const release = await readRelease(tx, releaseDigest);
  if (!release) throw new Error('Subject revision release is missing');
  const changes = linkChanges(before, after, factDataTypes(release, [...before, ...after]));
  if (changes.length === 0) return null;
  return {
    type: LINKS_CHANGED,
    subject,
    data: { subject, revision, security_revision: securityRevision, changes },
  };
}

const LIVE_CANDIDATE = `SELECT property FROM semantic.candidate
  WHERE route = $1 AND subject_id = $2 AND candidate_id = $3
  UNION ALL
  SELECT property FROM semantic.fact f
  WHERE f.route = $1 AND f.subject_id = $2 AND f.statement_id = $3
    AND f.kind = 'statement' AND f.operation = 'assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact newer
      WHERE newer.route = f.route AND newer.subject_id = f.subject_id
        AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
        AND newer.log_seq > f.log_seq
    )
  LIMIT 1`;

export async function readStatementCandidate(pool: Pool, subject: string, candidate: string): Promise<boolean> {
  const route = routeOf(subject);
  if (route === null || routeOf(candidate) !== route) return false;
  return withConnection(pool, async (client) => {
    const found = await client.query(
      `SELECT 1 FROM semantic.subject s
       WHERE s.route = $1 AND s.subject_id = $2
         AND EXISTS (${LIVE_CANDIDATE})`,
      [route, subject, candidate],
    );
    return (found.rowCount ?? 0) > 0;
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
      const before = current.visibility === 'visible' ? await shownFacts(tx, options.subject) : [];
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
      const after = nextVisibility === 'visible' ? await shownFacts(tx, options.subject) : [];
      const events: { type: string; subject: string; data: unknown }[] = [
        {
          type: 'com.rezics.subject.visibility_changed.v1',
          subject: options.subject,
          data: { id: options.subject, visibility: nextVisibility, security_revision: securityRevision },
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
      );
      if (links) events.push(links);
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
    },
    async (tx, { transactionId }) => {
      const current = await readModeratedSubject(tx, route, options.subject);
      const located = await tx.query<{ property: string }>(LIVE_CANDIDATE, [route, options.subject, options.candidate]);
      const property = located.rows[0]?.property;
      if (!current || property === undefined) throw new ModerationSubjectNotFoundError();
      const hidden = await tx.query<{ visibility: 'hidden' | 'taken_down' }>(
        `SELECT visibility FROM semantic.hidden_candidate
         WHERE route = $1 AND subject_id = $2 AND candidate_id = $3`,
        [route, options.subject, options.candidate],
      );
      const currentVisibility: SubjectVisibility = hidden.rows[0]?.visibility ?? 'visible';
      if (!statementTransition(options.action, currentVisibility)) throw new ModerationConflictError();
      const body = validateModerationBody(options.action, options.body);
      const nextVisibility = nextStatementVisibility(options.action);
      const before = current.visibility === 'visible' ? await shownFacts(tx, options.subject, property) : [];
      await expandSlot(tx, options.subject, property, transactionId);
      const updated = await tx.query<{ security_revision: string }>(
        `UPDATE semantic.subject
         SET security_revision = security_revision + 1
         WHERE route = $1 AND subject_id = $2 AND security_revision = $3
         RETURNING security_revision::text AS security_revision`,
        [route, options.subject, current.securityRevision],
      );
      const revision = updated.rows[0]?.security_revision;
      if (revision === undefined) throw new ModerationConflictError();
      await tx.query(
        `INSERT INTO semantic.moderation
         (route, subject_id, security_revision, action, visibility, actor, body, recorded_transaction_id, candidate_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        [
          route,
          options.subject,
          revision,
          options.action,
          nextVisibility,
          options.actor.accountId,
          JSON.stringify(body),
          transactionId,
          options.candidate,
        ],
      );
      if (nextVisibility === 'visible') {
        await tx.query(
          `DELETE FROM semantic.hidden_candidate
           WHERE route = $1 AND subject_id = $2 AND candidate_id = $3`,
          [route, options.subject, options.candidate],
        );
      } else {
        await tx.query(
          `INSERT INTO semantic.hidden_candidate
           (route, subject_id, candidate_id, visibility, security_revision)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (route, subject_id, candidate_id)
           DO UPDATE SET visibility = EXCLUDED.visibility, security_revision = EXCLUDED.security_revision`,
          [route, options.subject, options.candidate, nextVisibility, revision],
        );
      }
      const securityRevision = Number(revision);
      const after = current.visibility === 'visible' ? await shownFacts(tx, options.subject, property) : [];
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
      );
      if (links) events.push(links);
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
