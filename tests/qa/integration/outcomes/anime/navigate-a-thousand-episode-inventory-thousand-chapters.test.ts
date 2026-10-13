import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  authorize,
  exchangeCode,
  LocalOAuthSession,
  type LocalOAuthClient,
} from '../../../../../scripts/lib/oauth-client.ts';
import inventory from '../../../../../scripts/qa/cases/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
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
setDefaultTimeout(120_000);
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

beforeAll(async () => {
  const started = performance.now();
  sessions = await personaSessions();
  await recording.prepare();
  sessions.owner = await readingSession(sessions.owner);
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
  try { await recording.publish(); }
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

async function navigate(name: PersonaName) {
  const person = await readingSession(sessions[name]);
  const sample = recording.session(name, person);
  const path = `/v1/reading-positions/${short(published.work)}`;
  const read = (fields: Record<string, string> = {}, label?: string) =>
    answer<Page>(label ? sample(label, 'GET', `${path}?${query(person, fields)}`)
      : person.main('GET', `${path}?${query(person, fields)}`));
  await credit(person, published, sample);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let restarts = 0;
  do {
    expect(++pages).toBeLessThan(1100);
    const response = await person.main(
      'GET',
      `${path}?${query(person, { limit: '100', ...(cursor ? { cursor } : {}) })}`,
    );
    if (response.status === 409) {
      expect(await response.json()).toMatchObject({ code: 'read_basis_changed' });
      expect(++restarts).toBeLessThan(20);
      seen.length = 0;
      cursor = null;
      continue;
    }
    const page = await answer<Page>(Promise.resolve(response));
    expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
    expect(page.complete).toBe(page.nextCursor === null);
    seen.push(...page.items.map((item) => item.occurrence));
    cursor = page.nextCursor;
  } while (cursor || seen.length === 0);
  expect(seen).toEqual(occurrences);
  expect(new Set(seen).size).toBe(1000);
  // Work composition uses label search. A bare numeric seek is a separately
  // refused contract and is unnecessary to find the numbered distant episode.
  for (const [q, number] of [['Episode 1000 重逢', 1000]] as const) {
    const matches: Page['items'] = [];
    let searchCursor: string | null = null;
    let searchPages = 0;
    do {
      expect(++searchPages).toBeLessThan(1100);
      const page = await read({
        q,
        limit: '100',
        ...(searchCursor ? { cursor: searchCursor } : {}),
      }, searchPages === 1 ? 'distant-episode-search' : undefined);
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
  const other = sessions[name === 'stranger' ? 'member' : 'stranger'];
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
  if (name === 'owner') await inventoryPageReads(sample, person);
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
  await answer(sample('work-credits', 'POST', '/v1/query', { profile: 'template-query-v1',
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
