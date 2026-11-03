import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JournalDate = { year: number; month?: number; day?: number } | null;
type JournalPatch = Parameters<ReturnType<KernelClient['progressSessions']>['journal']['patch']>[0];
type Journal = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['progressSessions']>['journal']['get']>>['data']
>['journal'];
type Identity = { viewer: string; csrfToken: string; authorization: string };

async function currentIdentity(): Promise<Identity | null> {
  const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
  return identity.state === 'signed-in' && identity.csrfToken
    ? { viewer: identity.subject, csrfToken: identity.csrfToken, authorization: identity.authorization }
    : null;
}

function validDate(value: unknown): value is JournalDate {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('year' in value)) return false;
  if (typeof value.year !== 'number' || !Number.isInteger(value.year) || value.year < 1 || value.year > 9999) return false;
  if ('month' in value && (typeof value.month !== 'number' || !Number.isInteger(value.month) || value.month < 1 || value.month > 12)) return false;
  if ('day' in value) {
    if (typeof value.day !== 'number' || !Number.isInteger(value.day) || !('month' in value)) return false;
    const last = new Date(Date.UTC(value.year, value.month as number, 0)).getUTCDate();
    if (value.day < 1 || value.day > last) return false;
  }
  return true;
}

function parsePatch(value: unknown): JournalPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 0) return null;
  const patch: { revision: number; startDate?: JournalDate; finishDate?: JournalDate; reflection?: string | null } = {
    revision: item.revision as number,
  };
  let changed = false;
  if ('startDate' in item) {
    if (!validDate(item.startDate)) return null;
    patch.startDate = item.startDate;
    changed = true;
  }
  if ('finishDate' in item) {
    if (!validDate(item.finishDate)) return null;
    patch.finishDate = item.finishDate;
    changed = true;
  }
  if ('reflection' in item) {
    if (item.reflection !== null && typeof item.reflection !== 'string') return null;
    patch.reflection = item.reflection;
    changed = true;
  }
  return changed ? patch : null;
}

function actionInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.sessionId !== 'string' ||
    item.sessionId.length < 1 ||
    item.sessionId.length > 128 ||
    typeof item.viewer !== 'string' ||
    typeof item.csrfToken !== 'string' ||
    typeof item.key !== 'string' ||
    !keyPattern.test(item.key) ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1
  )
    return null;
  return {
    sessionId: item.sessionId,
    viewer: item.viewer,
    csrfToken: item.csrfToken,
    key: item.key,
    revision: item.revision as number,
  };
}

export type JournalReadResult =
  | { kind: 'ready'; viewer: string; csrfToken: string; journal: Journal }
  | { kind: 'missing' | 'retired' | 'unavailable' };

export const readOccurrenceJournal = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || !('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128)
      throw new Error('Invalid occurrence address');
    return { sessionId: value.sessionId };
  })
  .handler(async ({ data }): Promise<JournalReadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity) return { kind: 'retired' };
    try {
      const result = await kernelClient().progressSessions({ sessionId: data.sessionId }).journal.get({
        headers: { authorization: identity.authorization },
      });
      if (!result.error && result.data?.journal?.sessionId === data.sessionId)
        return { kind: 'ready', viewer: identity.viewer, csrfToken: identity.csrfToken, journal: result.data.journal };
      if (result.status === 401) return { kind: 'retired' };
      if (result.status === 404) return { kind: 'missing' };
      return { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  });

export type JournalCommandResult =
  | { kind: 'saved'; journal: Journal }
  | { kind: 'conflict' | 'missing' | 'retired' | 'uncertain' };

export const correctOccurrenceJournal = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid journal command');
    const item = value as Record<string, unknown>;
    const patch = parsePatch(item.body);
    if (
      !patch ||
      typeof item.sessionId !== 'string' ||
      !item.sessionId ||
      item.sessionId.length > 128 ||
      typeof item.viewer !== 'string' ||
      typeof item.csrfToken !== 'string' ||
      typeof item.key !== 'string' ||
      !keyPattern.test(item.key)
    )
      throw new Error('Invalid journal command');
    return { sessionId: item.sessionId, viewer: item.viewer, csrfToken: item.csrfToken, key: item.key, body: patch };
  })
  .handler(async ({ data }): Promise<JournalCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity || identity.viewer !== data.viewer || identity.csrfToken !== data.csrfToken) return { kind: 'retired' };
    try {
      const client = kernelClient(undefined, identity.authorization);
      const result = await client.progressSessions({ sessionId: data.sessionId }).journal.patch(data.body, {
        headers: { 'idempotency-key': data.key },
      });
      if (result.error || !result.data?.journal || result.data.journal.sessionId !== data.sessionId) {
        if (result.status === 409) return { kind: 'conflict' };
        if (result.status === 404) return { kind: 'missing' };
        if (result.status === 401) return { kind: 'retired' };
        return { kind: 'uncertain' };
      }
      const readback = await client.progressSessions({ sessionId: data.sessionId }).journal.get();
      if (!readback.error && readback.data?.journal?.sessionId === data.sessionId)
        return { kind: 'saved', journal: readback.data.journal };
      if (readback.status === 404) return { kind: 'missing' };
      if (readback.status === 401) return { kind: 'retired' };
      return { kind: 'uncertain' };
    } catch {
      return { kind: 'uncertain' };
    }
  });

export type LifecycleResult =
  | { kind: 'saved'; session: { id: string; state: 'active' | 'completed' | 'abandoned' | 'retired'; revision: number } }
  | { kind: 'conflict' | 'missing' | 'retired' | 'uncertain' };

export const changeOccurrenceLifecycle = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid occurrence command');
    const item = value as Record<string, unknown>;
    const base = actionInput(item);
    if (!base || (item.action !== 'reopen' && item.action !== 'retire')) throw new Error('Invalid occurrence command');
    return { ...base, action: item.action };
  })
  .handler(async ({ data }): Promise<LifecycleResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity || identity.viewer !== data.viewer || identity.csrfToken !== data.csrfToken) return { kind: 'retired' };
    try {
      const client = kernelClient(undefined, identity.authorization);
      const options = { headers: { 'idempotency-key': data.key } };
      const result =
        data.action === 'reopen'
          ? await client.progressSessions({ sessionId: data.sessionId }).$reopen.post({ revision: data.revision }, options)
          : await client.progressSessions({ sessionId: data.sessionId }).$retire.post({ revision: data.revision }, options);
      if (!result.error && result.data?.progressSession?.id === data.sessionId) {
        const session = result.data.progressSession;
        return { kind: 'saved', session: { id: session.id, state: session.state, revision: session.revision } };
      }
      if (result.status === 409) return { kind: 'conflict' };
      if (result.status === 404) return { kind: 'missing' };
      if (result.status === 401) return { kind: 'retired' };
      return { kind: 'uncertain' };
    } catch {
      return { kind: 'uncertain' };
    }
  });
