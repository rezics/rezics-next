import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  authorize,
  exchangeCode,
  LocalOAuthSession,
  type LocalOAuthClient,
} from '../../../../../scripts/lib/oauth-client.ts';
import inventory from '../../../../../scripts/qa/cases/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Page = {
  items: { occurrence: string; work?: string; labels: { value: string; language: string }[] }[];
  nextCursor: string | null;
  complete: boolean;
  count: { value: number; kind: string; total: null };
  search?: { status: string };
};
// Six personas each record the thousand-episode inventory: every contents page,
// every limit-100 inventory page, and the distant-label search. Measured Main
// calls stay under five seconds, so the file time is the sum of those reads.
// This outcome keeps that visit inside its own 600 s case budget. The shared
// harness class budget is unchanged.
setDefaultTimeout(600_000);
let sessions: PersonaSessions;
let published: Work;
let privateWork: Work;
const episodes: Work[] = [];
const occurrences: string[] = [];
const recording = new OutcomeRecorder(inventory);
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession, fields: Record<string, string> = {}) =>
  new URLSearchParams({
    position: 'start',
    language: 'en',
    ...fields,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

type ProductionAnswer<T> = { data: T | null; error: { status: number; value?: unknown } | null };

/**
 * The browser's Main client, recording each request the contents page sends.
 * A moved first page is the reader's one retry, under the same call.
 */
function productionClient(name: PersonaName, person: PersonaSession) {
  const sample = recording.session(name, person);
  const used = new Set<string>();
  let label = 'production';
  const main = browserMainApi('https://recorded.invalid', {
    anonymous: !person.actingSubject,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${BFF_PREFIX}/`)) {
        throw new Error(`Expected the Main browser boundary: ${url.pathname}`);
      }
      const chosen = used.has(label) ? `${label}-retry` : label;
      used.add(chosen);
      const raw = await request.text();
      return sample(chosen, request.method, url.pathname.slice(BFF_PREFIX.length) + url.search,
        raw ? JSON.parse(raw) as unknown : undefined,
        request.headers.get('idempotency-key') ?? undefined);
    }) as typeof fetch,
  });
  const host = { main, actingSubject: person.actingSubject ?? undefined };
  return {
    host,
    read<T>(next: string, call: () => Promise<T>): Promise<T> {
      label = next;
      return call();
    },
  };
}

/** Reading-position query in the page's key order. The page size stays 100. */
function inventoryQuery(person: PersonaSession, fields: { q?: string; cursor?: string; limit?: number }) {
  return {
    position: 'start' as const,
    language: 'en',
    ...(fields.q ? { q: fields.q } : {}),
    ...(fields.limit !== undefined ? { limit: fields.limit } : {}),
    ...(fields.cursor ? { cursor: fields.cursor } : {}),
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  };
}

beforeAll(async () => {
  const started = performance.now();
  sessions = await personaSessions();
  await recording.prepare();
  sessions.owner = await readingSession(sessions.owner, 'owner');
  const operatorMain = sessions.operator.main.bind(sessions.operator);
  sessions.operator = {
    ...sessions.operator,
    main: (method, path, body, key) => timedMain('operator', method, path, body,
      () => operatorMain(method, path, body, key)),
  };
  const owner = sessions.owner;
  const operator = sessions.operator;
  const authority = await answer<{ authorityEpoch: string }>(
    operator.main(
      'GET',
      `/v1/access/grants?issuerSubject=${encodeURIComponent(operator.actingSubject!)}`,
    ),
  );
  await answer(
    operator.main('POST', '/v1/access/grant-changes', {
      profile: 'work-create-agent-grant-change-v1',
      action: 'create',
      grantId: randomUUID(),
      issuerSubject: operator.actingSubject,
      expectedAuthorityEpoch: authority.authorityEpoch,
      recipientSubject: owner.actingSubject,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  const create = async (title: string, type: string, publish = true) => {
    const work = await answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title,
        language: 'en',
        semanticTypes: [type],
        authoring: 'own-work',
        actingSubject: owner.actingSubject,
      }),
      201,
    );
    if (publish) {
      const draft = await answer<{ contribution: string; draftRevision: string }>(
        owner.main('POST', '/v1/contributions', {
          profile: 'text-contribution-v1',
          work: work.work,
          language: 'en',
          body: `Original synthetic ${title}: the gardener sails to another seed island and records the journey.`,
          actingSubject: owner.actingSubject,
        }),
        201,
      );
      const publication = await answer<{ publicationDecision: string }>(
        owner.main('POST', '/v1/contribution-publications', {
          profile: 'text-publication-v1',
          contribution: draft.contribution,
          expectedDraftHead: draft.draftRevision,
          expectedPublicationHead: null,
          rightsBasis: 'original-contribution',
          disclosure: 'public',
          actingSubject: owner.actingSubject,
        }),
        201,
      );
      await answer(
        owner.main('POST', '/v1/publication-selections', {
          profile: 'main-default-selection-v1',
          context: { kind: 'main-version-default', id: work.mainVersion },
          work: work.work,
          contribution: draft.contribution,
          publicationDecision: publication.publicationDecision,
          expectedSelectionHead: null,
          selectionBasis: 'main-maintainer',
          actingSubject: owner.actingSubject,
        }),
        201,
      );
    }
    return work;
  };
  const tag = randomUUID();
  published = await create(`Animated thousand seed islands ${tag}`, 'https://schema.org/TVSeries');
  privateWork = await create(
    `Unpublished seed islands ${tag}`,
    'https://schema.org/TVSeries',
    false,
  );
  // The series intentionally repeats four original episodes. Each numbered
  // appearance has its own occurrence identity, label and reading position.
  // Inventory size is the number of disclosed appearances, not unique Works.
  for (let index = 0; index < 4; index++) {
    episodes.push(
      await create(`Seed episode ${index + 1} ${tag}`, 'https://schema.org/VideoObject'),
    );
  }
  let composition = await answer<Composition>(
    owner.main('POST', '/v1/compositions', {
      profile: 'work-composition',
      work: published.work,
      mainVersion: published.mainVersion,
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  for (let offset = 0; offset < 1000; offset += 16) {
    composition = await answer<Composition>(
      owner.main('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'work-composition',
        expectedHead: composition.revision,
        actingSubject: owner.actingSubject,
        operations: Array.from({ length: Math.min(16, 1000 - offset) }, (_, index) => {
          const number = offset + index + 1;
          const label =
            number === 1000
              ? 'Episode 1000 重逢'
              : number === 999
                ? 'Episode 999 再会'
                : `Episode ${number}`;
          return {
            op: 'insert',
            role: 'part',
            parent: composition.structure,
            position: 'last',
            target: episodes[(number - 1) % episodes.length]!.work,
            label: { value: label, language: 'en' },
            displayLabel: label,
            inclusion: 'required',
          };
        }),
      }),
    );
    occurrences.push(...composition.occurrences);
  }
  expect(performance.now() - started).toBeLessThan(600_000);
}, 600_000);
afterAll(async () => {
  try {
    writeRequestTimes();
    await recording.publish();
  }
  finally { await sessions?.close(); }
});

async function credit(person: PersonaSession, work: Work, sample?: ReturnType<OutcomeRecorder['session']>, label = 'work') {
  const fields = query(person);
  fields.delete('position');
  const credits = await answer<{ items: { role: string; agent: string }[] }>(
    sample ? sample(`${label}-credits`, 'GET', `/v1/works/${short(work.work)}/credits?${fields}`)
      : person.main('GET', `/v1/works/${short(work.work)}/credits?${fields}`),
  );
  expect(credits.items).toContainEqual(
    expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }),
  );
  const variants = await answer<{ variants: { author: string; language: string }[] }>(
    sample ? sample(`${label}-native-variants`, 'GET', `/v1/main-versions/${short(work.mainVersion)}/native-variants`)
      : person.main('GET', `/v1/main-versions/${short(work.mainVersion)}/native-variants`),
  );
  expect(variants.variants).toContainEqual(
    expect.objectContaining({ author: sessions.owner.actingSubject, language: 'en' }),
  );
}

// Page reads return their first answer, including any dependency failure.
const isContentsRead = (method: string, path: string) =>
  method === 'GET' && /^\/v1\/works\/[^/?]+\/contents(?:\?|$)/.test(path);

type RequestTime = {
  persona: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  body?: unknown;
  response?: string;
};
const requestTimes: RequestTime[] = [];

/** Wall time of one Main call. A call at or over five seconds keeps its body and response for the handoff. */
async function timedMain(persona: string, method: string, path: string, body: unknown,
  call: () => Promise<Response>): Promise<Response> {
  const started = performance.now();
  try {
    const response = await call();
    const ms = performance.now() - started;
    const slow = ms >= 5000;
    let responseText: string | undefined;
    if (slow) {
      try { responseText = (await response.clone().text()).slice(0, 800); }
      catch { responseText = '<unreadable>'; }
    }
    requestTimes.push({
      persona, method, path, status: response.status, ms,
      ...(slow && body !== undefined ? { body } : {}),
      ...(responseText !== undefined ? { response: responseText } : {}),
    });
    return response;
  } catch (error) {
    requestTimes.push({
      persona, method, path, status: 0, ms: performance.now() - started,
      ...(body !== undefined ? { body } : {}),
      response: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function writeRequestTimes(): void {
  const sorted = [...requestTimes].sort((left, right) => right.ms - left.ms);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]?.ms ?? 0;
  const summary = {
    count: requestTimes.length,
    totalMs: Math.round(requestTimes.reduce((sum, item) => sum + item.ms, 0)),
    maxMs: sorted[0]?.ms ?? 0,
    p50Ms: at(0.5),
    p95Ms: at(0.05),
    over1s: sorted.filter(item => item.ms >= 1000).length,
    over5s: sorted.filter(item => item.ms >= 5000).length,
    slowest: sorted.slice(0, 15).map(item => ({ ...item, ms: Math.round(item.ms) })),
  };
  mkdirSync('.temp/g-2224-request-times', { recursive: true });
  writeFileSync('.temp/g-2224-request-times/summary.json', `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync('.temp/g-2224-request-times/requests.jsonl', requestTimes
    .map(item => JSON.stringify({ ...item, ms: Math.round(item.ms) })).join('\n') + '\n');
  console.info(`request-timing count=${summary.count} total=${summary.totalMs}ms max=${Math.round(summary.maxMs)}ms p95=${Math.round(summary.p95Ms)}ms over1s=${summary.over1s} over5s=${summary.over5s}`);
}

async function readingSession(person: PersonaSession, persona: string): Promise<PersonaSession> {
  if (!person.accountId) return {
    ...person,
    main: (method, path, body) => timedMain(persona, method, path, body, () => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
        method, redirect: 'manual', signal: AbortSignal.timeout(isContentsRead(method, path) ? 5000 : 30_000),
      })),
  };
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
        timedMain(persona, method, path, body, () => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }));
      if (isContentsRead(method, path)) return request(AbortSignal.timeout(5000));
      return request(AbortSignal.timeout(30_000));
    },
  };
}

