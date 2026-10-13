import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import inventory from '../../../../../scripts/qa/cases/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
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
  await sessions?.close();
});

async function credit(person: PersonaSession, work: Work) {
  const fields = query(person);
  fields.delete('position');
  const credits = await answer<{ items: { role: string; agent: string }[] }>(
    person.main('GET', `/v1/works/${short(work.work)}/credits?${fields}`),
  );
  expect(credits.items).toContainEqual(
    expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }),
  );
  const variants = await answer<{ variants: { author: string; language: string }[] }>(
    person.main('GET', `/v1/main-versions/${short(work.mainVersion)}/native-variants`),
  );
  expect(variants.variants).toContainEqual(
    expect.objectContaining({ author: sessions.owner.actingSubject, language: 'en' }),
  );
}

async function navigate(name: PersonaName) {
  const person = sessions[name];
  const path = `/v1/reading-positions/${short(published.work)}`;
  const read = async (fields: Record<string, string> = {}) => {
    const url = `${path}?${query(person, fields)}`;
    let response = await person.main('GET', url);
    // A token can expire inside a long read. The next call lets the same
    // session's OAuth owner renew credentials; no other refusal is retried.
    if (
      response.status === 401 &&
      ((await response.clone().json()) as { code?: string }).code === 'account_assertion_denied'
    ) {
      await response.body?.cancel();
      response = await person.main('GET', url);
    }
    return answer<Page>(Promise.resolve(response));
  };
  await credit(person, published);
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
  for (const [q, number] of [
    ['重逢', 1000],
    ['Episode 1000', 1000],
  ] as const) {
    const matches: Page['items'] = [];
    let searchCursor: string | null = null;
    let searchPages = 0;
    do {
      expect(++searchPages).toBeLessThan(1100);
      const page = await read({
        q,
        limit: '100',
        ...(searchCursor ? { cursor: searchCursor } : {}),
      });
      expect(page.search).toEqual({ status: 'current' });
      expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
      expect(page.complete).toBe(page.nextCursor === null);
      matches.push(...page.items);
      searchCursor = page.nextCursor;
    } while (searchCursor);
    expect(matches, `Completed GET ${path}?q=${q}: ${JSON.stringify(matches)}`).toHaveLength(1);
    expect(matches[0]?.occurrence).toBe(occurrences[number - 1]);
    await credit(person, episodes[(number - 1) % episodes.length]!);
  }
  const first = await read({ limit: '2' });
  expect(first.nextCursor).not.toBeNull();
  const second = await read({ limit: '2', cursor: first.nextCursor! });
  expect(second.items.map((item) => item.occurrence)).toEqual(occurrences.slice(2, 4));
  await answer(
    person.main(
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
  if (name === 'owner') await answer(person.main('GET', hiddenPath));
  else
    expect(await answer(person.main('GET', hiddenPath), 404)).toEqual(
      await answer(
        person.main('GET', `/v1/reading-positions/${randomUUID()}?${query(person)}`),
        404,
      ),
    );
  await credit(person, published);
}

outcomeTest(inventory, 'visitor', () => navigate('visitor'));
outcomeTest(inventory, 'stranger', () => navigate('stranger'));
outcomeTest(inventory, 'member', () => navigate('member'));
outcomeTest(inventory, 'owner', () => navigate('owner'));
outcomeTest(inventory, 'moderator', () => navigate('moderator'));
outcomeTest(inventory, 'operator', () => navigate('operator'));
