import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SavedViewNotifications, SAVED_VIEW_PRODUCER_COST } from '../src/modules/notification-producers/saved-views.ts';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import { savedViewPlan, savedViewConditionsMatch, matchesSavedView, type SavedViewSubject } from '../src/modules/saved-filter/match.ts';
import { QueryRejected } from '../src/modules/query/compile.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';
import { defaultFollowLevel } from '../src/modules/follows/contract.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const subject: SavedViewSubject = { kind: 'work', ref: id(1), work: id(1), target: id(1),
  actor: null, realm: null, language: null };

test('G-965 saved-view matching preserves two Conditions, language variants, anchors and exclusions', () => {
  const document = { all: [{ facet: 'concept', any: [id(2)] }, { facet: 'language', any: ['en'] }] };
  const plan = savedViewPlan(document, 'post');
  expect(savedViewConditionsMatch(plan, new Set([id(2)]), { language: 'en-GB', realm: null })).toBe(true);
  expect(savedViewConditionsMatch(plan, new Set([id(2)]), { language: 'ja', realm: null })).toBe(false);
  expect(savedViewConditionsMatch(plan, new Set(), { language: 'en', realm: null })).toBe(false);
  const anchored = savedViewPlan({ all: [
    { facet: 'concept', all: [id(2)] }, { facet: 'concept', any: [id(3)] },
    { facet: 'concept', none: [id(4)] }, { facet: 'realm', any: [id(5)] },
  ] }, 'post');
  const context = { language: null, realm: id(5) };
  expect(savedViewConditionsMatch(anchored, new Set([id(2), id(3)]), context)).toBe(true);
  expect(savedViewConditionsMatch(anchored, new Set([id(3)]), context)).toBe(false);
  expect(savedViewConditionsMatch(anchored, new Set([id(2), id(3), id(4)]), context)).toBe(false);
  expect(savedViewConditionsMatch(anchored, new Set([id(2), id(3)]), { ...context, realm: id(6) })).toBe(false);
});

test('G-965 exact Work matching uses the merged Query operators and refuses before executing unsupported shapes', async () => {
  const statements: string[] = [];
  const session = { query: async (sql: string) => { statements.push(sql); return [{ r: { value: id(1) } }]; } } as unknown as WorkReadSession;
  expect(await matchesSavedView(session, { all: [
    { facet: 'type', any: ['https://schema.org/Book'] }, { facet: 'language', none: ['ja'] },
  ] }, subject)).toBe(true);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain(`VALUES ?r { <${id(1)}> }`);
  expect(statements[0]).toContain('schema.org/Book');
  expect(statements[0]).toContain('FILTER(!(');
  expect(() => savedViewPlan({ any: [{ facet: 'language', any: ['en'] }] }, 'work')).toThrow(QueryRejected);
  expect(() => savedViewPlan({ all: [{ facet: 'concept', any: [id(2), id(3), id(4), id(5)] }] }, 'work')).toThrow(QueryRejected);
  expect(statements).toHaveLength(1);
  expect(defaultFollowLevel('concept')).toBe('off');
  expect(defaultFollowLevel('saved-view')).toBe('off');
});

