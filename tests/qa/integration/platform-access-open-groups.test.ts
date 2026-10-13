import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { signIn, type LocalOAuthSession } from '../../../scripts/lib/oauth-client.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { mainConfig } from '../../../services/main/src/config.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessExposure, type ExposureSummary } from '../../../services/main/src/modules/access/exposure.ts';
import { exposureDeclarations } from '../../../services/main/src/modules/access/exposure-declarations.ts';
import { bindPlatformExposure, exposureOperationId } from '../../../services/main/src/modules/access/exposure-routes.ts';
import { platformAccessRoutes } from '../../../services/main/src/routes/platform-access.ts';
import { realmAppealRoutes, openApiOperations as appealOperations } from '../../../services/main/src/routes/realm-appeals.ts';
import { managementReadRoutes } from '../../../services/main/src/routes/management-reads.ts';
import { commerceRoutes } from '../../../services/main/src/routes/commerce.ts';
import { joiningAuthFixture } from '../support/joining-auth.ts';
import { personaNames, personaSessions, type PersonaName, type PersonaSessions } from '../support/personas.ts';

const openedGroup = 'realm-appeals';
const subsetGroups = [openedGroup, 'saved-views'];
const banDeclaration = '/v1/realms/{realm}/member-ban';
const banOperation = exposureOperationId('GET', banDeclaration);
const declaredGroups = [...new Set(exposureDeclarations.flatMap(owner => Object.values(owner)
  .flatMap(methods => Object.values(methods))
  .filter(entry => entry.exposure.startsWith('platform:'))
  .map(entry => entry.exposure.slice('platform:'.length))))].sort();
const sortedUnion = (...groups: string[][]) => [...new Set(groups.flat())].sort();
type Configuration = 'closed' | 'omitted' | 'subset' | 'wildcard';
type Observation = { configuration: Configuration; persona: PersonaName; request: string;
  expectedGroups: string[]; actual: ExposureSummary };
