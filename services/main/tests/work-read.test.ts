import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadLimit, WorkReadMoved,
  workRead } from '../src/modules/work/read-session.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';

test('Work cursor binds query and graph basis, rejects tampering, and carries no readable identity', () => {
  const position = { dataEpoch: 'one', sequence: '12' };
  const binding = ['versions', 'private-work', 'en'];
  const cursor = encodeReadCursor(binding, position, 'private-version', '11');
  expect(cursor).not.toContain('private');
  expect(decodeReadCursor(cursor, binding, position)?.after).toBe('private-version');
  expect(() => decodeReadCursor(cursor, ['versions', 'other-work', 'en'], position)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(`${cursor.slice(0, 5)}X${cursor.slice(6)}`, binding, position)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(cursor, binding, { ...position, sequence: '13' })).toThrow(WorkReadMoved);
  expect(() => decodeReadCursor(cursor, binding, { ...position, dataEpoch: 'two' })).toThrow(WorkReadMoved);
});

test('Work routes are exposed on the web app MainApp Eden contract', () => {
  const client = treaty<MainApp>('http://main.invalid');
  // This unused closure is a compile-time consumer check of both inputs and concrete response fields.
  const typedReads = async () => {
    const work = client.v1.works({ id: '00000000-0000-4000-8000-000000000001' });
    const header = await work.get({ query: { language: 'ja' } });
    const title: string | undefined = header.data?.title.value;
    const list = await client.v1.works.get({ query: { limit: 2 } });
    const next: string | null | undefined = list.data?.nextCursor;
    const rating = await work.ratings.get({ query: { scope: 'realm', realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' } });
    const count: number | undefined = rating.data?.count;
    return { title, next, count };
  };
  expect(typedReads).toBeFunction();
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/work-read' },
  account: {} as never, access: {} as never });
  const gets = app.routes.filter(route => route.method === 'GET').map(route => route.path);
  expect(gets).toContain('/v1/works');
  expect(gets).toContain('/v1/works/:id');
  expect(gets).toContain('/v1/works/:id/ratings');
  expect(gets).toContain('/v1/works/:id/classifications');
});

test('Work read envelope meters actual HTTP attempts/bytes and rejects mixed graph positions', async () => {
  let calls = 0;
  let sequence = '12';
  let oversized = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    calls++;
    return Response.json({ results: { bindings: [{ epoch: { type: 'literal', value: 'one' },
      sequence: { type: 'literal', value: sequence },
      ...(oversized ? { label: { type: 'literal', value: 'x'.repeat(WORK_READ_COST.queryBytes) } } : {}) }] } });
  } });
  const graph = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
  const dependencies: MainWorkDependencies = { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/work-read' },
  account: {} as never, access: {} as never };
  const request = new Request('http://main.test/v1/works');
  try {
    await expect(workRead(dependencies, request, {}, async session => {
      // A deliberately expensive counterexample exercises the real HTTP budget adapter.
      for (let i = 0; i <= WORK_READ_COST.graphCalls; i++) await session.query('SELECT ?x WHERE {}', 1);
    })).rejects.toBeInstanceOf(WorkReadLimit);
    expect(calls).toBe(WORK_READ_COST.graphCalls);
    calls = 0;
    await expect(workRead(dependencies, request, {}, async session => {
      oversized = true;
      await session.query('SELECT ?x WHERE {}', 1);
    })).rejects.toBeInstanceOf(WorkReadLimit);
    expect(calls).toBe(2);
    oversized = false;
    await expect(workRead(dependencies, request, {}, async () => {
      sequence = '13';
      return { secret: 'never returned on a mixed basis' };
    })).rejects.toBeInstanceOf(WorkReadMoved);
  } finally { await server.stop(true); }
});
