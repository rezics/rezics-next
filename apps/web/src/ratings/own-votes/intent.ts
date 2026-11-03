import type { OwnVoteActions, OwnVoteEntry } from '../../../../../services/kernel/src/rating/own-votes-page.ts';
import { votePairKey } from './inventory';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OwnVoteIntent = Readonly<{
  viewer: string;
  targetId: string;
  questionId: string;
  pair: string;
  method: 'PUT' | 'DELETE';
  path: string;
  body: Readonly<{ units: number }> | null;
  key: string;
  actions: OwnVoteActions;
}>;

export function ownVotePath(targetId: string, questionId: string): string {
  return `/v1/subjects/${targetId}/ratings/${questionId}/vote`;
}

export function isAdmittedVoteAction(
  entry: OwnVoteEntry,
  action: unknown,
  method: 'PUT' | 'DELETE' | 'GET',
): boolean {
  if (!record(action)) return false;
  const expected = ownVotePath(entry.targetId, entry.questionId);
  if (method === 'PUT') return action.state === 'editable' && action.put === expected;
  if (method === 'DELETE')
    return (action.state === 'editable' || action.state === 'retired') && action.clear === expected;
  return (action.state === 'editable' || action.state === 'retired') && action.readback === expected;
}

export function validOwnVoteUnits(units: number, scale: { min: number; max: number; displayStep: number }): boolean {
  return (
    Number.isSafeInteger(units) &&
    units >= scale.min &&
    units <= scale.max &&
    scale.displayStep > 0 &&
    (units - scale.min) % scale.displayStep === 0
  );
}

export function createOwnVoteIntent(
  viewer: string,
  entry: OwnVoteEntry,
  method: 'PUT' | 'DELETE',
  units?: number,
  key = crypto.randomUUID(),
): OwnVoteIntent {
  let body: Readonly<{ units: number }> | null = null;
  if (!uuid.test(viewer) || !uuid.test(entry.targetId) || !uuid.test(entry.questionId) || !uuid.test(key))
    throw new Error('This rating is no longer available. Review the current page.');
  if (method === 'PUT') {
    if (
      entry.actions.state !== 'editable' ||
      !isAdmittedVoteAction(entry, entry.actions, 'PUT') ||
      !isAdmittedVoteAction(entry, entry.actions, 'GET') ||
      units === undefined ||
      !validOwnVoteUnits(units, entry.question.scale)
    )
      throw new Error('Choose a value on this question’s scale.');
    body = Object.freeze({ units });
  } else if (
    (entry.actions.state !== 'editable' && entry.actions.state !== 'retired') ||
    !isAdmittedVoteAction(entry, entry.actions, 'DELETE') ||
    !isAdmittedVoteAction(entry, entry.actions, 'GET')
  ) {
    throw new Error('This rating cannot be cleared from its current page.');
  }
  return Object.freeze({
    viewer,
    targetId: entry.targetId,
    questionId: entry.questionId,
    pair: votePairKey(entry),
    method,
    path: ownVotePath(entry.targetId, entry.questionId),
    body,
    key,
    actions: Object.freeze({ ...entry.actions }),
  });
}

export function parseOwnVoteIntent(input: unknown): OwnVoteIntent | null {
  if (!record(input)) return null;
  const value = input;
  const viewer = value.viewer;
  const targetId = value.targetId;
  const questionId = value.questionId;
  const pair = value.pair;
  const method = value.method;
  const path = value.path;
  const key = value.key;
  const rawBody = value.body;
  if (
    typeof viewer !== 'string' ||
    !uuid.test(viewer) ||
    typeof targetId !== 'string' ||
    !uuid.test(targetId) ||
    typeof questionId !== 'string' ||
    !uuid.test(questionId) ||
    pair !== votePairKey({ targetId, questionId }) ||
    (method !== 'PUT' && method !== 'DELETE') ||
    path !== ownVotePath(targetId, questionId) ||
    typeof key !== 'string' ||
    !uuid.test(key)
  )
    return null;
  const actions = parseActions(value.actions);
  if (!actions) return null;
  if (
    method === 'PUT'
      ? actions.state !== 'editable' || actions.put !== path || actions.readback !== path
      : (actions.state !== 'editable' && actions.state !== 'retired') ||
        actions.clear !== path ||
        actions.readback !== path
  )
    return null;
  const common = {
    viewer,
    targetId,
    questionId,
    pair,
    path,
    key,
    actions,
  };
  if (method === 'PUT') {
    if (!record(rawBody) || typeof rawBody.units !== 'number' || !Number.isSafeInteger(rawBody.units)) return null;
    return { ...common, method, body: Object.freeze({ units: rawBody.units }) };
  }
  return rawBody === null ? { ...common, method, body: null } : null;
}

function parseActions(value: unknown): OwnVoteActions | null {
  if (!record(value)) return null;
  if (value.state === 'editable' && 'put' in value && 'clear' in value && 'readback' in value) {
    if (typeof value.put === 'string' && typeof value.clear === 'string' && typeof value.readback === 'string')
      return { state: 'editable', put: value.put, clear: value.clear, readback: value.readback };
  }
  if (value.state === 'retired' && value.reason === 'question_retired' && 'clear' in value && 'readback' in value) {
    if (typeof value.clear === 'string' && typeof value.readback === 'string')
      return { state: 'retired', reason: 'question_retired', clear: value.clear, readback: value.readback };
  }
  if (
    value.state === 'unavailable' &&
    (value.reason === 'merged_source' || value.reason === 'identity_pending')
  )
    return { state: 'unavailable', reason: value.reason };
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
