import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';

test('OPS06: after writes on a fresh stack the broker lane is open', async () => {
  const stack = await startMediaStack('broker-lane', { profileCredits: true });
  try {
    const editor = await stack.member('broker-editor');
    await stack.publicWork(editor.actor, ['en'], 'Broker lane seed');
    const before = await stack.call('GET', '/v1/operations/backpressure');
    expect(before.status).toBe(200);
    const seeded = await before.json() as { lanes: [unknown, {
      state: string; head: string | null; delivered: string | null; backlog: string | null }, unknown] };
    expect(seeded.lanes[1].state).toBe('open');
    expect(seeded.lanes[1].delivered).toBe('0');
    expect(BigInt(seeded.lanes[1].head ?? '-1')).toBeGreaterThan(0n);
    expect(seeded.lanes[1].backlog).toBe(seeded.lanes[1].head);

    await editor.grant('work:create:root', 'work.create');
    const created = await editor.send('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Broker lane work', language: 'en',
      actingSubject: editor.actor,
    });
    expect(created.status).toBe(201);
    const after = await stack.call('GET', '/v1/operations/backpressure');
    const observed = await after.json() as { lanes: [unknown, { state: string }, unknown] };
    expect(observed.lanes[1].state).toBe('open');
  } finally {
    await stack.stop();
  }
});