async function navigate(name: PersonaName) {
  let partName = 'authorization';
  let partRequests = ['Account authorize, consent and token exchange'];
  let partStarted = performance.now();
  const elapsed = () => {
    const ms = performance.now() - partStarted;
    console.info(`${name} ${partName}: ${ms.toFixed(2)}ms${ms > 60_000 ? ` requests: ${partRequests.join('; ')}` : ''}`);
  };
  const nextPart = (label: string, requests: string[]) => {
    elapsed(); partName = label; partRequests = requests; partStarted = performance.now();
  };
  try {
    const person = await readingSession(sessions[name], name);
    const sample = recording.session(name, person);
    const production = productionClient(name, person);
    const path = `/v1/reading-positions/${short(published.work)}`;
    const workId = short(published.work);
    const read = (fields: Record<string, string> = {}, label?: string) =>
      answer<Page>(label ? sample(label, 'GET', `${path}?${query(person, fields)}`)
        : person.main('GET', `${path}?${query(person, fields)}`));
    nextPart('contents-page', ['GET /v1/works/{id}, /v1/works/{id}/contents (all pages), /v1/reading-positions/{id} (preview and search)']);
    await contentsPageReads(name, sample, person, production);
    nextPart('credits', ['GET /v1/works/{id}/credits, /v1/main-versions/{id}/native-variants']);
    await credit(person, published, sample);
    nextPart('inventory', ['GET /v1/reading-positions/{id}?position=start&limit=100 (all pages)']);
    // The page reads contents, then the inventory, at the selected language. One prelude covers the first window.
    await production.read('selected-language-contents', () => production.host.main.v1.works({ id: workId }).contents.get({
      query: { actingSubject: person.actingSubject ?? undefined, language: 'en' },
    }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let restarts = 0;
    do {
      expect(++pages).toBeLessThan(1100);
      if (cursor) {
        const pageCursor = cursor;
        await production.read(`inventory-contents-${pages}`, () => production.host.main.v1.works({ id: workId }).contents.get({
          query: { actingSubject: person.actingSubject ?? undefined, language: 'en', cursor: pageCursor },
        }));
      }
      const loaded = await production.read(`inventory-read-${pages}`, () => production.host.main.v1['reading-positions']({ work: workId }).get({
        query: inventoryQuery(person, { limit: 100, cursor: cursor ?? undefined }),
      }));
      if (loaded.error?.status === 409) {
        expect(loaded.error.value).toMatchObject({ code: 'read_basis_changed' });
        expect(++restarts).toBeLessThan(20);
        seen.length = 0;
        cursor = null;
        continue;
      }
      if (loaded.error || !loaded.data) {
        throw new Error(`${name} inventory-read-${pages} ${loaded.error?.status}: ${JSON.stringify(loaded.error?.value).slice(0, 400)}`);
      }
      const page = loaded.data as Page;
      expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
      expect(page.complete).toBe(page.nextCursor === null);
      seen.push(...page.items.map((item) => item.occurrence));
      cursor = page.nextCursor;
    } while (cursor || seen.length === 0);
    expect(seen).toEqual(occurrences);
    expect(new Set(seen).size).toBe(1000);
    nextPart('distant-search', ['GET /v1/reading-positions/{id}?q=Episode 1000 重逢 (all windows), episode credits and native variants']);
    // Work composition uses label search. A bare numeric seek is a separately
    // refused contract and is unnecessary to find the numbered distant episode.
    for (const [q, number] of [['Episode 1000 重逢', 1000]] as const) {
      const matches: Page['items'] = [];
      let searchCursor: string | null = null;
      let searchPages = 0;
      do {
        expect(++searchPages).toBeLessThan(1100);
        // One visit follows the cursor this search returned. The first window is not requested again,
        // and the page that shows the episode is that continuation, not a second sample.
        if (searchCursor) {
          const pageCursor = searchCursor;
          await production.read(`distant-episode-contents-${searchPages}`, () =>
            production.host.main.v1.works({ id: workId }).contents.get({
              query: { actingSubject: person.actingSubject ?? undefined, language: 'en', cursor: pageCursor },
            }));
        }
        const label = searchPages === 1 ? 'distant-episode-search' : `distant-episode-window-${searchPages}`;
        const loaded = await production.read(label, () => production.host.main.v1['reading-positions']({ work: workId }).get({
          query: inventoryQuery(person, { q, limit: 100, cursor: searchCursor ?? undefined }),
        }));
        if (loaded.error || !loaded.data) {
          throw new Error(`${name} ${label} ${loaded.error?.status}: ${JSON.stringify(loaded.error?.value).slice(0, 400)}`);
        }
        const page = loaded.data as Page;
        expect(page.search).toEqual({ status: 'current' });
        expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
        expect(page.complete).toBe(page.nextCursor === null);
        matches.push(...page.items);
        searchCursor = page.nextCursor;
      } while (searchCursor);
      expect(matches, `Completed GET ${path}?q=${q}: ${JSON.stringify(matches)}`).toHaveLength(1);
      expect(matches[0]?.occurrence).toBe(occurrences[number - 1]);
      expect(matches[0]?.labels).toContainEqual({ value: q, language: 'en' });
      await credit(person, episodes[(number - 1) % episodes.length]!, sample, 'distant-episode');
    }
    nextPart('continuation-and-concealment', ['GET /v1/reading-positions/{id} (cursor, identity, private Work and empty-search controls), Work credits']);
    const first = await read({ limit: '2' }, 'inventory-start');
    expect(first.nextCursor).not.toBeNull();
    const second = await read({ limit: '2', cursor: first.nextCursor! }, 'inventory-continuation');
    expect(second.items.map((item) => item.occurrence)).toEqual(occurrences.slice(2, 4));
    await answer(
      sample('cursor-query-refused',
        'GET',
        `${path}?${query(person, { q: 'Episode 8', limit: '2', cursor: first.nextCursor! })}`,
      ),
      400,
    );
    const otherName = name === 'stranger' ? 'member' : 'stranger';
    const other = await readingSession(sessions[otherName], otherName);
    await answer(
      other.main('GET', `${path}?${query(other, { limit: '2', cursor: first.nextCursor! })}`),
      400,
    );
    const hiddenPath = `/v1/reading-positions/${short(privateWork.work)}?${query(person)}`;
    if (name === 'owner') await answer(sample('private-inventory', 'GET', hiddenPath));
    else
      expect(await answer(sample('private-inventory-refused', 'GET', hiddenPath), 404)).toEqual(
        await answer(
          person.main('GET', `/v1/reading-positions/${randomUUID()}?${query(person)}`),
          404,
        ),
      );
    await credit(person, published);
    const empty = await read({ q: 'An episode label that does not exist', limit: '2' }, 'inventory-search-empty');
    expect(empty.items).toEqual([]);
    if (name === 'owner') {
      nextPart('owner-page', ['GET Work header, page, statements, credits, parts, compositions, wholes, relations, releases, realizations, ratings, reader state, progress and edition preference']);
      await inventoryPageReads(sample, person);
    }
  } finally { elapsed(); }
}

type ContentsLevel = {
  composition: string; compositionRevision: string; version: string;
  items: { occurrence: string; parent: string; role: string; target: string; availability: string;
    number: null; division: null; selectedRevision: null; progress: null; displayLabel: string; inclusion: string }[];
  nextCursor: string | null; count: { value: number; kind: string; total: null };
};

// The contents route follows each cursor without adding a limit. The read's own page size stays in force.
async function contentsPageReads(name: PersonaName, sample: ReturnType<OutcomeRecorder['session']>, person: PersonaSession,
  production: ReturnType<typeof productionClient>) {
  const id = short(published.work);
  const viewer = new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});
  const suffix = viewer.size ? `?${viewer}` : '';
  // The owner's header remains in inventoryPageReads with its existing label and request.
  if (name !== 'owner') await answer(sample('work-header', 'GET', `/v1/works/${id}${suffix}`));
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let revision: string | null = null;
  do {
    expect(++pages).toBeLessThanOrEqual(50);
    const label = pages === 1 ? 'contents-read' : `contents-read-continuation-${pages}`;
    const loaded: ProductionAnswer<ContentsLevel> = await production.read(label, () =>
      production.host.main.v1.works({ id }).contents.get({
        query: { actingSubject: person.actingSubject ?? undefined, ...(cursor ? { cursor } : {}) },
      }));
    if (loaded.error || !loaded.data) {
      throw new Error(`${name} ${label} ${loaded.error?.status}: ${JSON.stringify(loaded.error?.value).slice(0, 400)}`);
    }
    const page = loaded.data;
    expect(page.version).toBe(published.mainVersion);
    revision ??= page.compositionRevision;
    expect(page.compositionRevision).toBe(revision);
    expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
    expect(page.items).toHaveLength(20);
    for (const [index, item] of page.items.entries()) {
      const at = seen.length + index;
      expect(item).toMatchObject({ occurrence: occurrences[at], parent: page.composition,
        role: 'part', target: episodes[at % episodes.length]!.work, availability: 'available',
        number: null, division: null, selectedRevision: null, progress: null, inclusion: 'required' });
      expect(item.displayLabel).toBe(at === 999 ? 'Episode 1000 重逢' : at === 998 ? 'Episode 999 再会' : `Episode ${at + 1}`);
    }
    seen.push(...page.items.map(item => item.occurrence));
    cursor = page.nextCursor;
    expect(cursor === null).toBe(seen.length === 1000);
  } while (cursor);
  expect(seen).toEqual(occurrences);
  expect(new Set(seen).size).toBe(1000);
}

