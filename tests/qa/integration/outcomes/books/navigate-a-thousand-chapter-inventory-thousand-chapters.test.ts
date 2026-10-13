import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import inventory from '../../../../../scripts/qa/cases/outcomes/books/navigate-a-thousand-chapter-inventory-thousand-chapters.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Page = {
  items: { occurrence: string; labels: { value: string; language: string }[] }[];
  nextCursor: string | null;
  complete: boolean;
  count: { value: number; kind: string; total: null };
  search?: { status: string };
};
setDefaultTimeout(120_000);
let sessions: PersonaSessions;
let published: Work;
let privateWork: Work;
let contribution: string;
const recording = new OutcomeRecorder(inventory);
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
  await recording.prepare();
  const owner = sessions.owner;
  const create = (title: string) =>
    answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title,
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        authoring: 'own-work',
        actingSubject: owner.actingSubject,
      }),
      201,
    );
  published = await create(`The thousand seed paths ${randomUUID()}`);
  privateWork = await create('Unpublished seed paths');
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: published.work,
      language: 'en',
      body: 'An original story about a gardener mapping a thousand paths through a seed garden.',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  contribution = draft.contribution;
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution,
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
      context: { kind: 'main-version-default', id: published.mainVersion },
      work: published.work,
      contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  let composition = await answer<Composition>(
    owner.main('POST', '/v1/compositions', {
      profile: 'book-composition',
      work: published.work,
      mainVersion: published.mainVersion,
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  for (let offset = 0; offset < 1000; offset += 16) {
    composition = await answer<Composition>(
      owner.main('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: composition.revision,
        actingSubject: owner.actingSubject,
        operations: Array.from({ length: Math.min(16, 1000 - offset) }, (_, index) => {
          const number = offset + index + 1;
          return {
            op: 'insert',
            role: 'chapter',
            parent: composition.structure,
            position: 'last',
            target: 'https://schema.org/DigitalDocument',
            label:
              number === 1000
                ? { value: '重逢', language: 'zh-Hans' }
                : number === 999
                  ? { value: '再会', language: 'ja' }
                  : { value: `Chapter ${number}`, language: 'en' },
          };
        }),
      }),
    );
    occurrences.push(...composition.occurrences);
  }
  expect(performance.now() - started).toBeLessThan(600_000);
}, 600_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await sessions?.close(); }
});

async function credit(person: PersonaSession, sample: ReturnType<typeof recording.session>, phase: string) {
  const fields = query(person);
  fields.delete('position');
  const credits = await answer<{ items: { role: string; agent: string }[] }>(
    sample(`credits-${phase}`, 'GET', `/v1/works/${short(published.work)}/credits?${fields}`),
  );
  expect(credits.items).toContainEqual(
    expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }),
  );
  const variants = await answer<{
    variants: { contribution: string; author: string; language: string }[];
  }>(sample(`native-variants-${phase}`, 'GET', `/v1/main-versions/${short(published.mainVersion)}/native-variants`));
  expect(variants.variants).toContainEqual(
    expect.objectContaining({ contribution, author: sessions.owner.actingSubject, language: 'en' }),
  );
}

