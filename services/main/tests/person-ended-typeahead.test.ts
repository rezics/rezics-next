import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { mirrorAccountDeletionIntent } from '../src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../src/modules/outbox/account-subject-deletion.ts';
import { backfillCatalogueNames } from '../src/modules/search/names.ts';
import { GRAPHS, iri, lit } from '../src/modules/work/activate.ts';
import { prefixWalkRequest } from '../src/modules/search/prefix-walk.ts';

type Member = Awaited<ReturnType<typeof fixtureMember>>;
type Item = { work: string; matchedText: string; authors: Array<{ agent: string; displayName: string }> };
let stack: MediaStack;
let closing: Member;
let reader: Member;
let person: string;
let coauthor: string;
let similar: string;
let work: string;
let mainVersion: string;
const marker = randomUUID().replaceAll('-', '');
const name = `Ended${marker} Author Person`;
const alias = `alias${marker.slice(0, 20)}`;
const liveName = `Continuing${marker} Author`;
const similarName = `Ended${marker} Authorship`;
const absent = `Absent${marker}`;

const bearers = new Map<string, VerifiedPrincipal>();

async function fixtureMember(subject: string) {
  const principal = { issuer: 'https://qa-person-disclosure.test', subject, emailVerified: true };
  const principalId = randomUUID();
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const token = randomUUID();
  const client = await stack.accessPool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { principalId, ...principal, actor });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  bearers.set(token, principal);
  const grant = async (scope: string, action: string) => {
    const client = await stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      const lifetime = action === 'agent.control' ? 'infinity' : '8 hours';
      await grantFixtureAuthority(client, { scope, requireDispatch: true,
        representations: [{ principalId, actor, action, lifetime }],
        grant: { actor, action, lifetime } });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const send = (method: string, path: string, body?: unknown) =>
    stack.call(method, path, { token, body, key: randomUUID() });
  return { principal, principalId, actor, token, grant, send };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

async function provision(member: Member, displayName: string): Promise<string> {
  return (await json<{ agent: string }>(await member.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName,
  }), 201)).agent;
}

async function credit(target: string, agent: string): Promise<void> {
  const path = `/v1/works/${target.slice(-36)}`;
  const head = await json<{ revision: string }>(await stack.call('GET', path));
  await json(await reader.send('POST', `${path}/agent-credits`, {
    profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
    agent, role: 'author', expectedWorkHead: head.revision, actingSubject: reader.actor,
  }), 201);
}

const suggest = (prefix: string, token?: string) => stack.call('GET',
  `/v1/search/typeahead?prefix=${encodeURIComponent(prefix)}`, { token });

