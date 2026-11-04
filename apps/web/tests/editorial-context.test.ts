import { describe, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { editorialContextFixture } from '../src/kernel/fake/editorial-context';
import {
  editorialCommand,
  readEditorialContext,
  submitEditorialContext,
  type EditorialCommand,
} from '../src/features/catalogue/editorial-context';

const key = () => crypto.randomUUID();
describe('Create or retire an editorial Context through its current native owner lifecycle through existing native authority and current reading', () => {
  test('named creation, current reading, deletion and restoration bind actual generated methods and continuity', async () => {
    const fixture = editorialContextFixture('create');
    const created = await fixture.transport.submit({ operation: 'create', labels: { ja: '読者の選択' }, key: key() });
    expect(created.ok && created.id).toBe(fixture.id);
    const read = await fixture.transport.read({ id: fixture.id, session: created.session });
    expect(read.ok && read.context.labels).toEqual({ ja: '読者の選択' });
    const deleted = await fixture.transport.submit({
      operation: 'delete',
      id: fixture.id,
      key: key(),
      session: read.session,
    });
    expect(deleted.ok && deleted.operation).toBe('delete');
    expect(await fixture.transport.read({ id: fixture.id, session: deleted.session })).toMatchObject({
      ok: true,
      context: null,
      lifecycle: { id: fixture.id, state: 'deleted', purgeAfter: expect.any(String) },
      actions: {
        kind: 'ready',
        value: [{ action: 'context:restore', operations: ['context.restore'] }],
      },
    });
    const restored = await fixture.transport.submit({
      operation: 'restore',
      id: fixture.id,
      key: key(),
      session: deleted.session,
    });
    expect(restored.ok && restored.id).toBe(fixture.id);
    expect((await fixture.transport.read({ id: fixture.id, session: restored.session })).ok).toBe(true);
    const mutations = fixture.calls.filter((call) => call.method !== 'GET' && call.path !== '/v1/viewerActions');
    expect(mutations.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/contexts'],
      ['DELETE', `/v1/contexts/${fixture.id}`],
      ['POST', `/v1/contexts/${fixture.id}:restore`],
    ]);
    expect(mutations[0]!.body).toEqual({ labels: { ja: '読者の選択' } });
    expect(mutations[2]!.body).toEqual({});
    expect(mutations.every((call) => /^"[0-9a-f-]{36}"$/.test(call.headers.get('idempotency-key') ?? ''))).toBe(true);
    expect(fixture.calls.every((call) => call.headers.get('authorization') === 'Bearer fixture')).toBe(true);
    expect(
      fixture.calls.slice(1).every((call) => call.headers.get('rezics-session-token') === 'editorial-session'),
    ).toBe(true);
    expect(fixture.calls.every((call) => !call.path.includes('grants') && !call.path.includes('subjects'))).toBe(true);
  });

  test('creation authority is read on the fixed parent, while missing action data stays unavailable and does not hide a readable Context', async () => {
    const fixture = editorialContextFixture();
    expect(await fixture.transport.creation()).toMatchObject({
      kind: 'ready',
      value: [{ action: 'context:create', operations: ['context.create'] }],
    });
    expect(fixture.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/viewerActions',
      body: { resources: [{ type: 'semantic.context', id: PAGE_GLOBAL_CONTEXT }] },
    });

    const unavailable = editorialContextFixture('unavailable-actions');
    expect(await unavailable.transport.creation()).toMatchObject({ kind: 'unavailable' });
    const reading = await unavailable.transport.read({ id: unavailable.id });
    expect(reading.ok && reading.context?.id).toBe(unavailable.id);
    expect(reading.ok && reading.actions).toMatchObject({ kind: 'unavailable' });
  });

  test('current denial governs creator, transferred owner and replay; expired restoration stays a conflict', async () => {
    const fixture = editorialContextFixture();
    const command: EditorialCommand = { operation: 'delete', id: fixture.id, key: key() };
    fixture.refuse(403);
    expect(await fixture.transport.submit(command)).toMatchObject({ ok: false, reason: 'denied' });
    fixture.refuse(undefined);
    expect((await fixture.transport.submit(command)).ok).toBe(true);
    fixture.refuse(403);
    expect(await fixture.transport.submit(command)).toMatchObject({ ok: false, reason: 'denied' });
    expect(await fixture.transport.submit({ operation: 'restore', id: fixture.id, key: key() })).toMatchObject({
      ok: false,
      reason: 'denied',
    });
    const expired = editorialContextFixture('expired');
    expect((await expired.transport.submit({ operation: 'delete', id: expired.id, key: key() })).ok).toBe(true);
    expect(await expired.transport.submit({ operation: 'restore', id: expired.id, key: key() })).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    const global = editorialContextFixture('global');
    expect(await global.transport.submit({ operation: 'delete', id: global.id, key: key() })).toMatchObject({
      ok: false,
      reason: 'denied',
    });
  });

  test('unknown deletion keeps its exact key through an opposite-state observation, and a contradictory acknowledgment is not success', async () => {
    const fixture = editorialContextFixture('uncertain');
    const command: EditorialCommand = { operation: 'delete', id: fixture.id, key: key() };
    expect(await fixture.transport.submit(command)).toMatchObject({ ok: false, reason: 'unavailable' });
    const observed = await fixture.transport.read({ id: fixture.id });
    expect(observed).toMatchObject({
      ok: true,
      context: null,
      lifecycle: { state: 'deleted' },
      actions: { kind: 'ready', value: [{ action: 'context:restore' }] },
    });
    expect(fixture.calls.filter((call) => call.path.endsWith(fixture.id) && call.method === 'DELETE')).toHaveLength(1);
    const replay = await fixture.transport.submit(command);
    expect(replay).toMatchObject({ ok: true, operation: 'delete', id: fixture.id });
    const deletes = fixture.calls.filter(
      (call) => call.path === `/v1/contexts/${fixture.id}` && call.method === 'DELETE',
    );
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
    expect(deletes[1]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
    expect(fixture.calls.some((call) => call.path.endsWith(':restore'))).toBe(false);

    const requests: { method: string; path: string; key: string | null }[] = [];
    const contradictory = createKernelClient('https://contradictory.test', {
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          key: request.headers.get('idempotency-key'),
        });
        return new Response(JSON.stringify({ context: { id: fixture.id, state: 'active' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    expect(
      await submitEditorialContext(contradictory, 'Bearer fixture', {
        operation: 'delete',
        id: fixture.id,
        key: command.key,
      }),
    ).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(requests).toEqual([
      { method: 'DELETE', path: `/v1/contexts/${fixture.id}`, key: JSON.stringify(command.key) },
    ]);
  });

  test('uncertain creation preserves its exact key and name; invalid or unserved ports never succeed', async () => {
    const fixture = editorialContextFixture('uncertain');
    const command: EditorialCommand = { operation: 'create', labels: { en: 'Readers’ choices' }, key: key() };
    expect(await fixture.transport.submit(command)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect((await fixture.transport.submit(command)).ok).toBe(true);
    expect(fixture.calls[0]!.body).toEqual(fixture.calls[1]!.body);
    expect(fixture.calls[0]!.headers.get('idempotency-key')).toBe(fixture.calls[1]!.headers.get('idempotency-key'));
    expect(() => editorialCommand({ ...command, owner: 'creator' })).toThrow();
    expect(await fixture.transport.submit({ ...command, labels: { en: '' } })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    for (const [status, code, reason] of [
      [404, 'not_found', 'missing'],
      [404, undefined, 'unavailable'],
      [503, 'overloaded', 'unavailable'],
    ] as const) {
      const client = createKernelClient('https://unserved.test', {
        fetch: (async () =>
          new Response(JSON.stringify({ code }), {
            status,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      });
      expect(await readEditorialContext(client, 'Bearer fixture', { id: fixture.id })).toMatchObject({
        ok: false,
        reason,
      });
      expect(
        await submitEditorialContext(client, 'Bearer fixture', { operation: 'restore', id: fixture.id, key: key() }),
      ).toMatchObject({ ok: false, reason });
    }
  });
});