async function navigate(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const path = `/v1/reading-positions/${short(published.work)}`;
  const read = (label: string, fields: Record<string, string> = {}) =>
    answer<Page>(sample(label, 'GET', `${path}?${query(person, fields)}`));
  await credit(person, sample, 'before');
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let restarts = 0;
  do {
    expect(++pages).toBeLessThan(1100);
    const response = await sample(
      `inventory-page-${pages}`, 'GET',
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
  for (const [q, ordinal, label] of [
    ['重逢', 1000, '重逢'],
    ['１０００', 1000, '重逢'],
    ['再会', 999, '再会'],
    ['999', 999, '再会'],
  ] as const) {
    const page = await read(`search-${q}`, { q, limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      occurrence: occurrences[ordinal - 1],
      labels: expect.arrayContaining([expect.objectContaining({ value: label })]),
    });
    expect(page.search).toEqual({ status: 'current' });
    expect(page.complete).toBe(true);
    expect(page.nextCursor).toBeNull();
  }
  const first = await read('search-first-page', { q: 'chapter 9', limit: '2' });
  expect(first.items.map((item) => item.occurrence)).toEqual([occurrences[8]!, occurrences[89]!]);
  expect(first.nextCursor).not.toBeNull();
  const second = await read('search-continuation', { q: 'chapter 9', limit: '2', cursor: first.nextCursor! });
  expect(second.items.map((item) => item.occurrence)).toEqual([occurrences[90]!, occurrences[91]!]);
  await answer(
    sample(
      'cursor-query-refusal', 'GET',
      `${path}?${query(person, { q: 'chapter 8', limit: '2', cursor: first.nextCursor! })}`,
    ),
    400,
  );
  const other = sessions[name === 'stranger' ? 'member' : 'stranger'];
  await answer(
    recording.session(name, other)(
      'cursor-reader-refusal', 'GET',
      `${path}?${query(other, { q: 'chapter 9', limit: '2', cursor: first.nextCursor! })}`,
    ),
    400,
  );
  const hiddenPath = `/v1/reading-positions/${short(privateWork.work)}?${query(person)}`;
  if (name === 'owner') await answer(sample('private-inventory', 'GET', hiddenPath));
  else
    expect(await answer(sample('private-inventory', 'GET', hiddenPath), 404)).toEqual(
      await answer(
        sample('missing-inventory', 'GET', `/v1/reading-positions/${randomUUID()}?${query(person)}`),
        404,
      ),
    );
  await credit(person, sample, 'after');
  if (name === 'member') await supportingReads(person, sample);
}

async function supportingReads(person: PersonaSession, sample: ReturnType<typeof recording.session>) {
  const id = short(published.work);
  const actor = new URLSearchParams({ actingSubject: person.actingSubject! });
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${actor}`;
  const chooser = await answer<Page>(sample('chapter-chooser', 'GET',
    `/v1/reading-positions/${id}?${query(person, { limit: '50' })}`));
  if (chooser.nextCursor)
    await answer(sample('chapter-chooser-continuation', 'GET',
      `/v1/reading-positions/${id}?${query(person, { limit: '50', cursor: chooser.nextCursor })}`));
  const empty = await answer<Page>(sample('chapter-search-no-match', 'GET',
    `/v1/reading-positions/${id}?${query(person, { q: 'unmatched seed path', limit: '50' })}`));
  expect(empty.items).toEqual([]);
  const contentsResponse = await sample('contents', 'GET', viewer(`/v1/works/${id}/contents`));
  // The page renders the owner's refusal as well as its successful Contents answer.
  type Contents = { items: { occurrence: string; role: string }[]; nextCursor: string | null };
  let contents: Contents | null = null;
  if (contentsResponse.status === 503) await answer(Promise.resolve(contentsResponse), 503);
  else contents = await answer<Contents>(Promise.resolve(contentsResponse));
  if (contents?.nextCursor)
    await answer(sample('contents-continuation', 'GET', viewer(`/v1/works/${id}/contents?${new URLSearchParams({ cursor: contents.nextCursor })}`)));
  const group = contents?.items.find(item => item.role === 'group');
  if (group)
    await answer(sample('contents-group', 'GET', viewer(`/v1/works/${id}/contents?${new URLSearchParams({ parent: group.occurrence })}`)));
  // The Contents route and its surrounding Work frame each consume these owner answers.
  await answer(sample('work-header', 'GET', viewer(`/v1/works/${id}`)));
  const projection = await answer<{ sections: { id: string; href: string }[] }>(
    sample('work-projection', 'GET', viewer(`/v1/resources/${id}/page`)));
  const statements = projection.sections.find(section => section.id === 'statements');
  if (statements) await answer(sample('wiki-shortcut-statements', 'GET', viewer(statements.href)));
  await answer(sample('agent-credits', 'GET', viewer(`/v1/works/${id}/agent-credits`)));
  await answer(sample('frame-credits', 'POST', '/v1/query', {
    profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
    parameters: { roots: [published.work] }, presentation: { actingSubject: person.actingSubject },
  }));
  if (!contents || !contents.items.length)
    await answer(sample('one-text-versions', 'POST', '/v1/query', {
      profile: 'template-query-v1', query: 'https://rezics.com/query/work-versions', revision: 1,
      parameters: { roots: [published.work], kind: 'text-variant' },
      presentation: { actingSubject: person.actingSubject },
    }));
  const contexts = await answer<{ items: { context: string }[] }>(
    sample('rating-contexts', 'GET', viewer(`/v1/resources/${id}/rating-contexts?scope=global`)));
  const context = contexts.items[0]?.context;
  await answer(sample('rating-summary', 'GET', viewer(`/v1/resources/${id}/ratings?${new URLSearchParams({ scope: 'global', ...(context ? { context } : {}) })}`)));
  await answer(sample('reader-stats', 'GET', viewer(`/v1/works/${id}/reader-stats?${new URLSearchParams(context ? { context } : {})}`)));
  await answer(sample('reader-state', 'GET', viewer(`/v1/works/${id}/reader-state`)));
  await answer(sample('continue-reading', 'GET', viewer('/v1/me/continue?limit=6')));
  await answer(sample('edition-preference', 'GET', viewer(`/v1/me/edition-preferences/${id}`)));
  await answer(sample('progress-summary', 'GET', viewer(`/v1/me/progress-summaries/${id}?language=en`)));
  await answer(sample('releases', 'GET', viewer(`/v1/works/${id}/releases?limit=20`)));
  await answer(sample('follow-state', 'GET', viewer(`/v1/me/follow-state?${new URLSearchParams({ target: published.work, kind: 'work' })}`)));
  const publicSample = recording.session('member', sessions.visitor);
  await answer(publicSample('work-showcase', 'POST', '/v1/resources/showcase', {
    profile: 'work-showcase-batch-v1', targets: [published.work],
  }));
  await answer(publicSample('public-preview', 'GET', `/v1/public-previews/${id}`));
  await answer(publicSample('public-work-header', 'GET', `/v1/works/${id}`));
}

outcomeTest(inventory, 'visitor', () => navigate('visitor'), recording);
outcomeTest(inventory, 'stranger', () => navigate('stranger'), recording);
outcomeTest(inventory, 'member', () => navigate('member'), recording);
outcomeTest(inventory, 'owner', () => navigate('owner'), recording);
outcomeTest(inventory, 'moderator', () => navigate('moderator'), recording);
outcomeTest(inventory, 'operator', () => navigate('operator'), recording);
