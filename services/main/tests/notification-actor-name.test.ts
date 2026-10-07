import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { namePolicyPrincipal, disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import type { DisclosureChannel } from '../src/modules/disclosure/read.ts';
import { currentNotificationAgentReader, NOTIFICATION_ACTOR_NAME_COST }
  from '../src/modules/notification/subjects.ts';
import { NotificationStore, NotificationUnavailable, type NotificationActorAudience,
  type NotificationAgentReader, type NotificationAgentSummary } from '../src/modules/notification/store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { MediaStore } from '../src/modules/media/store.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lineage = { dataEpoch: 'epoch', routingEpoch: '1' };
const controller: VerifiedPrincipal = { issuer: 'account', subject: 'controller' };
const stranger: VerifiedPrincipal = { issuer: 'account', subject: 'stranger' };
const privateName = 'Private Ada';
const publicName = 'Published Bea';

function graph(names: ReadonlyMap<string, string>) {
  return { query: async (sparql: string) => {
    if (sparql.includes('ASK')) return { boolean: true };
    const agent = [...names.keys()].find(key => sparql.includes(key));
    const name = agent ? names.get(agent) : undefined;
    if (!name) return { results: { bindings: [] } };
    if (name === 'ambiguous') return { results: { bindings: [
      { displayName: { value: 'One' } }, { displayName: { value: 'Two' } }] } };
    return { results: { bindings: [{ displayName: { value: name } }] } };
  } } as unknown as FusekiClient;
}

function policy() {
  const owners = new Map<string, { public: boolean; controller?: string }>([
    [id(1), { public: false, controller: controller.subject }],
    [id(2), { public: true }],
  ]);
  let calls = 0;
  let failed = false;
  const preferences = { async visibleNameOwners(agents: readonly string[],
    principal: VerifiedPrincipal | null) {
    calls += 1;
    if (failed) throw new Error('offline');
    expect(new Set(agents).size).toBe(agents.length);
    expect(agents.length).toBeLessThanOrEqual(NOTIFICATION_ACTOR_NAME_COST.owners);
    return new Set(agents.filter(agent => {
      const row = owners.get(agent);
      return !!row && (row.public || principal?.issuer === controller.issuer
        && principal.subject === row.controller);
    }));
  } };
  return { owners, preferences, calls: () => calls, fail: () => { failed = true; } };
}

function audience(preferences: NotificationActorAudience['preferences'],
  principal: VerifiedPrincipal | null, channel: DisclosureChannel): NotificationActorAudience {
  return { preferences, channel, viewer: principal ? disclosureViewer(principal) : ANONYMOUS_VIEWER };
}

function readerFor(names: ReadonlyMap<string, string>) {
  const media = { avatarRows: async () => ({ rows: new Map(), generation: {
    owner: 'content' as const, dataEpoch: 'epoch', sequence: '0' } }) } as Pick<MediaStore, 'avatarRows'>;
  const handles = { current: async (agent: string) => agent === id(1) ? 'ada' : null };
  return currentNotificationAgentReader(graph(names), lineage, media, handles);
}

function expectOmitted(actor: NotificationAgentSummary | undefined, kept: string) {
  expect(actor).toMatchObject({ id: kept, handle: kept === id(1) ? 'ada' : null, avatar: null });
  expect(actor).not.toHaveProperty('name');
  expect(JSON.stringify(actor)).not.toContain(privateName);
  expect(JSON.stringify(actor)).not.toContain(publicName);
}

test('A private actor name is omitted for a non-controller on inbox, email and push', async () => {
  const names = new Map([[id(1), privateName], [id(2), publicName]]);
  const gate = policy();
  const read = readerFor(names).readBatch!;
  for (const channel of ['inbox', 'email', 'push'] as const) {
    const hidden = await read([id(1)], audience(gate.preferences, stranger, channel));
    expectOmitted(hidden.get(id(1)), id(1));
    const shown = await read([id(1)], audience(gate.preferences, controller, channel));
    expect(shown.get(id(1))).toMatchObject({ id: id(1), name: privateName, handle: 'ada' });
    const anyone = await read([id(2)], audience(gate.preferences, null, channel));
    expect(anyone.get(id(2))).toMatchObject({ id: id(2), name: publicName, handle: null });
  }
  expect(await readerFor(names)(id(1), audience(gate.preferences, stranger, 'inbox')))
    .not.toHaveProperty('name');
});

test('A name made private after the event is omitted on the next inbox and email read', async () => {
  const names = new Map([[id(1), privateName]]);
  const gate = policy();
  gate.owners.get(id(1))!.public = true;
  const read = readerFor(names).readBatch!;
  for (const channel of ['inbox', 'email'] as const) {
    expect((await read([id(1)], audience(gate.preferences, stranger, channel))).get(id(1))?.name)
      .toBe(privateName);
    gate.owners.get(id(1))!.public = false;
    const later = await read([id(1)], audience(gate.preferences, stranger, channel));
    expectOmitted(later.get(id(1)), id(1));
    expect((await read([id(1)], audience(gate.preferences, controller, channel))).get(id(1))?.name)
      .toBe(privateName);
    gate.owners.get(id(1))!.public = true;
  }
});

test('One notification page checks name policy once and withholds only the private actors', async () => {
  const names = new Map([[id(1), privateName], [id(2), publicName], [id(3), 'ambiguous'],
    [id(4), 'Ada\u0000']]);
  const gate = policy();
  const read = readerFor(names).readBatch!;
  const before = gate.calls();
  const page = await read([id(1), id(2), id(1), id(3), id(4), 'not-an-agent'],
    audience(gate.preferences, stranger, 'inbox'));
  expect(gate.calls() - before).toBe(NOTIFICATION_ACTOR_NAME_COST.namePolicyStatements);
  expectOmitted(page.get(id(1)), id(1));
  expect(page.get(id(2))).toMatchObject({ name: publicName });
  expect(page.has(id(3))).toBe(false);
  expect(page.has(id(4))).toBe(false);
  expect(page.has('not-an-agent')).toBe(false);
  const quiet = policy();
  expect([...(await read([id(3)], audience(quiet.preferences, controller, 'push'))).keys()]).toEqual([]);
  expect(quiet.calls()).toBe(0);
});

test('A name-policy failure omits every actor name and keeps the ids', async () => {
  const gate = policy();
  gate.fail();
  const page = await readerFor(new Map([[id(1), privateName], [id(2), publicName]])).readBatch!(
    [id(1), id(2)], audience(gate.preferences, controller, 'email'));
  expectOmitted(page.get(id(1)), id(1));
  expect(page.get(id(2))).toMatchObject({ id: id(2), avatar: null });
  expect(page.get(id(2))).not.toHaveProperty('name');
  expect(JSON.stringify([...page.values()])).not.toContain(publicName);
});

test('The inbox reads every actor name once for the recipient and keeps an id when the name is omitted', async () => {
  const principalId = '00000000-0000-4000-8000-0000000000aa';
  const item = (sequence: string, actor: string) => ({
    id: `00000000-0000-4000-8000-${sequence.padStart(12, '0')}`, sequence, purpose: 'social', topic: 'reply',
    state: 'active' as const, subject_owner: 'graph', subject_ref: id(9), subject_revision: null,
    disclosure_basis: 'actor-name', kind: 'reply' as const, actor_agent: actor, realm: null, group_key: null,
    saved: false, done: false, triage_revision: null, reason: null, proposal: null, proposal_revision: null,
    created_at: new Date('2026-10-07T00:00:00.000Z'), individually_read: false,
  });
  const rows = [item('1', id(1)), item('2', id(2))];
  const query = async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SET LOCAL')) return { rows: [] };
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT id, active FROM access.principal')) return { rows: [{ id: principalId, active: true }] };
    if (sql.includes('FROM access.notification_stream')) return { rows: [{ generation: '1', head_sequence: '2' }] };
    if (sql.includes('FROM access.notification_item')) return { rows };
    if (sql.includes('notification_read_watermark')) return { rows: [{ read_through: '0' }] };
    if (sql.includes('notification_delivery')) return { rows: [] };
    if (sql.includes('person_block')) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  const pool = { connect: async () => client, query } as unknown as Pool;
  const store = new NotificationStore(pool);
  store.setDefaultReadSubjectReader({ async resolve() {
    return { status: 'available', subject: { private: false, fields: { title: 'A work' } } };
  } });
  const batches: { agents: readonly string[]; channel: DisclosureChannel;
    principal: VerifiedPrincipal | null }[] = [];
  const readBatch = async (agents: readonly string[], seen: NotificationActorAudience) => {
    batches.push({ agents, channel: seen.channel, principal: namePolicyPrincipal(seen.viewer) });
    return new Map(agents.map(agent => [agent, agent === id(2)
      ? { id: agent, name: publicName, handle: null, avatar: null }
      : { id: agent, handle: 'ada', avatar: null }]));
  };
  const reader = Object.assign(async () => {
    throw new Error('one read per actor');
  }, { readBatch }) as NotificationAgentReader;
  store.setReadAgentReader(reader);
  const page = await store.readStream(stranger, null);
  expect(batches).toEqual([{ agents: [id(1), id(2)], channel: 'inbox', principal: stranger }]);
  expect(page.items.map(item => item.display?.actor)).toEqual([
    { id: id(1), handle: 'ada', avatar: null },
    { id: id(2), name: publicName, handle: null, avatar: null },
  ]);
  expect(JSON.stringify(page)).not.toContain(privateName);

  const failing = new NotificationStore(pool);
  failing.setDefaultReadSubjectReader({ async resolve() {
    return { status: 'available', subject: { private: false, fields: { title: 'A work' } } };
  } });
  failing.setReadAgentReader(Object.assign(async () => null, {
    readBatch: async () => { throw new Error('graph down'); },
  }) as NotificationAgentReader);
  await expect(failing.readStream(stranger, null)).rejects.toBeInstanceOf(NotificationUnavailable);
});