function harness(count: number, admitted = true) {
  const rows = Array.from({ length: count }, (_, n) => ({ id: uuid(n + 10), principal_id: uuid(2),
    target: admitted ? `urn:rezics:saved-view:${uuid(n + 10)}` : null, document: { all: [{ facet: 'language', any: ['en'] }] } }));
  let progress = { after_principal: null as string | null, complete: false };
  let pending = { ...progress };
  const sql: string[] = [];
  const client = { query: async (statement: string, args: unknown[] = []) => {
    sql.push(statement);
    if (statement === 'BEGIN') pending = { ...progress };
    if (statement === 'COMMIT') progress = { ...pending };
    if (statement.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (statement.includes('SELECT after_principal,complete')) return { rows: [pending] };
    if (statement.includes('FROM access.saved_filter')) return { rows: rows.filter(row => !args[1] || row.id > String(args[1])).slice(0, Number(args[2])) };
    if (statement.includes('SET after_principal=$3')) pending = { after_principal: args[2] as string | null, complete: args[3] as boolean };
    return { rows: [] };
  }, release: () => {} };
  let available = true;
  const access = { connect: async () => client, query: async () => ({ rows: available ? [rows[0]] : [] }) } as unknown as Pool;
  const emitted = new Map<string, NotificationEvent>();
  let lostAck = false;
  const service = new SavedViewNotifications(access, {} as never, { enqueue: async (event: NotificationEvent) => {
    emitted.set(event.sourceEvent, event);
    if (lostAck) { lostAck = false; throw new Error('lost enqueue acknowledgement'); }
    return [];
  } } as never);
  // Owner hydration is covered by the real integration flow; this harness
  // exercises the actual durable page/relay protocol without a backend stack.
  Object.assign(service, { read: async () => subject, matching: async () => subject });
  return { service, emitted, sql, progress: () => progress, revoke: () => { available = false; },
    loseAck: () => { lostAck = true; } };
}
const envelope = { id: 'event', type: 'com.rezics.work.created.v1', data: { receipt: { work: id(1) } } };

test('G-965 a follower with more than one page resumes after a lost ACK without duplicate intents', async () => {
  const h = harness(SAVED_VIEW_PRODUCER_COST.viewsPerPage + 2);
  h.loseAck();
  await expect(h.service.run(envelope)).rejects.toThrow('lost enqueue acknowledgement');
  expect(h.progress()).toEqual({ after_principal: null, complete: false });
  expect(h.sql).toContain('ROLLBACK');
  expect(await h.service.run(envelope)).toEqual({ complete: false, produced: 8 });
  expect(h.emitted.size).toBe(8);
  expect(h.progress().after_principal).toBe(uuid(17));
  expect(await h.service.run(envelope)).toEqual({ complete: true, produced: 2 });
  expect(h.emitted.size).toBe(10);
  expect(await h.service.run(envelope)).toEqual({ complete: true, produced: 0 });
  expect(h.sql.find(statement => statement.includes('FROM access.saved_filter'))).toContain("f.level='all' OR ($1 AND f.level='highlights')");
});

test('G-965 delivery checks the same native principal and refuses a concurrently removed follow/view', async () => {
  const h = harness(1);
  const input = { principalId: uuid(2), owner: 'access', ref: uuid(10), revision: id(1), disclosureBasis: 'saved-view-work-v1' };
  expect(await h.service.resolve(input)).toMatchObject({ status: 'available' });
  Object.assign(h.service, { matching: async () => { h.revoke(); return subject; } });
  expect(await h.service.resolve(input)).toEqual({ status: 'undisclosed' });
  expect(await h.service.resolve({ ...input, revision: null })).toEqual({ status: 'undisclosed' });
});

test('G-965 pages advance through Off filters without an unbounded recipient scan', async () => {
  const h = harness(10, false);
  expect(await h.service.run(envelope)).toEqual({ complete: false, produced: 0 });
  expect(h.progress().after_principal).toBe(uuid(17));
  expect(await h.service.run(envelope)).toEqual({ complete: true, produced: 0 });
  expect(h.emitted.size).toBe(0);
  const query = h.sql.find(statement => statement.includes('WITH candidates'))!;
  expect(query.indexOf('LIMIT $3')).toBeLessThan(query.indexOf('LEFT JOIN LATERAL'));
});

test('G-965 relay checkpoint waits for all saved-view matching pages', async () => {
  let advanced = false;
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM relay.notification_producer_cursor')) return { rows: [{ data_epoch: 'epoch', sequence: '0' }] };
    if (sql.includes('FROM relay.delivered_batch')) return { rows: [{ sequence: '1', event_count: 1 }] };
    if (sql.includes('FROM relay.delivered_event')) return { rows: [{ envelope: { id: 'unhandled', type: 'test', data: {} } }] };
    if (sql.includes('SET sequence =')) advanced = true;
    return { rows: [] };
  }, release: () => {} };
  const relay = { connect: async () => client } as unknown as Pool;
  const checkpoint = { query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '1' }] }) } as unknown as Pool;
  const producer = new NotificationProducer({} as Pool, relay, {} as Pool, {} as never, {} as never, 'consumer', checkpoint);
  producer.setSavedViews({ run: async () => ({ complete: false, produced: 8 }) });
  expect(await producer.runSavedViewsRelayOnce()).toBe(8);
  expect(advanced).toBe(false);
  producer.setSavedViews({ run: async () => ({ complete: true, produced: 2 }) });
  expect(await producer.runSavedViewsRelayOnce()).toBe(2);
  expect(advanced).toBe(true);
  advanced = false;
  producer.setSavedViews({ run: async () => { throw new Error('query owner unavailable'); } });
  expect(await producer.runRelayOnce()).toBe(0);
  expect(advanced).toBe(true);
});

test('an unsupported saved view is skipped and the following valid view still delivers', async () => {
  const refused = uuid(10);
  const delivered = uuid(11);
  const continued = harness(2);
  Object.assign(continued.service, { matching: async (view: { id: string }) => {
    if (view.id === refused) throw new QueryRejected('unsupported_query_shape', 'no template for this filter');
    return subject;
  } });
  expect(await continued.service.run(envelope)).toEqual({ complete: true, produced: 1 });
  expect([...continued.emitted.keys()]).toEqual([`work-public:${id(1)}:${delivered}`]);

  const blocked = harness(2);
  Object.assign(blocked.service, { matching: async () => { throw new Error('owner down'); } });
  await expect(blocked.service.run(envelope)).rejects.toThrow('owner down');
  expect(blocked.emitted.size).toBe(0);
  expect(blocked.progress()).toEqual({ after_principal: null, complete: false });
});
