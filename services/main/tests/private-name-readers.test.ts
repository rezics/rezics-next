import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { RV } from '../src/modules/work/activate.ts';
import { readAgentCards } from '../src/modules/profiles/read.ts';
import { AccessRealmRoster } from '../src/modules/access/roster.ts';
import { RealmAdminInvalid } from '../src/modules/realm-admin/contract.ts';
import { AccessActingContexts } from '../src/modules/access/contexts.ts';
import { namedDiscoveryCredits } from '../src/modules/discovery/credits.ts';
import { searchCatalogue } from '../src/modules/catalogue-intake/search.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const privateAgent = id(1);
const publicAgent = id(2);
const controller = { issuer: 'account', subject: 'controller' };
const stranger = { issuer: 'account', subject: 'stranger' };
const privateName = 'Private Pen';
const publicName = 'Public Author';

function allowed(agent: string, issuer: unknown, subject: unknown, namePublic: boolean) {
  return agent !== privateAgent || namePublic || (issuer === controller.issuer && subject === controller.subject);
}

function nameGate() {
  let reads = 0;
  let namePublic = false;
  const preferences = {
    async visibleNameOwners(agents: readonly string[], principal: VerifiedPrincipal | null) {
      reads += 1;
      return new Set(agents.filter((agent) => allowed(agent, principal?.issuer, principal?.subject, namePublic)));
    },
  };
  return {
    preferences,
    reads: () => reads,
    publish() { namePublic = true; },
  };
}

function cardSession(gate: ReturnType<typeof nameGate>, viewer: typeof ANONYMOUS_VIEWER) {
  return {
    viewer,
    displayLanguages: ['en'],
    deps: {
      personPreferences: gate.preferences,
      profiles: { agentFences: async (agents: string[]) => new Map(agents.map((agent) => [agent, 'live'])) },
    },
    async query(sparql: string) {
      return [privateAgent, publicAgent].filter((agent) => sparql.includes(`<${agent}>`)).map((agent) => ({
        agent: { value: agent },
        displayName: { value: agent === privateAgent ? privateName : publicName },
        agentKind: { value: `${RV}PersonAgent` },
        agentHead: { value: id(agent === privateAgent ? 11 : 12) },
      }));
    },
  } as unknown as WorkReadSession;
}

test('agent cards withhold a private name from an anonymous viewer and show it to its controller', async () => {
  const gate = nameGate();
  const page = [privateAgent, publicAgent];
  const hidden = await readAgentCards(cardSession(gate, ANONYMOUS_VIEWER), page);
  expect(hidden.has(privateAgent)).toBe(false);
  expect(hidden.get(publicAgent)?.displayName).toBe(publicName);
  expect(JSON.stringify([...hidden.values()])).not.toContain(privateName);
  expect(gate.reads()).toBe(1);

  const shown = await readAgentCards(cardSession(gate, disclosureViewer(controller)), page);
  expect(shown.get(privateAgent)?.displayName).toBe(privateName);
  expect(shown.get(publicAgent)?.displayName).toBe(publicName);
  expect(gate.reads()).toBe(2);

  const strangerCards = await readAgentCards(cardSession(gate, disclosureViewer(stranger)), page);
  expect(strangerCards.has(privateAgent)).toBe(false);
  expect(gate.reads()).toBe(3);

  gate.publish();
  const published = await readAgentCards(cardSession(gate, ANONYMOUS_VIEWER), page);
  expect(published.get(privateAgent)?.displayName).toBe(privateName);
  expect(gate.reads()).toBe(4);

  const outage = nameGate();
  outage.preferences.visibleNameOwners = async () => { throw new Error('preferences offline'); };
  const withheld = await readAgentCards(cardSession(outage, disclosureViewer(controller)), page);
  expect(withheld.has(privateAgent)).toBe(false);
  expect(withheld.has(publicAgent)).toBe(false);
});

const bounds = {
  id: 'access-operational-bounds-v1', acting_contexts: 50, group_depth: 32, groups_per_scope: 256,
  memberships_per_scope: 1024, member_groups_per_agent: 16, private_groups_per_principal: 16,
  roles_per_principal: 16,
};

