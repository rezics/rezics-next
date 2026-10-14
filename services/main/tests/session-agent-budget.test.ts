import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { httpTelemetry } from '@rezics/observability/elysia';
import { logWorkerFault, telemetryLog } from '@rezics/observability/log';
import { ActingContextDenied, ActingContextInvalid, ActingContextStale,
  ActingContextUnavailable, transaction } from '../src/modules/access/contexts.ts';
import { GroupUnavailable } from '../src/modules/access/groups.ts';
import { RoleUnavailable } from '../src/modules/access/roles.ts';
import { ControlUnavailable } from '../src/modules/access/topology-control.ts';
import { SearchIndexUnavailable } from '../src/modules/work/search-readiness.ts';
import { ClassificationDecisionUnavailable } from '../src/modules/classification/decision.ts';
import { AccountAssertionUnavailable } from '../src/modules/account/verify-assertion.ts';
import { commandError } from '../src/routes/problems.ts';

const privateMessage = "reader@example.com VALUES ('private request')";

for (const code of ['40001', '40P01', '55P03', '57014']) {
  test(`access transaction retains SQLSTATE ${code} and its original failure after rollback`, async () => {
    const cause = Object.assign(new Error(privateMessage), { code });
    const queries: string[] = [];
    let releases = 0;
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql === 'ROLLBACK') throw new Error('rollback connection closed');
      return { rows: [] };
    }, release: () => { releases++; } } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const error = await transaction(pool, async () => { throw cause; }, 'READ COMMITTED')
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ActingContextUnavailable);
    expect((error as Error).cause).toBe(cause);
    expect(error).toHaveProperty('code', code);
    expect(queries).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED',
      "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '5s'", 'ROLLBACK']);
    expect(releases).toBe(1);
  });
}

for (const OwnerUnavailable of [GroupUnavailable, RoleUnavailable, ControlUnavailable]) {
  test(`access transaction retains ${OwnerUnavailable.name} and its database cause`, async () => {
    const database = Object.assign(new Error(privateMessage), { code: '57014' });
    const cause = new OwnerUnavailable('authority unavailable', { cause: database });
    const client = { query: async () => ({ rows: [] }), release: () => {} } as unknown as PoolClient;
    const error = await transaction({ connect: async () => client } as unknown as Pool,
      async () => { throw cause; }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ActingContextUnavailable);
    expect((error as Error).cause).toBe(cause);
    expect(((error as Error).cause as Error).cause).toBe(database);
  });
}

test('typed server refusals emit one private bounded fault in their HTTP trace before answering', async () => {
  const database = Object.assign(new Error(privateMessage), { code: '57014', detail: privateMessage });
  const errors = [new ActingContextUnavailable(privateMessage, { cause: database }),
    new GroupUnavailable(privateMessage, { cause: database }),
    new AccountAssertionUnavailable(privateMessage, { cause: database }),
    new SearchIndexUnavailable('journal unavailable', { cause: database })];
  const expected = [
    ['acting_context_unavailable', 'Acting contexts are unavailable'],
    ['group_unavailable', 'Group change is unavailable'],
    ['dependency_unavailable', 'A required authority service is unavailable'],
    ['search_index_unavailable', 'Public text index is unavailable'],
  ];
  const traceId = '0123456789abcdef0123456789abcdef';
  const lines: string[] = [];
  const capture = spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  const app = new Elysia().use(httpTelemetry()).get('/fault/:index', ({ params }) => {
    const before = lines.length;
    const response = commandError(errors[Number(params.index)]);
    expect(lines.length - before).toBe(1);
    return response;
  }).listen({ hostname: '127.0.0.1', port: 0 });
  try {
    for (const [index, error] of errors.entries()) {
      const response = await fetch(`${app.server!.url.origin}/fault/${index}`, {
        headers: { traceparent: `00-${traceId}-0123456789abcdef-01` },
      });
      expect(response.status).toBe(503);
      const [code, title] = expected[index]!;
      expect(await response.json()).toEqual({ type: `https://rezics.com/problems/${code}`,
        status: 503, code, title });
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe(index === 2 ? '1' : null);
      const fault = JSON.parse(lines[index]!) as Record<string, unknown>;
      expect(fault).toMatchObject({ event: 'worker_fault', level: 'error',
        'error.class': error.constructor.name,
        'error.code': error instanceof SearchIndexUnavailable ? 'journal_unavailable' : '57014',
        'error.sqlstate': '57014',
        'error.chain.classes': [error.constructor.name, 'Error'], trace_id: traceId });
      expect(fault.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(lines[index]).not.toContain('reader@example.com');
      expect(lines[index]).not.toContain('private request');
      expect(fault).not.toHaveProperty('message');
      expect(fault).not.toHaveProperty('stack');
      expect(fault).not.toHaveProperty('detail');
    }
    expect(lines).toHaveLength(errors.length);
  } finally { capture.mockRestore(); await app.stop(); }
});

test('SQLSTATE is a bounded provider code, independent of the outer refusal code', () => {
  const lines: string[] = [];
  const capture = spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    const database = Object.assign(new Error(privateMessage), { code: '55P03' });
    logWorkerFault('main.route.typed_refusal', Object.assign(new Error(privateMessage,
      { cause: database }), { code: 'access_unavailable' }));
    telemetryLog('worker_fault', 'error', { 'error.sqlstate': '57014' });
    for (const invalid of [privateMessage, '57014-extra', '55p03', '1234', 57014]) {
      telemetryLog('worker_fault', 'error', { 'error.sqlstate': invalid });
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ 'error.code': 'access_unavailable', 'error.sqlstate': '55P03' });
    expect(JSON.parse(lines[1]!)['error.sqlstate']).toBe('57014');
    for (const line of lines.slice(2)) expect(JSON.parse(line)['error.sqlstate']).toBeUndefined();
    for (const line of lines) expect(line).not.toContain('reader@example.com');
  } finally { capture.mockRestore(); }
});

test('a typed server refusal without provider evidence emits one fault without inventing a code', () => {
  const lines: string[] = [];
  const capture = spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    expect(commandError(new ActingContextUnavailable('Access is held for recovery')).status).toBe(503);
    expect(lines).toHaveLength(1);
    const fault = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(fault['error.class']).toBe('ActingContextUnavailable');
    expect(fault['error.code']).toBeUndefined();
    expect(fault['error.sqlstate']).toBeUndefined();
  } finally { capture.mockRestore(); }
});

test('ordinary refusals stay silent and unknown failures still emit one fault', () => {
  const capture = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const [error, status] of [
      [new ActingContextInvalid(privateMessage), 400],
      [new ActingContextDenied(privateMessage), 403],
      [new ActingContextStale(privateMessage), 409],
      [new ClassificationDecisionUnavailable(privateMessage), 409],
    ] as const) expect(commandError(error).status).toBe(status);
    expect(capture).not.toHaveBeenCalled();
    expect(commandError(new Error(privateMessage)).status).toBe(503);
    expect(capture).toHaveBeenCalledTimes(1);
  } finally { capture.mockRestore(); }
});