async function bytes(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

beforeAll(async () => {
  stack = await startMediaStack('person-ended-typeahead');
  // Replace only the Account bearer table; Access owns every fixture identity.
  stack.composition.dependencies.account.verify = async request => {
    const principal = bearers.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (!principal) throw new Error('unknown fixture bearer');
    return { ...principal, currentAssertion: async () => principal };
  };
  closing = await fixtureMember(`closing-${marker}`);
  reader = await fixtureMember(`reader-${marker}`);
  person = await provision(closing, name);
  coauthor = await provision(reader, liveName);
  similar = await provision(await fixtureMember(`similar-${marker}`), similarName);
  // Person aliases belong to the address owner; credit typeahead currently
  // matches display names, so the alias must never resurrect an ended name.
  await json(await closing.send('POST', '/v1/addresses/claims', {
    profile: 'alias-write-v1', operation: 'claim', scope: 'agent', holder: person,
    actingSubject: person, alias, expectedRevision: null,
  }), 201);
  const created = await stack.publicWork(reader.actor, ['en'], `Surviving${marker} Work`);
  work = created.work;
  mainVersion = created.mainVersion;
  await reader.grant(`work:edit:${work}`, 'work.edit');
  await credit(work, person);
  await credit(work, coauthor);
  const otherWork = (await stack.publicWork(reader.actor, ['en'], `Other${marker} Work`)).work;
  await reader.grant(`work:edit:${otherWork}`, 'work.edit');
  await credit(otherWork, similar);
}, 180_000);

afterAll(async () => { await stack?.stop(); });

test('typeahead finds live credited Persons before the real Account deletion fence', async () => {
  for (const token of [undefined, reader.token]) {
    const full = await json<{ items: Item[] }>(await suggest(name, token));
    expect(full.items).toContainEqual(expect.objectContaining({ work, matchedText: name }));
    const prefix = await json<{ items: Item[] }>(await suggest(`Ended${marker}`, token));
    expect(prefix.items.map(item => item.matchedText)).toContain(name);
    expect(prefix.items.map(item => item.matchedText)).toContain(similarName);
    expect((await json<{ items: Item[] }>(await suggest(liveName, token))).items)
      .toContainEqual(expect.objectContaining({ work, matchedText: liveName }));
  }
}, 60_000);

test('Account deletion with consent ends the Person while its graph and native credit index retain the name', async () => {
  const relay = boundedPool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    // Match Account's inline accessDeletionFence hook in services/account/src/index.ts.
    const fence = await stack.access.strongDeactivateAccountSubject(
      closing.principal.issuer, closing.principal.subject, { leaveOwnedAgentsStanding: true });
    if (fence) await mirrorAccountDeletionIntent(stack.accessPool, relay, fence.principalId, fence.enforcementEpoch);
    await retainAccountSubjectDeletion(relay, closing.principal.issuer, closing.principal.subject);
    expect(fence?.principalId).toBe(closing.principalId);
    expect((await relay.query('SELECT authority_epoch::text FROM relay.account_deletion_intent WHERE principal_id = $1',
      [closing.principalId])).rows).toEqual([{ authority_epoch: fence!.enforcementEpoch }]);
    expect((await relay.query('SELECT issuer, account_subject FROM relay.account_subject_deletion WHERE issuer = $1 AND account_subject = $2',
      [closing.principal.issuer, closing.principal.subject])).rows)
      .toEqual([{ issuer: closing.principal.issuer, account_subject: closing.principal.subject }]);
  } finally { await relay.end(); }
  expect((await stack.accessPool.query('SELECT active FROM access.authority_subject WHERE id = $1', [person])).rows)
    .toEqual([{ active: false }]);
  expect((await stack.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(person)} <http://www.w3.org/2000/01/rdf-schema#label> ${lit(name)} } }`)).boolean).toBe(true);
  const native = await stack.fuseki.prefixWalk(prefixWalkRequest({ prefix: name, language: null, pageSize: 10 }));
  expect(JSON.stringify(native)).toContain(mainVersion);
}, 60_000);

for (const phase of ['retained', 'refreshed'] as const) {
  test(`${phase} prefix index does not disclose an ended Person to anonymous or signed-in readers`, async () => {
    if (phase === 'refreshed') expect(await backfillCatalogueNames(stack.env)).toBeGreaterThan(0);
    expect(JSON.stringify(await stack.fuseki.prefixWalk(prefixWalkRequest({ prefix: name,
      language: null, pageSize: 10 })))).toContain(mainVersion);
    for (const token of [undefined, reader.token]) {
      const never = await bytes(await suggest(absent, token));
      expect(never.status).toBe(200);
      expect(JSON.parse(never.body)).toMatchObject({ items: [], hasMore: false });
      for (const prefix of [name, `Ended${marker} Author P`, alias]) {
        expect(await bytes(await suggest(prefix, token))).toEqual(never);
      }
      const broad = await json<{ items: Item[] }>(await suggest(`Ended${marker}`, token));
      expect(broad.items.map(item => item.matchedText)).toEqual([similarName]);
      const live = await json<{ items: Item[] }>(await suggest(liveName, token));
      expect(live.items).toContainEqual(expect.objectContaining({ work, matchedText: liveName }));
      expect(JSON.stringify([...broad.items, ...live.items])).not.toContain(name + '"');
      expect(JSON.stringify([...broad.items, ...live.items])).not.toContain(alias);
    }
  }, 90_000);
}

// Expected failure: the neutral Deleted author credit needs the journal-bound Person attribution tombstone reader, which is wired by the Person erasure owner (declared in modules/profiles/attribution.ts as personAttributionTombstones); until then the credit is omitted while the live coauthor remains.
test.failing('a surviving Work keeps its live coauthor and supplies only neutral deleted attribution for the ended Person', async () => {
  for (const token of [undefined, reader.token]) {
    const credits = await json<{ items: Array<{ agent: string; identityStatus: string; displayName: string; handle: string | null }> }>(
      await stack.call('GET', `/v1/works/${work.slice(-36)}/agent-credits`
        + (token ? `?actingSubject=${encodeURIComponent(coauthor)}` : ''), { token }));
    expect(credits.items).toContainEqual(expect.objectContaining({ agent: coauthor,
      identityStatus: 'active', displayName: liveName }));
    expect(credits.items).toContainEqual(expect.objectContaining({ agent: person,
      identityStatus: 'deleted', displayName: 'Deleted author', handle: null }));
    const deleted = credits.items.find(item => item.agent === person)!;
    for (const field of ['address', 'avatar', 'avatarUrl', 'bio', 'links']) expect(deleted).not.toHaveProperty(field);
    expect(JSON.stringify(credits.items)).not.toContain(name);
    expect(JSON.stringify(credits.items)).not.toContain(alias);
  }
}, 60_000);
