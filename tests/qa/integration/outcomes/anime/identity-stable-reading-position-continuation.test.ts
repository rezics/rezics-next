import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorize, exchangeCode, LocalOAuthSession, type LocalOAuthClient } from '../../../../../scripts/lib/oauth-client.ts';
import { outcomeResponse } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { provisionedAgent } from '../../../support/provisioned-agent.ts';

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Page = {
  items: { occurrence: string; target: string; labels: { value: string; language: string }[] }[];
  nextCursor: string | null;
  complete: boolean;
  sourcePosition: { dataEpoch: string; sequence: string };
  count: { value: number; kind: string; total: null };
};
type Metadata = Record<string, unknown>;
type Reader = { person: PersonaSession; oauth: LocalOAuthSession; sessionKey: string; alternate: string };
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const evidence = {
  qaRunId: Bun.env.REZICS_QA_RUN_ID,
  sourceRevision: '',
  preparation: { elapsedMs: 0, status: 'pending' },
  matrix: {} as Record<string, { status: string; elapsedMs: number; reason?: string }>,
  observations: [] as Metadata[],
  http: [] as Metadata[],
};
const evidencePath = `.temp/goal/evidence/identity-stable-reading-position-${Bun.env.REZICS_QA_RUN_ID}.json`;
const persist = () => Bun.write(evidencePath, JSON.stringify(evidence, null, 2));
const short = (id: string) => id.slice(-36);
const responseHeaders = (response: Response) => Object.fromEntries([...response.headers.entries()]
  .filter(([name]) => !['set-cookie', 'authorization', 'proxy-authorization'].includes(name)));
let sessions: PersonaSessions;
let published: Work;
let episode: Work;
let privateWork: Work;
let occurrences: string[];
const readers = new Map<PersonaName, Reader>();
setDefaultTimeout(120_000);

