import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const native = (last: number) => `https://rezics.com/id/${id(last)}`;

async function mentionEvents(currentRevision: string) {
  const events: NotificationEvent[] = [];
  const envelope = { id: 'reply-placed:1', type: 'com.rezics.realm.reply-placed.v1', data: { receipt: {
    realm: native(1), reply: native(2), rootTarget: native(3), rootRevision: native(4),
    contentRevision: `urn:rezics:content:revision:${id(5)}`, author: native(6),
    parentReply: null, admissionId: id(7) } } };
  const relayClient = { query: async (sql: string) => {
    if (sql.includes('FROM relay.notification_producer_cursor')) return { rows: [{ data_epoch: 'epoch', sequence: '0' }] };
    if (sql.includes('FROM relay.delivered_batch')) return { rows: [{ sequence: '1', event_count: 1 }] };
    if (sql.includes('FROM relay.delivered_event')) return { rows: [{ envelope }] };
    return { rows: [] };
  }, release: () => {} };
  const relay = { connect: async () => relayClient,
    query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '1' }] }) } as unknown as Pool;
  const access = { query: async (sql: string) => {
    if (sql.includes('FROM access.admission')) return { rows: [{ principal_id: id(8) }] };
    if (sql.includes('FROM access.agent_handle')) return { rows: [{ agent_id: native(9) }] };
    if (sql.includes('FROM access.representation')) return { rows: [{ id: id(10) }] };
    throw new Error(`Unexpected Access read: ${sql}`);
  } } as unknown as Pool;
  const content = { query: async () => ({ rows: [{ reply: native(2), author: native(6),
    revisionId: currentRevision, body: 'Hello @ada, and again @ada.', rootTarget: native(3),
    rootRevision: native(4), variantId: id(11), revisionDigest: '0'.repeat(64), originRealm: null }] }) } as unknown as Pool;
  const graph = { query: async () => ({ results: { bindings: [] } }) } as never;
  const producer = new NotificationProducer(access, relay, content, graph,
    { enqueue: async (event: NotificationEvent) => { events.push(event); return []; } } as never,
    'main-graph-v1');
  await producer.runRelayOnce();
  return events;
}

test('one current reply with repeated handle mentions produces one preference controlled mention event', async () => {
  const events = await mentionEvents(id(5));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ purpose: 'social', topic: 'mention', recipients: [id(10)],
    subject: { owner: 'graph', ref: native(2) } });
});

test('an edited reply cannot send a stale mention from its old placement event', async () => {
  expect(await mentionEvents(id(12))).toEqual([]);
});
