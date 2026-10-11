import { describe, expect, it } from 'vitest';
import { browserZoneLifecycle } from './api.ts';
import { initialZoneLifecycleState, readZoneLifecycleSnapshot, reduceZoneLifecycle } from './lifecycle.ts';

const zoneId = '00000000-0000-4000-8000-000000000501';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000502';
const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000503';
const nextHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000504';

function fakeMain() {
  const calls: Array<{ operation: string; body?: unknown; options?: unknown; query?: unknown }> = [];
  let read: unknown = { zone: `https://rezics.com/id/${zoneId}`, revision: head,
    configuration: { state: 'active' } };
  let result: { data: unknown; error: { status: number; value: unknown } | null } = {
    data: { revision: nextHead, replayed: false }, error: null,
  };
  const main = { v1: { zones: ({ id }: { id: string }) => ({
    configuration: { get: async ({ query }: { query: unknown }) => {
      calls.push({ operation: `configuration:${id}`, query });
      return { data: read, error: null };
    } },
    retirements: { post: async (body: unknown, options: unknown) => {
      calls.push({ operation: `retirements:${id}`, body, options });
      return result;
    } },
    recoveries: { post: async (body: unknown, options: unknown) => {
      calls.push({ operation: `recoveries:${id}`, body, options });
      return result;
    } },
  }) } };
  return {
    calls,
    client: browserZoneLifecycle(main as never),
    setRead(value: unknown) { read = value; },
    setResult(value: typeof result) { result = value; },
  };
}

describe('Zone lifecycle', () => {
  it('reads status from the authorized configuration operation', async () => {
    const fake = fakeMain();
    const result = await fake.client.readConfiguration(zoneId, actor);

    expect(result).toEqual({ ok: true, data: { revision: head, status: 'active' } });
    expect(fake.calls).toEqual([{ operation: `configuration:${zoneId}`, query: { actingSubject: actor } }]);
  });

  it('uses the retirement and recovery command routes with their command keys', async () => {
    const fake = fakeMain();
    const body = { expectedHead: head, actingSubject: actor };

    expect(await fake.client.retire(zoneId, body, 'retire-key')).toEqual({
      ok: true, data: { revision: nextHead, replayed: false },
    });
    expect(await fake.client.recover(zoneId, { ...body, expectedHead: nextHead }, 'recover-key')).toEqual({
      ok: true, data: { revision: nextHead, replayed: false },
    });
    expect(fake.calls).toEqual([
      { operation: `retirements:${zoneId}`, body, options: { headers: { 'idempotency-key': 'retire-key' } } },
      { operation: `recoveries:${zoneId}`, body: { ...body, expectedHead: nextHead },
        options: { headers: { 'idempotency-key': 'recover-key' } } },
    ]);
  });

  it('maps stale and denied lifecycle commands without changing local intent', async () => {
    const fake = fakeMain();
    const body = { expectedHead: head, actingSubject: actor };
    fake.setResult({ data: null, error: { status: 409, value: { code: 'stale_zone_head', currentHead: nextHead } } });
    const stale = await fake.client.retire(zoneId, body, 'stale-key');
    expect(stale).toEqual({ ok: false, failure: 'stale', currentHead: nextHead });

    fake.setResult({ data: null, error: { status: 403, value: { code: 'zone_edit_denied' } } });
    const denied = await fake.client.retire(zoneId, body, 'denied-key');
    expect(denied).toEqual({ ok: false, failure: 'denied' });
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps the selected lifecycle action through a stale refusal and status review', () => {
    const start = initialZoneLifecycleState({ revision: head, status: 'active' });
    const selected = reduceZoneLifecycle(start, { type: 'select', action: 'retire' });
    const stale = reduceZoneLifecycle(selected, { type: 'stale' });
    expect(stale).toMatchObject({ status: 'active', selection: 'retire', expectedHead: head, needsReview: true });

    const reviewed = reduceZoneLifecycle(stale, { type: 'reviewed',
      snapshot: { revision: nextHead, status: 'active' } });
    expect(reviewed).toMatchObject({ status: 'active', selection: 'retire', expectedHead: nextHead,
      needsReview: false, notice: 'reviewed' });
  });

  it('does not alter state or selected action after a denied command', () => {
    const selected = reduceZoneLifecycle(initialZoneLifecycleState({ revision: head, status: 'retired' }),
      { type: 'select', action: 'recover' });
    const denied = reduceZoneLifecycle(selected, { type: 'failed', failure: 'denied' });

    expect(denied).toMatchObject({ status: 'retired', selection: 'recover', expectedHead: head, notice: 'denied' });
  });

  it('rejects configuration snapshots without a usable revision or lifecycle state', () => {
    expect(readZoneLifecycleSnapshot(head, { state: 'retired' })).toEqual({ revision: head, status: 'retired' });
    expect(readZoneLifecycleSnapshot('bad', { state: 'active' })).toBeNull();
    expect(readZoneLifecycleSnapshot(head, { state: 'paused' })).toBeNull();
  });

  it('refuses malformed configuration lifecycle data', async () => {
    const fake = fakeMain();
    fake.setRead({ revision: head, configuration: { state: 'paused' } });
    expect(await fake.client.readConfiguration(zoneId, actor)).toEqual({ ok: false, failure: 'unavailable' });
  });
});
