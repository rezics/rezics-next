import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';

const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
const headers: string[] = [];
const request = () => new Request('https://site.test/en/library?state=planned', {
  headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
});
mock.module('@tanstack/react-start/server', () => ({
  getRequest: request,
  setResponseHeader: (name: string, value: string) => headers.push(`${name}: ${value}`),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadShelfSummaryCurrent, validShelfSummary, validateShelfSummaryInput } = await import('../src/library/shelf-summary-read');
const zero = () => ({ tabs: Object.fromEntries(
  ['all', 'in_progress', 'planned', 'completed', 'paused', 'dropped', 'collections'].map(key => [key, { total: 0, shown: 0 }]),
) });
const sessionEnv = {
  KERNEL_ORIGIN: 'https://kernel.test', AUTH_ISSUER: 'https://auth.test', API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'library_entry:list', WEBSITE_CLIENT_ID: 'summary-test', WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (value: string) => value, get: () => ({ credential: async () => ({
    status: 'active', subject: '0192f3a0-6c1e-7b2a-9d4e-000000000700', accessToken: 'owner-token', csrfToken: 'a'.repeat(22),
  }) }) },
} as unknown as Partial<SessionEnv>;

test('zero requires complete counts; custom states can exceed the legacy buckets and Collections ignore Type', () => {
  expect(validShelfSummary(undefined)).toBe(false);
  expect(validShelfSummary({ tabs: { all: { total: 0, shown: 0 } } })).toBe(false);
  expect(validShelfSummary(zero())).toBe(true);
  const summary = zero();
  summary.tabs.all = { total: 8, shown: 3 };
  summary.tabs.planned = { total: 2, shown: 1 };
  summary.tabs.collections = { total: 17, shown: 17 };
  expect(validShelfSummary(summary, 'schema:Book')).toBe(true);
  expect(validShelfSummary(summary)).toBe(false);
  summary.tabs.collections.shown = 1;
  expect(validShelfSummary(summary, 'schema:Book')).toBe(false);
  for (const bad of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = zero(); invalid.tabs.all = { total: bad, shown: bad };
    expect(validShelfSummary(invalid)).toBe(false);
  }
});

test('one typed summary request carries exact long Type and only Entry list credentials; failures never become zero', async () => {
  const calls: Request[] = [];
  let status = 200;
  let body: unknown = zero();
  const client = createKernelClient('https://kernel.test', { fetch: (async (input, init) => {
    calls.push(new Request(input, init));
    return Response.json(body, { status });
  }) as typeof fetch });
  const type = `schema:${'Long'.repeat(200)}`;
  expect(validateShelfSummaryInput({ type })).toEqual({ type });
  const loaded = await loadShelfSummaryCurrent(client, request(), sessionEnv, { type });
  expect(loaded).toMatchObject({ authorizationAgrees: true, requested: { type, locale: 'en', source: request().url }, page: { state: 'loaded' } });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).searchParams.get('type')).toBe(type);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner-token');
  expect(calls[0]!.cache).toBe('no-store');
  for (const [failure, code, expected] of [
    [403, 'forbidden', 'denied'], [403, 'platform_closed', 'closed'],
    [503, 'dependency_unavailable', 'preparing'], [503, 'unavailable', 'unavailable'], [401, 'unauthorized', 'signed-out'],
  ] as const) {
    status = failure; body = { code };
    expect((await loadShelfSummaryCurrent(client, request(), sessionEnv, {})).page).toEqual({ state: expected });
  }
  status = 200; body = { tabs: {} };
  expect((await loadShelfSummaryCurrent(client, request(), sessionEnv, {})).page).toEqual({ state: 'unavailable' });
  const before = calls.length;
  expect((await loadShelfSummaryCurrent(client, new Request('https://site.test/en/library'), {}, {})).page).toEqual({ state: 'signed-out' });
  expect(calls).toHaveLength(before);
});
