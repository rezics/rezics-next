import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessActingContexts, ActingContextUnavailable, currentGate, transaction }
  from '../src/modules/access/contexts.ts';
import { AccessSessionAgents } from '../src/modules/access/session-agent.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { FusekiHttpError, type FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = '00000000-0000-4000-8000-000000000002';
const principal: VerifiedPrincipal = { issuer: 'https://account.invalid', subject: 'eligible', emailVerified: true };

/** Real discovery, topology and preference owners; only their SQL/graph I/O is supplied. */
function identityFixture() {
  const state = { active: true, recovery: true, gate: true, names: true,
    nameFailure: null as Error | null, graphFailure: null as Error | null,
    choiceFailure: null as Error | null, sessionRevision: null as string | null };
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('WITH fence AS MATERIALIZED')) {
      if (state.nameFailure) throw state.nameFailure;
      return { rows: [{ agent, open: state.recovery, visible: state.names }] };
    }
    if (sql.includes('LEFT JOIN gate ON true')) return { rows: [{ recovery_open: state.recovery,
      authority_epoch: '7', open: state.gate, dispatch_open: state.gate }] };
    if (sql.includes('SELECT open FROM access.recovery_fence')) return { rows: [{ open: state.recovery }] };
    if (sql.includes('SELECT id FROM access.principal')) return { rows: state.active
      && values[0] === principal.issuer && values[1] === principal.subject ? [{ id: 'principal' }] : [] };
    if (sql.includes('SELECT p.id, preference.acting_subject')) return { rows: state.active
      && values[0] === principal.issuer && values[1] === principal.subject
      ? [{ id: 'principal', acting_subject: null, revision: null }] : [] };
    if (sql.includes('operational_bounds_activation')) return { rows: [{
      id: 'access-operational-bounds-v1', acting_contexts: 50, group_depth: 32, groups_per_scope: 256,
      memberships_per_scope: 1024, member_groups_per_agent: 16, private_groups_per_principal: 16, roles_per_principal: 16,
      acting_subject: agent,
    }] };
    if (sql.includes('SELECT DISTINCT recipient_subject FROM access.permission_grant')) return { rows: [{ recipient_subject: agent }] };
    if (sql.includes('access.read_platform_permissions') || sql.includes('FROM access.agent_provision WHERE principal_id')
      || sql.includes('FROM access.principal_agent_attribution')) return { rows: [] };
    if (sql.includes('WITH RECURSIVE path AS')) return { rows: [{
      subject: agent, action: 'agent.control', representation_id: 'mandate', edge_ids: [],
    }] };
    if (sql.includes('SELECT r.id FROM access.representation')) return { rows: [{ id: 'mandate' }] };
    if (sql.includes('FROM access.representation_edge e') || sql.includes('WITH candidates AS')) return { rows: [] };
    if (sql.includes('SELECT id FROM access.authority_subject')) return { rows: [{ id: agent }] };
    if (sql.includes('FROM access.alias_registry')) return { rows: [{ agent_id: agent, handle: 'reader' }] };
    if (sql.includes('AS session_subject') || sql.includes('SELECT m.acting_subject')) {
      if (state.choiceFailure) throw state.choiceFailure;
      expect(sql).toContain('p.account_issuer = $1 AND p.account_subject = $2 AND p.active');
      if (values[0] !== principal.issuer || values[1] !== principal.subject) return { rows: [] };
      return { rows: sql.includes('AS session_subject')
        ? [{ session_subject: null, session_revision: state.sessionRevision, main_subject: agent, main_revision: revision }]
        : [{ acting_subject: agent, revision }] };
    }
    if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected identity owner query: ${sql}`);
  };
  const client = { query, release: () => {} } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pool;
  const fuseki = { query: async (sql: string) => {
    if (state.graphFailure) throw state.graphFailure;
    if (sql.includes('ASK')) return { boolean: true };
    if (sql.includes('SELECT ?agent')) return { results: { bindings: [{
      agent: { value: agent }, label: { value: 'Reader', 'xml:lang': 'en' },
      kind: { value: 'https://rezics.com/vocab/PersonAgent' },
    }] } };
    throw new Error(`Unexpected identity graph query: ${sql}`);
  } } as unknown as FusekiClient;
  const environment: WorkActivationEnvironment = { fuseki, objectDirectory: '.temp/identity-owner',
    lineage: { dataEpoch: 'identity-owner', routingEpoch: 'one' } };
  const contexts = new AccessActingContexts(pool, environment);
  return { state, queries, pool, client, contexts, choices: new AccessSessionAgents(pool, contexts) };
}

test('eligible identity discovery keeps live labels and remains independent of a closed task gate', async () => {
  const f = identityFixture();
  expect(await f.contexts.discover(principal)).toMatchObject({ complete: true, contexts: [{
    actingSubject: agent, handle: 'reader', kind: 'person', displayName: 'Reader',
  }], directContexts: [] });
  f.state.gate = false;
  expect(await f.contexts.discoverAgents(principal)).toMatchObject({ complete: true, items: [{
    actingSubject: agent, handle: 'reader', kind: 'person', displayName: { value: 'Reader', language: 'en' },
  }] });
  expect(await f.contexts.discover(principal)).toMatchObject({ contexts: [], directContexts: [], complete: true });
  f.state.names = false;
  expect((await f.contexts.discoverAgents(principal)).items[0]?.displayName).toBeNull();
  f.state.active = false;
  const before = f.queries.length;
  expect(await f.contexts.discoverAgents(principal)).toEqual({ profile: 'agent-discovery-v1', items: [], complete: true });
  expect(f.queries.slice(before).some(q => q.sql.includes('operational_bounds_activation'))).toBe(false);
});

test('a name-policy outage is unavailable with its cause, never a successful null-name inventory', async () => {
  const f = identityFixture();
  const cause = Object.assign(new Error('owner connection closed'), { code: '08006' });
  f.state.nameFailure = cause;
  const error = await f.contexts.discoverAgents(principal).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ActingContextUnavailable);
  expect(error).toMatchObject({ code: 'identity_labels_unavailable', cause: {
    code: 'identity_names_unavailable', cause,
  } });
  await expect(f.contexts.discover(principal)).rejects.toMatchObject({ code: 'identity_labels_unavailable', cause: {
    code: 'identity_names_unavailable', cause,
  } });
  f.state.nameFailure = null;
  expect((await f.contexts.discoverAgents(principal)).items[0]?.displayName?.value).toBe('Reader');
});

test('held recovery and malformed gates are unavailable, while a closed gate is an eligibility state', async () => {
  const f = identityFixture();
  f.state.recovery = false;
  await expect(f.contexts.discoverAgents(principal)).rejects.toMatchObject({ code: 'access_recovery_held' });
  await expect(currentGate(f.client)).rejects.toMatchObject({ code: 'access_recovery_held' });
  const malformed = { query: async () => ({ rows: [{ recovery_open: true }] }) } as unknown as PoolClient;
  await expect(currentGate(malformed)).rejects.toMatchObject({ code: 'work_create_gate_unavailable' });
  f.state.recovery = true;
  f.state.gate = false;
  expect(await currentGate(f.client)).toMatchObject({ authority_epoch: '7', open: false, dispatch_open: false });
});

test('authority connection and mid-transaction transport failures retain exact causal evidence', async () => {
  const cause = Object.assign(new Error('transport refused'), { code: 'ECONNREFUSED' });
  const failedPool = { connect: async () => { throw cause; } } as unknown as Pool;
  await expect(transaction(failedPool, async () => 'unreached')).rejects.toMatchObject({
    code: 'authority_dependency_unavailable', cause,
  });
  const f = identityFixture();
  await expect(transaction(f.pool, async () => { throw cause; })).rejects.toMatchObject({
    code: 'authority_dependency_unavailable', cause,
  });
  expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
});

test('saved identity reads keep explicit unselection, main suggestion and Account ownership separate', async () => {
  const f = identityFixture();
  expect(await f.choices.readSession(principal, revision)).toMatchObject({ initialActingSubject: agent,
    sessionAgent: { actingSubject: null, revision: null }, mainAgent: { actingSubject: agent, eligible: true } });
  f.state.sessionRevision = revision;
  expect(await f.choices.readSession(principal, revision)).toMatchObject({ initialActingSubject: null,
    sessionAgent: { actingSubject: null, revision }, mainAgent: { actingSubject: agent, eligible: true } });
  expect(await f.choices.readMain({ ...principal, issuer: 'https://foreign.invalid' })).toMatchObject({
    mainAgent: { actingSubject: null, revision: null, eligible: false },
  });
  expect(await f.choices.readSession({ ...principal, subject: 'another-account' }, revision)).toMatchObject({
    sessionAgent: { actingSubject: null, revision: null, eligible: false },
    mainAgent: { actingSubject: null, revision: null, eligible: false }, initialActingSubject: null,
  });
  expect((await f.contexts.discoverAgents({ ...principal, subject: 'another-account' })).items).toEqual([]);
});

test('identity dependency failures never clear saved choices and recover on the next read', async () => {
  const f = identityFixture();
  const graph = new FusekiHttpError('owner held', 503, 'Unavailable');
  f.state.graphFailure = graph;
  await expect(f.choices.readSession(principal, revision)).rejects.toMatchObject({
    code: 'identity_labels_unavailable', cause: graph,
  });
  f.state.graphFailure = null;
  const database = Object.assign(new Error('lookup timed out'), { code: '57014' });
  f.state.choiceFailure = database;
  for (const read of [() => f.choices.readSession(principal, revision), () => f.choices.readMain(principal)]) {
    await expect(read()).rejects.toMatchObject({ code: 'identity_choices_unavailable', cause: database });
  }
  f.state.choiceFailure = null;
  expect((await f.choices.readMain(principal)).mainAgent.actingSubject).toBe(agent);
  expect(f.queries.some(q => /^(INSERT|UPDATE|DELETE)/.test(q.sql))).toBe(false);
});
