import type { KernelClient } from '@rezics/client';
import { NATIVE_RECENT_QUERY_TEXT_LIMIT } from './recent-history';

export type RecentEntry = Parameters<KernelClient['recentSearches']['post']>[0]['entry'];
export type RecentChange =
  | { kind: 'use'; entry: RecentEntry }
  | { kind: 'remove'; id: string }
  | { kind: 'clear' };
export type RecentPending = { key: string; change: RecentChange; queuedAt: string };
export type RecentWrite = { accountId: string; expectedRevision: number; pending: RecentPending };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const language = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const revisionMax = 2147483646;
const cursorMax = 4096;
const receiptMax = 80;
const pendingExtras = ['localId', 'visitedAt', 'expectedRevision'] as const;

function fail(): never {
  throw new Error('Invalid recent request');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function closed(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function admitScope(value: unknown): NonNullable<Extract<RecentEntry, { kind: 'query' }>['scope']> {
  const scope = record(value);
  if (!scope) fail();
  if (scope.kind === 'route') {
    if (!closed(scope, ['kind', 'route']) || scope.route !== 'library') fail();
    return { kind: 'route', route: 'library' };
  }
  if (
    (scope.kind === 'realm' || scope.kind === 'collection') &&
    closed(scope, ['kind', 'id']) &&
    nativeId(scope.id)
  )
    return { kind: scope.kind, id: scope.id };
  fail();
}

/** Native Recent entry shape: supported kinds, language tags and optional scope only. */
export function admitRecentEntry(value: unknown): RecentEntry {
  const entry = record(value);
  if (!entry) fail();
  if (entry.kind === 'query') {
    if (
      !closed(entry, ['kind', 'text', 'languages', 'scope']) ||
      !text(entry.text, NATIVE_RECENT_QUERY_TEXT_LIMIT) ||
      entry.text.includes('\0') ||
      !entry.text.trim()
    )
      fail();
    if (entry.languages !== undefined) {
      if (
        !Array.isArray(entry.languages) ||
        entry.languages.length > 8 ||
        entry.languages.some((tag) => !text(tag, 35) || !language.test(tag))
      )
        fail();
    }
    return {
      kind: 'query',
      text: entry.text,
      ...(entry.languages !== undefined ? { languages: entry.languages as string[] } : {}),
      ...(entry.scope !== undefined ? { scope: admitScope(entry.scope) } : {}),
    };
  }
  if (entry.kind === 'scope' && closed(entry, ['kind', 'scope'])) return { kind: 'scope', scope: admitScope(entry.scope) };
  fail();
}

function admitChange(value: unknown): RecentChange {
  const change = record(value);
  if (!change) fail();
  if (change.kind === 'use') {
    if (!closed(change, ['kind', 'entry'])) fail();
    return { kind: 'use', entry: admitRecentEntry(change.entry) };
  }
  if (change.kind === 'clear') {
    if (!closed(change, ['kind'])) fail();
    return { kind: 'clear' };
  }
  if (change.kind === 'remove') {
    if (!closed(change, ['kind', 'id']) || !nativeId(change.id)) fail();
    return { kind: 'remove', id: change.id };
  }
  fail();
}

/** Closed write admission: unknown kinds never become remove, and pending: ids never reach native delete. */
export function admitRecentWrite(input: unknown): RecentWrite {
  const body = record(input);
  if (
    !body ||
    !closed(body, ['accountId', 'expectedRevision', 'pending']) ||
    !nativeId(body.accountId) ||
    !Number.isInteger(body.expectedRevision) ||
    (body.expectedRevision as number) < 0 ||
    (body.expectedRevision as number) > revisionMax
  )
    fail();
  const pending = record(body.pending);
  if (
    !pending ||
    !closed(pending, ['key', 'change', 'queuedAt', ...pendingExtras]) ||
    !text(pending.key, receiptMax) ||
    typeof pending.queuedAt !== 'string' ||
    pending.queuedAt.length > 64 ||
    !Number.isFinite(Date.parse(pending.queuedAt))
  )
    fail();
  return {
    accountId: body.accountId,
    expectedRevision: body.expectedRevision as number,
    pending: { key: pending.key, change: admitChange(pending.change), queuedAt: pending.queuedAt },
  };
}

/** Optional cursor: omit empty, keep native maxLength before dispatch. */
export function admitRecentCursor(input: unknown): string | undefined {
  if (input === undefined) return;
  if (typeof input !== 'string' || input.length > cursorMax) fail();
  return input || undefined;
}
