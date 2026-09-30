import { t } from 'elysia';
import type { Static } from 'typebox';
import { resolvedTarget, targetRef } from '../target/contract.ts';
import { readLanguage } from '../work/read-contract.ts';

export const SESSION_COST = { selections: 16, page: 50, pageSql: 2,
  writeSql: 32, locatorWrites: 1, targetBatches: 1 } as const;
export const sessionStatus = t.Union([t.Literal('planned'), t.Literal('active'), t.Literal('paused'),
  t.Literal('dnf'), t.Literal('finished')]);
export type SessionStatus = Static<typeof sessionStatus>;
// Lexical precision is retained. Null means unknown, never today's date.
export const sessionDate = t.Nullable(t.String({ pattern: '^\\d{4}(?:-\\d{2}(?:-\\d{2})?)?$' }));
const format = t.Nullable(t.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }));
export const selectionInput = t.Object({ target: targetRef,
  language: t.Optional(t.Nullable(readLanguage)), format: t.Optional(format) }, { additionalProperties: false });
export type SelectionInput = Static<typeof selectionInput>;
export const sessionSelection = t.Object({ target: resolvedTarget,
  language: t.Nullable(readLanguage), format,
  progress: t.Union([t.Literal('locator'), t.Literal('structure')]) }, { additionalProperties: false });
export type SessionSelection = Static<typeof sessionSelection>;
export const locatorUnit = t.Union([t.Literal('page'), t.Literal('percentage'), t.Literal('media-time')]);
export const locatorInput = t.Object({ target: targetRef, unit: locatorUnit,
  value: t.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    description: 'Page number, percentage from 0 to 100, or media time in seconds; completion is a separate state.' }) },
{ additionalProperties: false });
export type LocatorInput = Static<typeof locatorInput>;
export const sessionLocator = t.Object({ target: targetRef, unit: locatorUnit,
  current: t.Number({ minimum: 0 }), furthest: t.Number({ minimum: 0 }) }, { additionalProperties: false });
export type SessionLocator = Static<typeof sessionLocator>;
export const sessionState = t.Object({ id: targetRef, target: resolvedTarget,
  state: sessionStatus, startedOn: sessionDate, finishedOn: sessionDate,
  selections: t.Array(sessionSelection, { minItems: 1, maxItems: SESSION_COST.selections }),
  locators: t.Array(sessionLocator, { maxItems: SESSION_COST.selections }),
  completedAt: t.Nullable(t.String()), version: t.Integer({ minimum: 1 }),
  createdAt: t.String(), changedAt: t.String() }, { additionalProperties: false });
export type SessionState = Static<typeof sessionState>;
export const sessionResult = t.Object({ ...sessionState.properties, replayed: t.Boolean() }, { additionalProperties: false });
export const sessionChanges = {
  state: t.Optional(sessionStatus), startedOn: t.Optional(sessionDate), finishedOn: t.Optional(sessionDate),
  addSelections: t.Optional(t.Array(selectionInput, { minItems: 1, maxItems: SESSION_COST.selections })),
  position: t.Optional(locatorInput),
};
export type SessionChanges = { state?: SessionStatus; startedOn?: string | null; finishedOn?: string | null;
  addSelections?: SelectionInput[]; position?: LocatorInput };
export class InvalidSession extends Error {}
export class SessionDenied extends Error {}
export class SessionMissing extends Error {}
export class SessionConflict extends Error {}
export class StaleSession extends Error {
  constructor(readonly current: SessionState, readonly submitted: SessionChanges & { expectedVersion: number }) {
    super('Session changed on another device');
  }
}
