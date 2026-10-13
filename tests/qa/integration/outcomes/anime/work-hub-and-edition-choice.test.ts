import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorize, exchangeCode, LocalOAuthSession, type LocalOAuthClient } from '../../../../../scripts/lib/oauth-client.ts';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import { settledWrite } from '../../../support/settled-write.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
type Work = { work: string; mainVersion: string };
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function grant(person: PersonaSession, scope: string, action: string) {
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1 AND active', [person.accountId]);
    expect(principal.rows).toHaveLength(1);
    await grantLaunchRecipeAuthority(pool, principal.rows[0]!.id, person.actingSubject!, scope, action);
  } finally { await pool.end(); }
}
async function publish(title: string): Promise<Work> {
  const owner = sessions.owner;
  const work = await answer<Work>(preparation('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    preparation('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body: `Original fixture animation script by Outcome owner: ${title}.`,
      actingSubject: owner.actingSubject }), 201);
  const publication = await answer<{ publicationDecision: string }>(
    preparation('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
  await answer(preparation('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return work;
}
afterAll(async () => {
  try { await recording.publish(); } finally { await sessions?.close(); }
});

import hub from '../../../../../scripts/qa/cases/outcomes/anime/work-hub-and-edition-choice.ts';
import { seedFirstPublicationDate } from '../../../../../scripts/dev/seed/relation-lexicon.ts';
const recording = new OutcomeRecorder(hub);
const preparation: PersonaSession['main'] = (method, path, body, key) =>
  method === 'GET' ? sessions.owner.main(method, path, body, key)
    : settledWrite(sessions.owner.main.bind(sessions.owner), method, path, body, key);
const DATE_PUBLISHED_PREDICATE = 'https://schema.org/datePublished';
const DATE_PUBLISHED_DEFINITION_NOTATION = 'statement-first-publication-date-v1';
let dated: Work, undated: Work;
const releases: { id: string; revision: string; title: string }[] = [];
beforeAll(async () => {
  sessions = await personaSessions();
  await recording.prepare();
  const owner = sessions.owner, actor = owner.actingSubject!;
  dated = await publish('Original animation: Lantern harbour');
  undated = await publish('Original animation: Undated harbour');
  for (const [scope, action] of [
    ['semantic:create:root', 'semantic.change'],
    [`statement:speak:${actor}`, 'statement.record'],
    ['classification:decide:global', 'statement.decide'],
    ['classification:define:global', 'classification.proposition.define'],
    ['catalogue:verify:root', 'catalogue.verify'],
  ]) await grant(owner, scope!, action!);
  // Public vocabulary creation establishes the Global acceptance context for date decisions.
  await answer(preparation('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null,
    labels: [{ language: 'en', value: 'Original fixture TV animation' }],
    alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
  }), 201);
  const definition = await seedFirstPublicationDate({
    post: <T,>(path: string, body: object, key: string) => answer<T>(preparation('POST', path, body, key), 201),
    authorizeDefinition: receipt => grant(owner, `semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: async key => {
      const response = await preparation('GET', `/v1/lexicon/definitions/${key}?${acting(owner)}`);
      if (response.status === 404) return null;
      const value = await answer<{ definition: string; revision: string; kind: string; lifecycle: string }>(Promise.resolve(response));
      return { component: value.definition, revision: value.revision,
        state: { component: 'definition', kind: 'property', notation: DATE_PUBLISHED_DEFINITION_NOTATION,
          lifecycle: 'active', successor: null, roles: [] } };
    },
  }, actor);
  const statement = await answer<{ statement: string }>(preparation('POST', '/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: dated.work,
    predicate: definition.component, relationDefinition: definition.revision,
    value: { kind: 'literal', lexical: '2004-04-01', datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
    applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
  }), 201);
  await answer(preparation('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
    acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
  }), 201);
  const realization = `https://rezics.com/id/${randomUUID()}`;
  const text = await answer<{ revision: string }>(preparation('PUT',
    `/v1/works/${short(dated.work)}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: { kind: 'unresolved', work: dated.work }, status: 'official', verification: 'verified',
      evidence: `https://rezics.com/id/${randomUUID()}`,
    }));
  for (const title of ['Lantern harbour broadcast', 'Lantern harbour restored release']) {
    const id = `https://rezics.com/id/${randomUUID()}`;
    const release = await answer<{ revision: string }>(preparation('PUT',
      `/v1/works/${short(dated.work)}/releases/${short(id)}`, {
        profile: 'release-v2', id, expectedHead: null, actingSubject: actor,
        kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
        title: { value: title, language: 'en' }, editionStatement: null, publisher: 'Fixture owner',
        publicationYear: 2004, isbn13: null, originalUrl: null, fixedRelease: null,
        identifiers: [], platform: 'Broadcast', territory: null,
        coverage: [{ realization, revision: text.revision, completeness: 'complete' }], evidence: null,
      }));
    releases.push({ id, revision: release.revision, title });
  }
  await answer(preparation('POST', '/v1/compositions', { profile: 'work-composition',
    work: dated.work, mainVersion: dated.mainVersion, actingSubject: actor }), 201);
}, 180_000);

function samplesFor(name: PersonaName, person: PersonaSession) {
  return recording.session(name, {
    main: async (...args) => {
      const response = await person.main(...args);
      if (response.status >= 500) {
        throw new Error(`API fault ${args[0]} ${args[1]} body=${JSON.stringify(args[2])}: ${response.status} ${await response.text()}`);
      }
      return response;
    },
  });
}

// One English visit to /w/{UUID}: keep the server readers' queries, including preview limits.
// Session-cookie reads and anonymous shared decoration are described in the handoff.
async function recordHubVisit(name: PersonaName, person: PersonaSession) {
  const sample = samplesFor(name, person);
  const reads: Promise<unknown>[] = [];
  const faults: unknown[] = [];
  const queue = (pending: Promise<unknown>) => reads.push(pending.catch(error => { faults.push(error); }));
  const id = short(dated.work), root = `/v1/works/${id}`, resource = `/v1/resources/${id}`;
  const viewer = (path: string, fields: Record<string, string> = {}) => {
    const [pathname, existing] = path.split('?');
    const query = new URLSearchParams(existing);
    for (const [key, value] of Object.entries(fields)) query.set(key, value);
    if (person.actingSubject) query.set('actingSubject', person.actingSubject);
    return `${pathname}${query.size ? `?${query}` : ''}`;
  };
  async function read<T>(label: string, path: string, fields: Record<string, string> = {}): Promise<T> {
    const request = viewer(path, fields);
    const response = await sample(label, 'GET', request);
    const raw = await response.text();
    if (response.status >= 500) throw new Error(`Hub API fault GET ${request}: ${response.status} ${raw}`);
    return JSON.parse(raw) as T;
  }
  type Page = { nextCursor?: string | null; next?: string | null };
  async function page<T extends Page>(label: string, path: string, fields: Record<string, string> = {}, cursor = 'cursor') {
    const first = await read<T>(label, path, fields);
    const next = first.nextCursor ?? first.next;
    if (next) await read(`${label}-continuation`, path, { ...fields, [cursor]: next });
    return first;
  }
  try {
    const platform = await sample('hub-platform-access', 'GET', '/v1/me/platform-access');
    await platform.body?.cancel();
    queue(read('hub-work-header', root));
    const [projection, contexts, credits] = await Promise.all([
      read<{ sections: { id: string; href: string }[] }>('hub-resource-page', `${resource}/page`),
      read<{ items: { context: string }[] }>('hub-rating-contexts', `${resource}/rating-contexts`, { scope: 'global' }),
      page<Page & { items: { role: string; agent: string }[] }>('hub-agent-credits', `${root}/agent-credits`),
    ]);
    if (person.actingSubject) queue(read('hub-reader-state', `${root}/reader-state`));
    const context = contexts.items[0]?.context;
    queue(read('hub-ratings', `${resource}/ratings`, { scope: 'global', ...(context ? { context } : {}) }));
    queue(read('hub-reader-stats', `${root}/reader-stats`, context ? { context } : {}));
    if (credits.items.some(item => item.role === 'author')) {
      const author = credits.items.find(item => item.role === 'author')!;
      await page('hub-author-works', `/v1/agents/${short(author.agent)}/works`, { limit: '12' });
    }
    for (const query of ['work-credits', 'work-adoptions']) {
      const body = { profile: 'template-query-v1', query: `https://rezics.com/query/${query}`, revision: 1,
        parameters: { roots: [dated.work] }, presentation: { actingSubject: person.actingSubject ?? undefined } };
      const response = await sample(`hub-${query}`, 'POST', '/v1/query', body);
      const raw = await response.text();
      if (response.status >= 500) throw new Error(`Hub API fault POST /v1/query ${JSON.stringify(body)}: ${response.status} ${raw}`);
      const result = JSON.parse(raw) as { result?: Page };
      if (result.result?.nextCursor) {
        const continuation = await sample(`hub-${query}-continuation`, 'POST', '/v1/query', { ...body, cursor: result.result.nextCursor });
        await continuation.body?.cancel();
      }
    }
    queue(page('hub-rating-populations', '/v1/rating-populations', { target: dated.work, limit: '20' }));
    queue(read('hub-classifications', `${root}/classifications`, { scope: 'global' }));
    queue(page('hub-also-enjoyed', `${root}/also-enjoyed`, { limit: '12' }));
    queue(page('hub-realizations', `${root}/realizations`, { limit: '20' }));
    queue(page('hub-releases', `${root}/releases`, { limit: '20' }));
    queue(page('hub-undated-releases-empty', `/v1/works/${short(undated.work)}/releases`, { limit: '20' }));
    queue(read('hub-availability-parts', `${resource}/parts`, { limit: '1' }));
    queue(page('hub-parts-preview', `${resource}/parts`, { limit: '7' }, 'after'));
    queue(page('hub-wholes-preview', `${resource}/wholes`, { limit: '3' }, 'after'));
    queue(page('hub-connections-preview', `${resource}/relations`, { limit: '20' }, 'after'));
    const statements = projection.sections.find(section => section.id === 'statements');
    if (statements) {
      const facts = await page<Page & { groups: { predicate: string; items: {
        kind: string; value: { kind: string; iri?: string; ref?: string }; qualifiers: { applicability: string[] }
      }[] }[] }>('hub-facts', statements.href);
      const definitions = [...new Set((facts.groups ?? []).map(group => group.predicate))]
        .filter(predicate => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(predicate));
      if (definitions.length) await read('hub-fact-labels', '/v1/lexicon/presentations', { definitions: definitions.join(','), languages: 'en' });
      const resources = [...new Set((facts.groups ?? []).flatMap(group => group.items.flatMap(item => [
        ...item.value.kind === 'resource' ? [item.value.iri ?? item.value.ref!].filter(Boolean) : [],
        ...item.qualifiers.applicability,
      ])))].sort();
      if (resources.length) {
        const response = await sample('hub-fact-names', 'POST', '/v1/resources/summaries', {
          profile: 'resource-summary-batch-v1', resources, ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
        });
        await response.body?.cancel();
      }
    }
    const discussion = projection.sections.find(section => section.id === 'discussion');
    if (discussion) await page('hub-discussion', discussion.href);
    if (context) {
      await page('hub-reviews', `${resource}/reviews`, { context, sort: 'helpful', limit: '10' });
      await page('hub-review-target-relations', `${resource}/relations`, { limit: '32' }, 'after');
    }
    // These readers deliberately use mainApiWithToken(undefined), even for a signed-in visit.
    const publicSample = samplesFor(name, sessions.visitor);
    const facets = await publicSample('hub-facets', 'GET', '/v1/facets');
    await facets.body?.cancel();
    const showcase = await publicSample('hub-showcase', 'POST', '/v1/resources/showcase', {
      profile: 'work-showcase-batch-v1', targets: [dated.work],
    });
    await showcase.body?.cancel();
    // These regions stream independently in the page's server render.
  } finally { await Promise.all(reads); }
  if (faults.length) throw faults[0];
}

async function readingSession(person: PersonaSession): Promise<PersonaSession> {
  if (!person.accountId) return person;
  const stack = resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const directory = readdirSync(stack).find((name) => name.startsWith('g-1005-auth-'));
  if (!directory) throw new Error('Persona OAuth public configuration is unavailable');
  const config = JSON.parse(readFileSync(resolve(stack, directory, 'public.json'), 'utf8')) as {
    clientId: string;
    redirectUris: string[];
    scope: string;
  };
  const client: LocalOAuthClient = {
    account: Bun.env.ACCOUNT_BASE_URL!,
    clientId: config.clientId,
    redirectUri: config.redirectUris[0]!,
    scope: config.scope,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      // The existing Account transport carries this person's live session cookie.
      if (url.pathname === '/api/auth/oauth2/authorize')
        return person.account('GET', `${url.pathname}${url.search}`);
      if (url.pathname === '/api/account/consent')
        return person.account(
          'POST',
          `${url.pathname}${url.search}`,
          JSON.parse(String(init?.body)),
        );
      return fetch(input, init);
    },
  };
  const authorized = await authorize(client, '');
  if (!authorized.ok)
    throw new Error(`Persona authorization returned HTTP ${authorized.response.status}`);
  const grant = await exchangeCode(client, authorized);
  const oauth = new LocalOAuthSession(client, grant, Date.now() + (grant.expires_in ?? 300) * 1000);
  const sessionKey = randomUUID();
  return {
    ...person,
    main: async (method, path, body, key) => {
      const headers = new Headers({
        authorization: `Bearer ${await oauth.current(Date.now(), 60_000)}`,
        'x-session-key': sessionKey,
      });
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (key !== undefined || !['GET', 'HEAD'].includes(method))
        headers.set('idempotency-key', key ?? randomUUID());
      const request = (signal: AbortSignal) =>
        fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      return ['GET', 'HEAD'].includes(method)
        ? outcomeResponse(request)
        : request(AbortSignal.timeout(30_000));
    },
  };
}

async function journey(name: PersonaName) {
  const person = await readingSession(sessions[name]);
  const sample = samplesFor(name, person);
  await recordHubVisit(name, person);
  for (const work of [dated, undated]) {
    const label = work === dated ? 'work' : 'undated-work';
    const query = person.actingSubject ? `?${acting(person)}` : '';
    expect(await answer(sample(`${label}-header`, 'GET', `/v1/works/${short(work.work)}${query}`)))
      .toMatchObject({ id: work.work, disclosure: 'public', selectedLanguage: 'en', types: ['https://schema.org/TVSeries'] });
    const statements = await answer<{ groups: { predicate: string; items: { value?: { lexical: string } }[] }[] }>(
      sample(`${label}-publication-date`, 'GET', `/v1/resources/${short(work.work)}/statements${query}`));
    const dates = statements.groups.filter(group => group.predicate === DATE_PUBLISHED_PREDICATE)
      .flatMap(group => group.items.map(item => item.value?.lexical));
    expect(dates).toEqual(work === dated ? ['2004-04-01'] : []);
    const credit = await sample(`${label}-publication-credit`, 'GET', `/v1/works/${short(work.work)}/credits${query}`);
    expect(credit.status).toBe(200);
    expect(await credit.text()).toContain(sessions.owner.actingSubject!);
  }
  const root = `/v1/works/${short(dated.work)}`;
  const query = person.actingSubject ? `?${acting(person)}` : '';
  const list = await answer<{ items: { id: string }[] }>(sample('edition-inventory', 'GET', `${root}/releases${query}`));
  expect(list.items.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  for (const release of releases) {
    expect(await answer(sample(release === releases[0] ? 'broadcast-edition' : 'restored-edition', 'GET', `${root}/releases/${short(release.id)}${query}`)))
      .toMatchObject({ id: release.id, revision: release.revision, title: { value: release.title } });
  }
  const path = `/v1/me/edition-preferences/${short(dated.work)}`;
  const affected = name === 'owner' ? sessions.member : sessions.owner;
  const deniedStatus = name === 'visitor' ? 401 : 403;
  expect(await answer<{ code: string }>(sample('other-reader-preference-refused', 'GET', `${path}?${acting(affected)}`), deniedStatus))
    .toMatchObject({ code: name === 'visitor' ? 'account_assertion_denied' : 'progress_denied' });
  await answer(sample('other-reader-edition-write-refused', 'PUT', path, { actingSubject: affected.actingSubject, expectedVersion: 0,
    language: 'en', edition: { kind: 'release', resource: releases[0]!.id, revision: releases[0]!.revision } }), deniedStatus);
  if (name === 'visitor') return;
  expect(await answer(sample('edition-preference-empty', 'GET', `${path}?${acting(person)}`))).toBeNull();
  const choices = releases.map(release => ({ key: randomUUID(), body: { actingSubject: person.actingSubject,
    expectedVersion: 0, language: 'en', edition: { kind: 'release', resource: release.id, revision: release.revision } } }));
  const raced = await Promise.all(choices.map((choice, index) => sample(index === 0 ? 'broadcast-edition-choice' : 'restored-edition-choice', 'PUT', path, choice.body, choice.key)));
  expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
  const index = raced.findIndex(response => response.status === 200);
  const saved = await answer<{ version: number; edition: object }>(Promise.resolve(raced[index]!));
  expect(saved).toMatchObject({ version: 1, edition: choices[index]!.body.edition, replayed: false });
  expect(await answer(Promise.resolve(raced[1 - index]!), 409)).toMatchObject({ code: 'stale_edition_preference' });
  expect(await answer(sample('edition-choice-replay', 'PUT', path, choices[index]!.body, choices[index]!.key)))
    .toMatchObject({ ...saved, replayed: true });
  expect(await answer(sample('chosen-edition-progress', 'GET', `/v1/me/progress-summaries/${short(dated.work)}?${acting(person)}&language=en`)))
    .toMatchObject({ preference: { version: 1, edition: choices[index]!.body.edition } });
}
outcomeTest(hub, 'visitor', () => journey('visitor'), recording);
outcomeTest(hub, 'stranger', () => journey('stranger'), recording);
outcomeTest(hub, 'member', () => journey('member'), recording);
outcomeTest(hub, 'owner', () => journey('owner'), recording);
outcomeTest(hub, 'moderator', () => journey('moderator'), recording);
outcomeTest(hub, 'operator', () => journey('operator'), recording);