function accessPool(namePublic: { value: boolean }) {
  let policyReads = 0;
  const query = async (sql: string, args: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET )/i.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('profile_visibility')) {
      policyReads += 1;
      const agents = args[0] as string[];
      return { rows: agents.map((agent) => ({ agent, open: true,
        visible: allowed(agent, args[1], args[2], namePublic.value) })), rowCount: agents.length };
    }
    if (sql.includes('alias_registry')) return { rows: [], rowCount: 0 };
    if (sql.includes('recovery_open')) return { rows: [{ recovery_open: true, authority_epoch: '3', open: true,
      dispatch_open: true }], rowCount: 1 };
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }], rowCount: 1 };
    if (sql.includes('scope_gate')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('realm_admin_settings')) return { rows: [], rowCount: 0 };
    if (sql.includes('acting_context_preference')) return { rows: [{ id: 'principal-1', acting_subject: null,
      revision: null }], rowCount: 1 };
    if (sql.includes('operational_bounds_profile') && sql.includes('acting_subject')) {
      return { rows: [privateAgent, publicAgent].map((acting_subject) => ({ ...bounds, acting_subject })), rowCount: 2 };
    }
    if (sql.includes('operational_bounds_profile')) return { rows: [bounds], rowCount: 1 };
    if (sql.includes('WITH RECURSIVE path')) return { rows: [], rowCount: 0 };
    if (sql.includes('agent_invitation')) return { rows: [], rowCount: 0 };
    if (sql.includes('FOR SHARE OF r, s')) return { rows: [], rowCount: 0 };
    if (sql.includes('WITH candidates AS')) return { rows: [privateAgent, publicAgent].map((subject) => ({ subject })),
      rowCount: 2 };
    if (sql.includes('SELECT id FROM access.authority_subject')) {
      return { rows: (args[0] as string[]).map((agent) => ({ id: agent })), rowCount: (args[0] as string[]).length };
    }
    if (sql.includes('SELECT id FROM access.principal')) return { rows: [{ id: 'principal-1' }], rowCount: 1 };
    if (sql.includes('permission_grant')) return { rows: [privateAgent, publicAgent].map((recipient_subject) =>
      ({ recipient_subject })), rowCount: 2 };
    if (sql.includes('read_platform_permissions')) return { rows: [], rowCount: 0 };
    if (sql.includes('principal_agent_attribution')) return { rows: [], rowCount: 0 };
    if (sql.includes('display_name')) return { rows: [
      { member: privateAgent, featured: false, display_name: privateName },
      { member: publicAgent, featured: false, display_name: publicName },
    ], rowCount: 2 };
    if (sql.includes('realm_roster_listing')) return { rows: [
      { member: privateAgent, membership_id: '00000000-0000-4000-8000-0000000000a1' },
      { member: publicAgent, membership_id: '00000000-0000-4000-8000-0000000000a2' },
    ], rowCount: 2 };
    throw new RealmAdminInvalid(`unexpected sql: ${sql.slice(0, 240)}`);
  };
  const pool = {
    query,
    async connect() {
      const client = { query, release() {} };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, policyReads: () => policyReads };
}

function labelEnvironment(): WorkActivationEnvironment {
  return {
    fuseki: { query: async (sparql: string) => {
      if (sparql.includes('ASK')) return { boolean: true };
      return { results: { bindings: [privateAgent, publicAgent].map((agent) => ({
        agent: { type: 'uri', value: agent },
        label: { type: 'literal', value: agent === privateAgent ? privateName : publicName, 'xml:lang': 'en' },
        kind: { type: 'uri', value: `${RV}PersonAgent` },
      })) } };
    } },
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/private-names',
  } as unknown as WorkActivationEnvironment;
}