// ConnectionsPage, WorkFrameView and the series/episode panels read these alongside the positions inventory.
async function inventoryPageReads(sample: ReturnType<OutcomeRecorder['session']>, person: PersonaSession) {
  const id = short(published.work);
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(person.actingSubject!)}`;
  const parts = await answer<{ structure: string }>(sample('parts-inventory', 'GET', viewer(`/v1/resources/${id}/parts?limit=50`)));
  const structure = short(parts.structure);
  const composition = await answer<{ next: string | null }>(sample('episode-structure', 'GET', viewer(`/v1/compositions/${structure}?limit=20`)));
  if (composition.next) await answer(sample('episode-structure-continuation', 'GET',
    viewer(`/v1/compositions/${structure}?${new URLSearchParams({ limit: '20', after: composition.next })}`)));
  const reads: [string, string][] = [
    ['work-header', `/v1/works/${id}`],
    ['page-projection', `/v1/resources/${id}/page`],
    ['wiki-shortcut-statements', `/v1/resources/${id}/statements`],
    ['agent-credits', `/v1/works/${id}/agent-credits`],
    ['parts-preview', `/v1/resources/${id}/parts?limit=7`],
    ['availability-parts', `/v1/resources/${id}/parts?limit=1`],
    ['episode-structure-discovery', `/v1/resources/${id}/parts?limit=20`],
    ['wholes-empty', `/v1/resources/${id}/wholes?limit=20`],
    ['wholes-preview', `/v1/resources/${id}/wholes?limit=3`],
    ['relations-empty', `/v1/resources/${id}/relations?limit=20`],
    ['releases-empty', `/v1/works/${id}/releases?limit=20`],
    ['realizations-empty', `/v1/works/${id}/realizations?limit=20`],
    ['rating-contexts', `/v1/resources/${id}/rating-contexts?scope=global`],
    ['ratings', `/v1/resources/${id}/ratings?scope=global`],
    ['reader-stats', `/v1/works/${id}/reader-stats`],
    ['reader-state', `/v1/works/${id}/reader-state`],
    ['progress-summary', `/v1/me/progress-summaries/${id}?language=en`],
    ['edition-preference-empty', `/v1/me/edition-preferences/${id}`],
    ['episode-resume', `/v1/reading-positions/${id}?position=mine&limit=1`],
    ['chapter-standing', `/v1/reading-positions/${id}?position=mine&limit=50`],
    ['episode-progress-empty', `/v1/compositions/${structure}/occurrences/${short(occurrences[0]!)}/progress`],
    ['composition-progress-empty', `/v1/compositions/${structure}/progress?limit=50`],
    ['work-progress', `/v1/works/${id}/progress`],
    ['correspondence-definition', '/v1/lexicon/definitions/correspondence-equivalent'],
  ];
  for (const [label, path] of reads) {
    const response = await sample(label, 'GET', viewer(path));
    await response.body?.cancel();
  }
  await answer(sample('part-names', 'POST', '/v1/resources/summaries', {
    profile: 'resource-summary-batch-v1', resources: episodes.map(episode => episode.work), actingSubject: person.actingSubject,
  }));
  await answer(sample('work-credits-template', 'POST', '/v1/query', { profile: 'template-query-v1',
    query: 'https://rezics.com/query/work-credits', revision: 1, parameters: { roots: [published.work] },
    presentation: { actingSubject: person.actingSubject } }));
  await answer(recording.session('owner', sessions.visitor)('work-showcase', 'POST', '/v1/resources/showcase', {
    profile: 'work-showcase-batch-v1', targets: [published.work],
  }));
}

outcomeTest(inventory, 'visitor', () => navigate('visitor'), recording);
outcomeTest(inventory, 'stranger', () => navigate('stranger'), recording);
outcomeTest(inventory, 'member', () => navigate('member'), recording);
outcomeTest(inventory, 'owner', () => navigate('owner'), recording);
outcomeTest(inventory, 'moderator', () => navigate('moderator'), recording);
outcomeTest(inventory, 'operator', () => navigate('operator'), recording);
