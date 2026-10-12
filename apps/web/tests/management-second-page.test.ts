import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { readAudit, readManagedRealms, readOutgoingInvitations, readPublicDecisions, readQueue } from '../features/manage/read.ts';
import { readSafetyPage } from '../features/manage/safety-api.ts';
import type { SafetyView } from '../features/manage/safety-state.ts';
import type { MainClient } from '../features/manage/types.ts';
import { readProposals } from '../features/proposals/read.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a1';
const realm = '00000000-0000-4000-8000-0000000000b1';
// Opaque on purpose: the adapter must send the cursor it was given byte for byte.
const cursor = 'next+page/2=';
const now = Date.parse('2026-10-12T00:00:00Z');
const safetyView: SafetyView = { urgent: true, category: 'harassment', language: 'en', due: 'week' };

/**
 * Main answers page two only when the request carries the continuation, so an
 * adapter that drops the cursor gets page one again and the assertions fail.
 */
function fakeMain(param: string) {
  const urls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const second = url.searchParams.get(param) === cursor;
    return Response.json(second ? page(['second-a'], null) : page(['first-a', 'first-b'], cursor));
  }) as typeof fetch;
  return { urls, main: treaty<MainApp>('http://main.test', { fetcher, parseDate: false }) };
}

const page = (ids: string[], nextCursor: string | null) => ({
  items: ids.map(id => ({ id })), nextCursor, complete: nextCursor === null,
});

/** Each list's `Loaded` read, typed structurally: its failure type differs per feature. */
type Read = { ok: true; data: unknown } | { ok: false; failure: unknown };

function dataOf(read: Read): unknown {
  if (!read.ok) throw new Error(`read failed: ${String(read.failure)}`);
  return read.data;
}
const idsOf = (data: unknown) => (data as { items: { id: string }[] }).items.map(item => item.id);
const nextCursorOf = (data: unknown) => (data as { nextCursor: string | null }).nextCursor;
const paramsOf = (url: URL) => Object.fromEntries(url.searchParams);

interface Row {
  list: string;
  path: string;
  /** The query parameter that carries the Main continuation for this list. */
  param: 'cursor' | 'after';
  filters: Record<string, string>;
  read: (main: MainClient, next: string | null) => Promise<Read>;
}

const rows: Row[] = [
  { list: 'managed home Realms', path: '/v1/me/managed-realms', param: 'after', filters: { actingSubject: actor },
    read: (main, next) => readManagedRealms(main, actor, next) },
  { list: 'moderation queue', path: `/v1/realms/${realm}/moderation`, param: 'cursor',
    filters: { actingSubject: actor, state: 'open', type: 'content_report', reason: 'spam' },
    read: (main, next) => readQueue(main, realm, { actingSubject: actor, state: 'open', type: 'content_report',
      reason: 'spam', cursor: next }) },
  { list: 'safety-case queue', path: '/v1/safety-cases', param: 'cursor',
    filters: { actingSubject: actor, urgent: 'true', category: 'harassment', contentLanguage: 'en',
      dueBefore: new Date(now + 7 * 86_400_000).toISOString() },
    read: (main, next) => readSafetyPage(main, actor, safetyView, now, next) },
  { list: 'outgoing invitations', path: `/v1/realms/${realm}/invitations`, param: 'after', filters: { actingSubject: actor },
    read: (main, next) => readOutgoingInvitations(main, realm, actor, next) },
  { list: 'audit log', path: `/v1/realms/${realm}/audit`, param: 'cursor',
    filters: { actingSubject: actor, kind: 'rights_disposition' },
    read: (main, next) => readAudit(main, realm, { actingSubject: actor, kind: 'rights_disposition', cursor: next }) },
  { list: 'public decision log', path: `/v1/realms/${realm}/decisions`, param: 'cursor', filters: { actingSubject: actor },
    read: (main, next) => readPublicDecisions(main, realm, actor, next) },
  { list: 'editorial proposals awaiting review', path: '/v1/editorial/proposals', param: 'cursor',
    filters: { filter: 'review-requested', actingSubject: actor, limit: '20' },
    read: (main, next) => readProposals(main, 'review-requested', actor, next) },
];

for (const row of rows) {
  test(`${row.list}: the second page follows the API continuation with the same filters`, async () => {
    const { urls, main } = fakeMain(row.param);
    const first = dataOf(await row.read(main, null));
    expect(idsOf(first)).toEqual(['first-a', 'first-b']);
    const next = nextCursorOf(first);
    expect(next).toBe(cursor);

    const second = dataOf(await row.read(main, next));

    expect(urls).toHaveLength(2);
    expect(urls[0]!.pathname).toBe(row.path);
    expect(paramsOf(urls[0]!)).toEqual(row.filters);
    expect(urls[1]!.pathname).toBe(row.path);
    expect(paramsOf(urls[1]!)).toEqual({ ...row.filters, [row.param]: cursor });
    expect(idsOf(second)).toEqual(['second-a']);
  });
}