test('the public roster keeps a member and withholds a private name', async () => {
  const namePublic = { value: false };
  const access = accessPool(namePublic);
  const realm = id(9);
  const fuseki = { query: async () => ({ results: { bindings: [{
    space: { value: id(8) }, disclosure: { value: `${RV}Public` }, visibility: { value: 'public' },
    mode: { value: 'mandatory' }, listing: { value: 'listed' }, history: { value: 'everything' },
    admission: { value: 'invitation' }, head: { value: 'rev-1' },
  }] } }) };
  const roster = new AccessRealmRoster(access.pool, { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/private-names' } as unknown as WorkActivationEnvironment);
  const hidden = await roster.read(realm, {});
  expect(hidden.items).toEqual([
    { agent: privateAgent, displayName: null, featured: false },
    { agent: publicAgent, displayName: publicName, featured: false },
  ]);
  expect(JSON.stringify(hidden)).not.toContain(privateName);
  expect(access.policyReads()).toBe(1);

  const shown = await roster.read(realm, {}, controller);
  expect(shown.items.find((item) => item.agent === privateAgent)?.displayName).toBe(privateName);
  expect(access.policyReads()).toBe(2);

  const strangerPage = await roster.read(realm, {}, stranger);
  expect(strangerPage.items.find((item) => item.agent === privateAgent)?.displayName).toBeNull();
  expect(access.policyReads()).toBe(3);

  namePublic.value = true;
  const published = await roster.read(realm, {});
  expect(published.items.find((item) => item.agent === privateAgent)?.displayName).toBe(privateName);
  expect(access.policyReads()).toBe(4);
});

test('acting-context labels withhold a private name from a principal who does not control it', async () => {
  const namePublic = { value: false };
  const access = accessPool(namePublic);
  const contexts = new AccessActingContexts(access.pool, labelEnvironment());
  const hiddenAgents = await contexts.discoverAgents(stranger);
  expect(hiddenAgents.items.find((item) => item.actingSubject === privateAgent)?.displayName).toBeNull();
  expect(hiddenAgents.items.find((item) => item.actingSubject === publicAgent)?.displayName)
    .toMatchObject({ value: publicName });
  expect(JSON.stringify(hiddenAgents.items.find((item) => item.actingSubject === privateAgent))).not.toContain(privateName);
  const afterAgents = access.policyReads();
  expect(afterAgents).toBe(1);

  const shownAgents = await contexts.discoverAgents(controller);
  expect(shownAgents.items.find((item) => item.actingSubject === privateAgent)?.displayName)
    .toMatchObject({ value: privateName });
  expect(access.policyReads()).toBe(afterAgents + 1);

  const hiddenContexts = await contexts.discover(stranger);
  expect(hiddenContexts.contexts.find((item) => item.actingSubject === privateAgent)?.displayName).toBeNull();
  expect(hiddenContexts.contexts.find((item) => item.actingSubject === publicAgent)?.displayName).toBe(publicName);
  expect(JSON.stringify(hiddenContexts.contexts.find((item) => item.actingSubject === privateAgent))).not.toContain(privateName);
  const afterContexts = access.policyReads();
  expect(afterContexts).toBe(afterAgents + 2);

  const shownContexts = await contexts.discover(controller);
  expect(shownContexts.contexts.find((item) => item.actingSubject === privateAgent)?.displayName).toBe(privateName);
  expect(access.policyReads()).toBe(afterContexts + 1);

  namePublic.value = true;
  const published = await contexts.discover(stranger);
  expect(published.contexts.find((item) => item.actingSubject === privateAgent)?.displayName).toBe(privateName);
  expect(access.policyReads()).toBe(afterContexts + 2);
});

function credit(agent: string) {
  return { id: id(20), role: 'author' as const, participantKind: 'agent' as const, provider: null, key: null,
    ordinal: null, agent, displayName: null, handle: null };
}

test('discovery credits withhold a private name from an anonymous viewer and show it to its controller', async () => {
  const gate = nameGate();
  const credits = [credit(privateAgent), credit(publicAgent)];
  const session = (viewer: typeof ANONYMOUS_VIEWER) => ({
    viewer, deps: { personPreferences: gate.preferences },
    async query(sparql: string) {
      return [privateAgent, publicAgent].filter((agent) => sparql.includes(`<${agent}>`)).map((agent) => ({
        agent: { value: agent }, displayName: { value: agent === privateAgent ? privateName : publicName },
      }));
    },
  }) as unknown as WorkReadSession;
  const hidden = await namedDiscoveryCredits(session(ANONYMOUS_VIEWER), credits);
  expect(hidden.has(privateAgent)).toBe(false);
  expect(hidden.get(publicAgent)?.displayName).toBe(publicName);
  expect(JSON.stringify([...hidden.values()])).not.toContain(privateName);
  expect(gate.reads()).toBe(1);

  const shown = await namedDiscoveryCredits(session(disclosureViewer(controller)), credits);
  expect(shown.get(privateAgent)?.displayName).toBe(privateName);
  expect(gate.reads()).toBe(2);

  gate.publish();
  const published = await namedDiscoveryCredits(session(ANONYMOUS_VIEWER), credits);
  expect(published.get(privateAgent)?.displayName).toBe(privateName);
  expect(gate.reads()).toBe(3);
});

test('a private creator name never matches or appears for an anonymous catalogue reader', async () => {
  const gate = nameGate();
  const otherWork = id(10);
  const privateWork = id(11);
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const fuseki = {
    async commandHealth() {
      return { instanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '2',
        publicSearchWriteActive: false, publicSearchDeltaAvailable: true };
    },
    async query(sparql: string) {
      if (sparql.includes('text:query')) return { results: { bindings: [] } };
      if (sparql.includes('NativeAgentCredit')) {
        expect(sparql).toContain('?agent');
        return { results: { bindings: [
          { work: { value: otherWork }, agent: { value: publicAgent },
            displayName: { value: publicName, 'xml:lang': 'en' } },
          { work: { value: privateWork }, agent: { value: privateAgent },
            displayName: { value: privateName, 'xml:lang': 'en' } },
        ] } };
      }
      if (sparql.includes('?alias')) return { results: { bindings: [] } };
      if (sparql.includes('?head')) return { results: { bindings: [otherWork, privateWork].map((work) => ({
        work: { value: work }, main: { value: id(work === otherWork ? 30 : 31) },
        head: { value: id(work === otherWork ? 40 : 41) },
        title: { value: 'Rain', 'xml:lang': 'en' },
      })) } };
      if (sparql.includes('SELECT DISTINCT ?work')) return { results: { bindings: [
        { work: { value: otherWork } }, { work: { value: privateWork } },
      ] } };
      throw new Error(`unexpected catalogue query: ${sparql.slice(0, 160)}`);
    },
  };
  const deps = { environment: { fuseki, lineage, objectDirectory: '.temp/private-names' },
    personPreferences: gate.preferences } as unknown as MainWorkDependencies;
  const input = { profile: 'catalogue-candidates-v1' as const, originalTitle: { value: 'Rain', language: 'en' },
    aliases: [], romanizations: [], creators: [privateName], dates: [], identifiers: [] };
  const search = (principal: VerifiedPrincipal | null = null) => searchGraphSnapshot.run({
    clients: new Set([fuseki as unknown as FusekiClient]), lineage,
    position: { dataEpoch: 'epoch', sequence: '1',
      generation: 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001',
      population: 0, serverInstanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '2' },
  }, () => searchCatalogue(deps, input, principal));
  const creators = (result: Awaited<ReturnType<typeof search>>, work: string) =>
    result.candidates.find((candidate) => candidate.work === work)!.attributes
      .filter((attribute) => attribute.field === 'creator').map((attribute) => attribute.value);

  const hidden = await search();
  expect(creators(hidden, privateWork)).toEqual([]);
  expect(creators(hidden, otherWork)).toEqual([publicName]);
  expect(hidden.candidates.map((candidate) => candidate.work)).toEqual([otherWork, privateWork]);
  expect(JSON.stringify(hidden)).not.toContain(privateName);
  expect(gate.reads()).toBe(1);

  const shown = await search(controller);
  expect(creators(shown, privateWork)).toEqual([privateName]);
  expect(shown.candidates.map((candidate) => candidate.work)).toEqual([privateWork, otherWork]);
  expect(gate.reads()).toBe(2);

  const strangerResult = await search(stranger);
  expect(creators(strangerResult, privateWork)).toEqual([]);
  expect(gate.reads()).toBe(3);

  gate.publish();
  const published = await search();
  expect(creators(published, privateWork)).toEqual([privateName]);
  expect(published.candidates[0]?.work).toBe(privateWork);
  expect(gate.reads()).toBe(4);
});