// Only allowlisted, noncredential fields leave the live OAuth client. Decoding
// observes the issued claims; Main's successful HTTP admission verifies them.
function metadata(token: string): Metadata {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Metadata;
  return Object.fromEntries([
    'iss', 'sub', 'aud', 'iat', 'exp', 'nbf', 'scope', 'client_id',
    'rezics_auth_mode', 'rezics_consent_id', 'rezics_consent_generation',
  ].filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
}
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
function journal(name: PersonaName, person: PersonaSession, sessionKey?: string, oauth?: LocalOAuthSession): PersonaSession {
  return { ...person, main: async (method, path, body, key, options) => {
    const started = performance.now();
    const requestAt = new Date().toISOString();
    key ??= ['GET', 'HEAD'].includes(method) ? undefined : randomUUID();
    const claims = oauth ? metadata(oauth.accessToken) : undefined;
    const response = await person.main(method, path, body, key, options);
    evidence.http.push({
      request: { persona: name, service: 'Main', method, path, body, key, sessionKey,
        actingSubject: new URL(path, 'http://main').searchParams.get('actingSubject') ?? person.actingSubject,
        bearer: Boolean(person.accountId), claims },
      response: { status: response.status, headers: responseHeaders(response), raw: await response.clone().text() },
      requestAt, responseAt: new Date().toISOString(), elapsedMs: performance.now() - started,
    });
    await persist();
    return response;
  } };
}
async function readingSession(name: typeof signedIn[number]): Promise<Reader> {
  const person = sessions[name];
  const stack = resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const directory = readdirSync(stack).find(entry => entry.startsWith('g-1005-auth-'));
  if (!directory) throw new Error('Persona OAuth public configuration is unavailable');
  const config = JSON.parse(readFileSync(resolve(stack, directory, 'public.json'), 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string;
  };
  const client: LocalOAuthClient = {
    account: Bun.env.ACCOUNT_BASE_URL!, clientId: config.clientId,
    redirectUri: config.redirectUris[0]!, scope: config.scope, resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/oauth2/authorize')
        return person.account('GET', `${url.pathname}${url.search}`);
      if (url.pathname === '/api/account/consent')
        return person.account('POST', `${url.pathname}${url.search}`, JSON.parse(String(init?.body)));
      const started = performance.now();
      const response = await fetch(input, init);
      if (url.pathname === '/api/auth/oauth2/token') {
        const fields = new URLSearchParams(String(init?.body));
        const raw = await response.clone().json() as Metadata;
        evidence.http.push({
          request: { persona: name, service: 'Account', method: 'POST', path: url.pathname,
            body: Object.fromEntries([...fields].map(([key, value]) => [key,
              ['code', 'code_verifier', 'refresh_token'].includes(key) ? '<redacted>' : value])) },
          response: { status: response.status, headers: responseHeaders(response),
            body: Object.fromEntries(['expires_in', 'scope', 'token_type', 'error'].filter(key => raw[key] !== undefined).map(key => [key, raw[key]])),
            accessTokenIssued: typeof raw.access_token === 'string', refreshTokenIssued: typeof raw.refresh_token === 'string',
            claims: typeof raw.access_token === 'string' ? metadata(raw.access_token) : undefined },
          responseAt: new Date().toISOString(), elapsedMs: performance.now() - started,
        });
        await persist();
      }
      return response;
    },
  };
  const authorized = await authorize(client, '');
  if (!authorized.ok) throw new Error(`Public authorization returned HTTP ${authorized.response.status}`);
  const grant = await exchangeCode(client, authorized);
  const oauth = new LocalOAuthSession(client, grant, Date.now() + (grant.expires_in ?? 300) * 1000);
  const sessionKey = randomUUID();
  const transport: PersonaSession = { ...person, main: async (method, path, body, key) => {
    // Zero window prevents an implicit renewal from contaminating the comparison.
    const headers = new Headers({ authorization: `Bearer ${await oauth.current(Date.now(), 0)}`, 'x-session-key': sessionKey });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (key !== undefined) headers.set('idempotency-key', key);
    const request = (signal: AbortSignal) => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
      method, headers, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return ['GET', 'HEAD'].includes(method) ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  } };
  const recorded = journal(name, transport, sessionKey, oauth);
  const alternate = await provisionedAgent(recorded.main, `Alternate continuation reader ${name}`);
  return { person: recorded, oauth, sessionKey, alternate };
}

async function create(title: string, publish = true): Promise<Work> {
  const owner = sessions.owner;
  const work = await answer<Work>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  if (!publish) return work;
  const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en',
    body: `Original synthetic animation: ${title}. A gardener carries a lantern between seed islands.`, actingSubject: owner.actingSubject,
  }), 201);
  const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
  }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
    contribution: draft.contribution, publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return work;
}
beforeAll(async () => {
  const started = performance.now();
  try {
    const git = Bun.file('.git');
    const gitDirectory = (await git.text()).trim().replace(/^gitdir: /, '');
    const head = readFileSync(resolve(gitDirectory, 'HEAD'), 'utf8').trim();
    evidence.sourceRevision = head.startsWith('ref: ')
      ? readFileSync(resolve(gitDirectory, '../..', head.slice(5)), 'utf8').trim() : head;
    sessions = await personaSessions();
    for (const name of signedIn) readers.set(name, await readingSession(name));
    for (const name of signedIn) sessions[name] = readers.get(name)!.person;
    sessions.visitor = journal('visitor', sessions.visitor);
    const owner = sessions.owner;
    const operator = sessions.operator;
    const authority = await answer<{ authorityEpoch: string }>(operator.main('GET',
      `/v1/access/grants?issuerSubject=${encodeURIComponent(operator.actingSubject!)}`));
    await answer(operator.main('POST', '/v1/access/grant-changes', {
      profile: 'work-create-agent-grant-change-v1', action: 'create', grantId: randomUUID(),
      issuerSubject: operator.actingSubject, expectedAuthorityEpoch: authority.authorityEpoch,
      recipientSubject: owner.actingSubject, validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    published = await create(`Original lantern journeys ${randomUUID()}`);
    episode = await create(`Original lantern episode ${randomUUID()}`);
    privateWork = await create(`Unpublished lantern journey ${randomUUID()}`, false);
    const composition = await answer<Composition>(owner.main('POST', '/v1/compositions', {
      profile: 'work-composition', work: published.work, mainVersion: published.mainVersion, actingSubject: owner.actingSubject,
    }), 201);
    const changed = await answer<Composition>(owner.main('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: owner.actingSubject,
      operations: [1, 2, 3].map(number => ({ op: 'insert', role: 'part', parent: composition.structure,
        position: 'last', target: episode.work, label: { value: `Episode ${number}`, language: 'en' },
        displayLabel: `Episode ${number}`, inclusion: 'required' })),
    }));
    occurrences = changed.occurrences;
    expect(occurrences).toHaveLength(3);
    expect(new Set(occurrences).size).toBe(3);
    expect(performance.now() - started).toBeLessThan(600_000);
    evidence.preparation.status = 'passed';
  } catch (error) {
    evidence.preparation.status = 'failed';
    throw error;
  } finally {
    evidence.preparation.elapsedMs = performance.now() - started;
    await persist();
  }
}, 600_000);
afterAll(async () => { try { await persist(); } finally { await sessions?.close(); } });

const fields = (person: PersonaSession, extra: Record<string, string> = {}) => new URLSearchParams({
  position: 'start', language: 'en', q: 'Episode', limit: '2',
  ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}), ...extra,
});
const readPath = (person: PersonaSession, extra: Record<string, string> = {}) =>
  `/v1/reading-positions/${short(published.work)}?${fields(person, extra)}`;