type Grant = { id: string; generation: string };
let sessions: PersonaSessions | undefined;
const pools: Pool[] = [];
const servers: Elysia[] = [];
const origins = {} as Record<Configuration, string>;
const tokens: Partial<Record<PersonaName, LocalOAuthSession>> = {};
const observations = new Map<string, Observation>();
const controls: string[] = [];
let memberBanPath = '';
let evidencePath = '';

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  // Setup and host failures must never be consumed by test.failing.
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function http(configuration: Configuration, persona: PersonaName, path: string,
  body?: unknown, bearer?: string) {
  const token = bearer ?? await tokens[persona]?.current();
  return fetch(`${origins[configuration]}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function summary(configuration: Configuration, persona: PersonaName) {
  const response = await http(configuration, persona, '/v1/me/platform-access');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await answer<ExposureSummary>(Promise.resolve(response));
  expect(Object.keys(body).sort()).toEqual(['generation', 'groups', 'operations']);
  expect(body.groups).toBeArray();
  expect(body.operations).toBeArray();
  expect(body.groups.every(group => typeof group === 'string')).toBe(true);
  expect(body.operations.every(operation => typeof operation === 'string')).toBe(true);
  expect(body.generation).toBeString();
  expect(body.generation.length).toBeGreaterThan(0);
  expect(new Set(body.groups).size).toBe(body.groups.length);
  return body;
}

async function observe(configuration: Configuration, persona: PersonaName, expectedGroups: string[], label = '') {
  const actual = await summary(configuration, persona);
  const observation = { configuration, persona, request: 'GET /v1/me/platform-access', expectedGroups, actual };
  observations.set(`${configuration}/${persona}${label}`, observation);
  console.log(`Platform summary contract: ${JSON.stringify(observation)}`);
  return actual;
}

async function changeGrant(change: object): Promise<Grant> {
  if (!sessions) throw new Error('Platform contract fixture is not ready');
  const operator = sessions.operator;
  const page = await answer<{ authorityEpoch: string }>(operator.main('GET',
    `/v1/access/grants?${new URLSearchParams({ issuerSubject: operator.actingSubject!, profile: 'platform-grants-v1' })}`));
  const result = await answer<{ grant: Grant }>(operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', issuerSubject: operator.actingSubject,
    expectedAuthorityEpoch: page.authorityEpoch, ...change,
  }));
  return result.grant;
}

async function grant(permission: string, validUntil: string | null = null) {
  const member = sessions?.member;
  if (!member?.accountId) throw new Error('Platform grant requires the member');
  const principal = await pools[0]!.query<{ id: string }>(
    'SELECT id FROM access.principal WHERE account_subject=$1', [member.accountId]);
  expect(principal.rows).toHaveLength(1);
  return changeGrant({ action: 'create', grantId: randomUUID(), permission,
    recipient: { principalId: principal.rows[0]!.id }, validUntil });
}

async function revoke(value: Grant) {
  await changeGrant({ action: 'revoke', grantId: value.id, expectedObjectGeneration: value.generation });
}

function assertGroups(key: string) {
  const observation = observations.get(key);
  if (!observation) throw new Error(`Missing qualified HTTP observation: ${key}`);
  try {
    expect(observation.actual.groups.toSorted(), JSON.stringify(observation)).toEqual(observation.expectedGroups);
  } catch (error) {
    appendFileSync(resolve(dirname(evidencePath), 'failed-assertions.jsonl'), JSON.stringify({ key, ...observation,
      assertion: error instanceof Error ? error.message : String(error) }) + '\n');
    throw error;
  }
}

beforeAll(async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated integration QA tier');
  const started = performance.now();
  sessions = await personaSessions('private');
  // A separate first-party client uses the existing personas' Account cookie
  // transport. Account still performs PKCE, consent, signing and introspection.
  const auth = await joiningAuthFixture(runId);
  const publicAuth = JSON.parse(readFileSync(auth.publicConfigPath, 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string;
  };
  const runtime = readEnv(auth.runtimeEnvPath);
  for (const persona of personaNames.filter(name => name !== 'visitor')) {
    const person = sessions[persona];
    tokens[persona] = await signIn({ account: Bun.env.ACCOUNT_BASE_URL!,
      clientId: publicAuth.clientId, redirectUri: publicAuth.redirectUris[0]!,
      scope: publicAuth.scope, resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
      fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/auth/oauth2/authorize' || url.pathname === '/api/account/consent')
          return person.account(init?.method ?? 'GET', url.toString(),
            typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined);
        return fetch(input, init);
      },
    }, '');
  }
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  pools.push(accessPool, contentPool, relayPool);
  const composed = await composeMain({ config: mainConfig({ ...process.env, ...runtime,
    PLATFORM_FIRST_ADMIN_ACCOUNT: undefined }), accessPool, contentPool, relayPool,
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN) });
  const environments = { closed: { REZICS_PLATFORM_OPEN_GROUPS: '' },
    omitted: { NODE_ENV: 'production' }, subset: { REZICS_PLATFORM_OPEN_GROUPS: `${subsetGroups.join(',')},${openedGroup}` },
    wildcard: { REZICS_PLATFORM_OPEN_GROUPS: '*' } };
  for (const configuration of Object.keys(environments) as Configuration[]) {
    const work = { ...composed.dependencies, platformAccess: new AccessExposure(accessPool, environments[configuration]) };
    const app = new Elysia().use(platformAccessRoutes(work)).use(realmAppealRoutes(work))
      .use(managementReadRoutes(work)).use(commerceRoutes(composed.fuseki, work))
      .get('/contract/undeclared', () => ({ reached: true }))
      .use(bindPlatformExposure(work, exposureDeclarations));
    servers.push(app);
    app.listen({ hostname: '127.0.0.1', port: 0 });
    origins[configuration] = `http://127.0.0.1:${app.server!.port}`;
  }
  expect(appealOperations[banDeclaration].get.exposure).toBe(`platform:${openedGroup}`);
  expect(Object.values(appealOperations).flatMap(methods => Object.values(methods))
    .every(entry => entry.exposure === `platform:${openedGroup}`)).toBe(true);
  expect(declaredGroups).toContain(openedGroup);
  expect(declaredGroups).toContain('commerce');
  expect(declaredGroups).not.toContain('*');

  const owner = sessions.owner, member = sessions.member;
  const root = `/v1/realms/${sessions.realm.slice(-36)}`;
  const members = await answer<{ generation: string; items: { member: string; membershipGeneration: string }[] }>(
    owner.main('GET', `${root}/members?${new URLSearchParams({ actingSubject: owner.actingSubject! })}`));
  const membership = members.items.find(item => item.member === member.actingSubject);
  expect(membership).toBeDefined();
  const ban = await answer<{ receiptId: string }>(owner.main('POST', `${root}/members`, {
    actingSubject: owner.actingSubject, member: member.actingSubject, action: 'ban',
    expectedGeneration: members.generation, expectedMembershipGeneration: membership!.membershipGeneration,
    reason: 'Synthetic sanction for deployment visibility', consent: null, durationSeconds: null,
  }), 201);
  memberBanPath = `${root}/member-ban?${new URLSearchParams({ actingSubject: member.actingSubject! })}`;
  const appealPath = `${root}/member-receipts/${ban.receiptId}/appeal`;
  const siblingPath = `/v1/subscriptions/benefits?${new URLSearchParams({ beneficiary: member.actingSubject! })}`;

  const baseline = {} as Record<PersonaName, ExposureSummary>;
  for (const persona of personaNames) {
    baseline[persona] = await summary('closed', persona);
    expect(baseline[persona].groups.sort()).toEqual(persona === 'operator' ? ['platform-admin'] : []);
    expect(baseline[persona].operations).toEqual([]);
    expect((await summary('omitted', persona)).groups.sort()).toEqual(baseline[persona].groups);
  }
  for (const configuration of ['closed', 'omitted'] as const) {
    await answer(http(configuration, 'member', memberBanPath), 404);
    await answer(http(configuration, 'visitor', memberBanPath), 404);
    expect(await answer(http(configuration, 'member', siblingPath), 403)).toMatchObject({ code: 'platform_closed' });
  }
  controls.push('all callers: HTTP 200, declared groups/operations/generation shape and private, no-store caching');
  controls.push('explicit closed and omitted outside QA fallback: all six baseline summaries; member/visitor ban hidden; commerce refused');

  for (const persona of personaNames) {
    await observe('subset', persona, sortedUnion(subsetGroups, baseline[persona].groups));
    await observe('wildcard', persona, sortedUnion(declaredGroups, baseline[persona].groups));
    // The second authenticated summary exercises the same owner's warm cache.
    expect(await summary('wildcard', persona)).toEqual(observations.get(`wildcard/${persona}`)!.actual);
  }
  for (const configuration of ['subset', 'wildcard'] as const) {
    expect(await answer(http(configuration, 'member', memberBanPath))).toMatchObject({ receiptId: ban.receiptId });
    await answer(http(configuration, 'member', appealPath, { statement: 'Please review the synthetic sanction.' }), configuration === 'subset' ? 201 : 409);
    const moderationPath = `${root}/moderation?${new URLSearchParams({ actingSubject: sessions.stranger.actingSubject!, state: 'open' })}`;
    await answer(http(configuration, 'stranger', moderationPath), 404);
    await answer(http(configuration, 'owner', `${root}/moderation?${new URLSearchParams({ actingSubject: owner.actingSubject!, state: 'open' })}`));
    expect(await answer(http(configuration, 'member', '/contract/undeclared'), 403)).toMatchObject({ code: 'platform_closed' });
    expect(await answer(http(configuration, 'visitor', '/v1/me/platform-access', undefined, 'invalid-bearer'), 401))
      .toMatchObject({ code: 'invalid_account_assertion' });
  }
  controls.push('subset/wildcard: own ban 200 and appeal 201/409; unauthorized moderation 404 versus owner 200; undeclared operation 403; invalid bearer 401');
  expect(await answer(http('subset', 'member', siblingPath), 403)).toMatchObject({ code: 'platform_closed' });
  expect(observations.get('subset/member')!.actual.groups).not.toContain('commerce');

  const unrelated = await grant('platform:use:events');
  expect((await summary('closed', 'member')).groups).toEqual(['events']);
  await answer(http('closed', 'member', memberBanPath), 404);
  expect(await answer(http('subset', 'member', siblingPath), 403)).toMatchObject({ code: 'platform_closed' });
  const overlapping = await grant(`platform:use:${openedGroup}`);
  const individual = await grant(`platform:use:${banOperation}`);
  const grantedSubset = await observe('subset', 'member', sortedUnion(subsetGroups, ['events']), '/granted');
  expect(grantedSubset.operations).toEqual([banOperation]);
  expect(await summary('subset', 'member')).toEqual(grantedSubset);
  const grantedWildcard = await observe('wildcard', 'member', declaredGroups, '/granted');
  expect(grantedWildcard.operations).toEqual([banOperation]);
  expect(await summary('wildcard', 'member')).toEqual(grantedWildcard);
  await revoke(overlapping);
  expect(await answer(http('closed', 'member', memberBanPath))).toMatchObject({ receiptId: ban.receiptId });
  await revoke(individual);
  await answer(http('closed', 'member', memberBanPath), 404);
  expect((await summary('closed', 'member')).operations).toEqual([]);
  await revoke(unrelated);
  expect((await summary('closed', 'member')).groups).toEqual([]);
  const expiring = await grant(`platform:use:${openedGroup}`, new Date(Date.now() + 3_000).toISOString());
  expect((await summary('closed', 'member')).groups).toEqual([openedGroup]);
  expect(await answer(http('closed', 'member', memberBanPath))).toMatchObject({ receiptId: ban.receiptId });
  await Bun.sleep(3_100);
  expect((await summary('closed', 'member')).groups).toEqual([]);
  await answer(http('closed', 'member', memberBanPath), 404);
  await revoke(expiring);
  controls.push('unrelated group cannot open appeals/commerce; overlapping group and individual operation retained; cache invalidated by public revocation and expiry');

  const elapsedSeconds = (performance.now() - started) / 1_000;
  expect(elapsedSeconds).toBeLessThan(600);
  evidencePath = resolve('.temp', 'platform-access-open-groups', runId, 'evidence.json');
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify({ runId, elapsedSeconds, declaredGroups, environments,
    observations: Object.fromEntries(observations), controls }, null, 2) + '\n');
  console.log(`Platform summary evidence: ${evidencePath}; preparation and controls ${elapsedSeconds.toFixed(2)}s`);
}, 600_000);

afterAll(async () => {
  try { await Promise.all(servers.map(server => server.stop(true))); }
  finally {
    try { await Promise.all(pools.map(pool => pool.end())); }
    finally { await sessions?.close(); }
  }
});

test('Deployment visibility controls qualify real HTTP answers before expected summary failures', () => {
  expect(controls).toHaveLength(4);
  expect(evidencePath).not.toBe('');
  expect(observations.size).toBe(14);
});

// Pending contract outcomes retain the exact required answer. Only the group
// comparison is expected to fail; HTTP, shape, cache and authority checks above
// are ordinary assertions, so an outage cannot qualify a summary defect.
for (const configuration of ['subset', 'wildcard'] as const) {
  for (const persona of personaNames) {
    test.failing(`Deployment ${configuration} summary reports opened groups for ${persona}`, () => {
      assertGroups(`${configuration}/${persona}`);
    });
  }
}
test.failing('Deployment subset summary unions actual group grants without duplicates and retains operation grants', () => {
  assertGroups('subset/member/granted');
});
test.failing('Deployment wildcard summary includes every declared group on the granted authenticated cache path', () => {
  assertGroups('wildcard/member/granted');
});
