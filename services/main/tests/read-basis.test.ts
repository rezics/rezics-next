import { expect, test } from 'bun:test';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { decodeReadCursor, encodeReadCursor, workRead, WorkReadInvalid, WorkReadLimit,
  WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';
import { READ_BASIS_RETENTION_MS } from '../src/modules/read-basis/retention.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';

test('G323 retained cursors bind inputs and epoch, survive writes, and never renew their expiry', () => {
  const basis = { dataEpoch: 'epoch', sequence: '10' };
  const binding = ['discovery', 'owner', 'language'];
  const expiresAt = Date.now() + READ_BASIS_RETENTION_MS;
  const cursor = encodeReadCursor(binding, basis, 'last-work', 'generation', expiresAt);
  const decoded = decodeReadCursor(cursor, binding, { ...basis, sequence: '11' }, true)!;
  expect(decoded.position).toEqual(basis);
  expect(decoded.expiresAt).toBe(expiresAt);
  expect(() => decodeReadCursor(cursor, ['discovery', 'other'], basis, true)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(cursor, binding, { ...basis, dataEpoch: 'restored' }, true)).toThrow(WorkReadMoved);
  expect(() => decodeReadCursor(cursor, binding, { ...basis, sequence: '11' })).toThrow(WorkReadMoved);
  const expired = encodeReadCursor(binding, basis, 'last-work', 'generation', Date.now() - 1);
  expect(() => decodeReadCursor(expired, binding, basis, true)).toThrow(WorkReadMoved);
  const legacy = encodeReadCursor(binding, basis, 'last-work');
  expect(() => decodeReadCursor(legacy, binding, { ...basis, sequence: '11' }, true)).toThrow(WorkReadMoved);
});

test('G323 first-page retries share budgets, recheck authority, and do not replay commands or continuation callbacks', async () => {
  let sequence = 1;
  let active = true;
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    calls++;
    return Response.json({ results: { bindings: [{ epoch: { type: 'literal', value: 'epoch' },
      sequence: { type: 'literal', value: String(sequence) } }] } });
  } });
  const fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
  const deps = { environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/read-basis' }, account: { verify: async () => ({ issuer: 'a', subject: 'b' }) },
  access: { assertRecoveryOpen: async () => undefined,
    activePrincipalId: async () => active ? 'principal' : null } } as unknown as MainWorkDependencies;
  const request = new Request('http://main.local/v1/agents/test');
  try {
    let attempts = 0;
    const result = await workRead(deps, request, {}, async session => {
      if (++attempts < WORK_READ_COST.attempts) sequence++;
      return session.position;
    });
    expect(result.sequence).toBe(String(sequence));
    expect(attempts).toBe(WORK_READ_COST.attempts);

    attempts = 0;
    expect(await workRead(deps, request, {}, async () => {
      if (++attempts === 1) throw new SearchSnapshotMoved('Supporting Statement snapshot changed');
      return 'current';
    })).toBe('current');
    expect(attempts).toBe(2);

    attempts = 0;
    const binding = ['retained'];
    const expired = encodeReadCursor(binding, { dataEpoch: 'epoch', sequence: '1' }, '', '', Date.now() - 1);
    await expect(workRead(deps, request, { cursor: expired, retainedBasis: true }, async session => {
      attempts++;
      return decodeReadCursor(expired, binding, session.position, true);
    })).rejects.toBeInstanceOf(WorkReadMoved);
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(workRead(deps, request, {}, async () => { attempts++; sequence++; }))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(attempts).toBe(WORK_READ_COST.attempts);

    calls = 0;
    await expect(workRead(deps, request, {}, async session => {
      for (let n = 0; n < 60; n++) await session.query('SELECT ?x WHERE {}', 1);
      sequence++;
    })).rejects.toBeInstanceOf(WorkReadLimit);
    expect(calls).toBe(WORK_READ_COST.graphCalls);

    for (const [read, options] of [[new Request(request.url, { method: 'POST' }), {}],
      [new Request('http://main.internal/discovery-refresh'), {}], [request, { cursor: 'continuation' }],
      [new Request(`${request.url}?cursor=owner-decoded`), {}]] as const) {
      attempts = 0;
      await expect(workRead(deps, read, options, async () => { attempts++; sequence++; }))
        .rejects.toBeInstanceOf(WorkReadMoved);
      expect(attempts).toBe(1);
    }
    const authenticated = new Request(request.url, { headers: { authorization: 'Bearer test' } });
    attempts = 0;
    await expect(workRead(deps, authenticated, { actingSubject: 'agent' }, async () => {
      attempts++; sequence++; active = false;
    })).rejects.toBeInstanceOf(AccountAssertionDenied);
    expect(attempts).toBe(1);
  } finally { await server.stop(true); }
});