async function credit(person: PersonaSession) {
  for (const work of [published, episode]) {
    const query = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const credits = await answer<{ items: { role: string; agent: string }[] }>(person.main('GET', `/v1/works/${short(work.work)}/credits${query}`));
    expect(credits.items).toContainEqual(expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }));
    const variants = await answer<{ variants: { author: string; language: string }[] }>(
      person.main('GET', `/v1/main-versions/${short(work.mainVersion)}/native-variants`));
    expect(variants.variants).toContainEqual(expect.objectContaining({ author: sessions.owner.actingSubject, language: 'en' }));
  }
}
function pageIdentities(page: Page, expected: string[]) {
  expect(page.items.map(item => item.occurrence)).toEqual(expected);
  expect(page.items.map(item => item.target)).toEqual(expected.map(() => episode.work));
  for (const item of page.items)
    expect(item.labels).toContainEqual({ value: `Episode ${occurrences.indexOf(item.occurrence) + 1}`, language: 'en' });
  expect(page.count).toEqual({ value: expected.length, kind: 'exact-page', total: null });
  expect(page.complete).toBe(page.nextCursor === null);
}
async function continuation(name: typeof signedIn[number], renew: boolean) {
  const reader = readers.get(name)!;
  const { person, oauth } = reader;
  await credit(person);
  const first = await answer<Page>(person.main('GET', readPath(person)));
  pageIdentities(first, occurrences.slice(0, 2));
  expect(first.nextCursor).not.toBeNull();
  const advertisedAt = Date.now();
  const beforeToken = oauth.accessToken;
  const before = metadata(beforeToken);
  if (renew) {
    // Crossing one real issuance second makes expiry movement observable without
    // waiting for expiry or changing the client's clock or Account authority.
    const issuance = Number(before.iat) * 1000;
    if (Date.now() <= issuance + 1000) await Bun.sleep(issuance + 1001 - Date.now());
    await oauth.current(Date.now(), 360_000);
  }
  const after = metadata(oauth.accessToken);
  evidence.observations.push({ persona: name, comparison: renew ? 'renewal' : 'no-renewal',
    before, after, changedFields: [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])),
    tokenChanged: beforeToken !== oauth.accessToken, scope: oauth.scope, sessionKey: reader.sessionKey,
    actingSubject: person.actingSubject, advertisedCursor: first.nextCursor,
    cursorAgeMsAtReplay: Date.now() - advertisedAt, noRestart: true,
  });
  await persist();
  expect(beforeToken !== oauth.accessToken).toBe(renew);
  for (const key of ['iss', 'sub', 'aud', 'scope', 'client_id', 'rezics_auth_mode', 'rezics_consent_id', 'rezics_consent_generation'])
    expect(after[key], `Renewal changed identity/consent field ${key}`).toEqual(before[key]);
  expect(before.sub).toBe(person.accountId);
  expect(Number(before.exp) * 1000).toBeGreaterThan(Date.now());
  expect(Number(after.exp) * 1000).toBeGreaterThan(Date.now());
  if (renew) expect(Number(after.exp)).toBeGreaterThan(Number(before.exp));
  const response = await person.main('GET', readPath(person, { cursor: first.nextCursor! }));
  // Record post-renewal credit even when the exact advertised continuation fails.
  await credit(person);
  const second = await answer<Page>(Promise.resolve(response));
  pageIdentities(second, occurrences.slice(2));
  expect(second.nextCursor).toBeNull();
  expect(second.sourcePosition).toEqual(first.sourcePosition);
  expect([...first.items, ...second.items].map(item => item.occurrence)).toEqual(occurrences);
}
async function controls(name: PersonaName) {
  const person = sessions[name];
  const first = await answer<Page>(person.main('GET', readPath(person)));
  pageIdentities(first, occurrences.slice(0, 2));
  expect(first.nextCursor).not.toBeNull();
  const cursor = first.nextCursor!;
  const other = sessions[name === 'stranger' ? 'member' : 'stranger'];
  await answer(other.main('GET', readPath(other, { cursor })), 400);
  if (person.actingSubject) {
    pageIdentities(await answer<Page>(other.main('GET', readPath(person))), occurrences.slice(0, 2));
    await answer(other.main('GET', readPath(person, { cursor })), 400);
  }
  await answer(person.main('GET', readPath(person, { cursor, q: 'Episode 3' })), 400);
  const reader = readers.get(name);
  if (reader) {
    // A second publicly provisioned Person is controlled by the same Account:
    // refusal here isolates acting-subject movement from loss of authority.
    const alternate = await answer<Page>(person.main('GET', readPath(person, { actingSubject: reader.alternate })));
    pageIdentities(alternate, occurrences.slice(0, 2));
    await answer(person.main('GET', readPath(person, { cursor, actingSubject: reader.alternate })), 400);
  }
  const hidden = `/v1/reading-positions/${short(privateWork.work)}?${fields(person)}`;
  if (name === 'owner') await answer(person.main('GET', hidden));
  else expect(await answer(person.main('GET', hidden), 404)).toEqual(
    await answer(person.main('GET', `/v1/reading-positions/${randomUUID()}?${fields(person)}`), 404));
}
function proof(name: PersonaName, comparison: string, run: () => Promise<void>) {
  test(`anime/identity-stable-reading-position-continuation / ${name}: ${comparison}`, async () => {
    const started = performance.now();
    try {
      await run();
      evidence.matrix[`${name}/${comparison}`] = { status: 'passed', elapsedMs: performance.now() - started };
    } catch (error) {
      evidence.matrix[`${name}/${comparison}`] = { status: 'failed', elapsedMs: performance.now() - started, reason: String(error) };
      throw error;
    } finally { await persist(); }
  });
}
for (const name of signedIn) {
  proof(name, 'continuation without renewal', () => continuation(name, false));
  proof(name, 'same live session continuation across public renewal', () => continuation(name, true));
  proof(name, 'distinct caller, changed acting subject and disclosure controls', () => controls(name));
}
proof('visitor', 'distinct caller and disclosure controls', () => controls('visitor'));
