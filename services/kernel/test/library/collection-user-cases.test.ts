import { describe, expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionView, DynamicCollectionView } from '../../../../specs/dynamic-collections-driver.ts';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { discoveryKey, type DiscoveryPersona } from '../support/released-discovery.ts';
import {
  createReleasedLibraryPopulation,
  type CopyHandle,
  type EntryHandle,
  type LabelHandle,
  type ReleasedLibraryPopulation,
  type SessionHandle,
} from './support/released-library-population.ts';

// This suite freezes only the missing released-data common Collection cells. The existing dynamic, profile,
// label and source suites still require their complete native bindings. In particular, these cases do not prove
// the numeric/composed growth bounds, identity epochs or query-level privacy-reduction repair/ACK protocol.
// The one actual population owns one base. No caller-supplied driver, release, matcher or authority is installed.
function native(title: string, run: (f: ReleasedLibraryPopulation) => Promise<void>) {
  test(
    title,
    async () => {
      const f = await createReleasedLibraryPopulation({ version: 1 });
      try {
        await run(f);
      } finally {
        await f.close();
      }
    },
    120_000,
  );
}

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify({ status: response.status, body: response.body })).toBe(expected);
  return response;
}

function problem(response: HttpResponse, expected: number, code: string) {
  status(response, expected);
  expect(response.body).toMatchObject({ status: expected, code, effect_status: 'not_applicable' });
  expect(response.headers.get('content-type')).toContain('application/problem+json');
}

function privateResponse(response: HttpResponse) {
  expect(response.headers.get('cache-control')).toContain('private');
  expect(response.headers.get('cache-control')).toContain('no-store');
}

function required<T>(value: T | undefined, name: string, f: ReleasedLibraryPopulation): T {
  if (value === undefined) throw new Error(`Bundled release ${f.base.release.digest} lacks ${name}`);
  return value;
}

function stateChoice(f: ReleasedLibraryPopulation, type: string, role: 'active' | 'completed') {
  const accepted = f.profile(type);
  const set = required(accepted.profile.entryStateSet, `${type} entryStateSet`, f);
  const choice = required(
    set.states.find((state) => state.role === role),
    `${type} ${role} state`,
    f,
  );
  return { profileId: accepted.profile.id, stateSetId: set.id, stateId: choice.id };
}

async function createLabel(f: ReleasedLibraryPopulation, name: string) {
  const response = status(await f.request('alice', 'POST', '/v1/libraryLabels', { name }, discoveryKey()), 201);
  const label = response.body.label as LabelHandle;
  expect(label.id).toEqual(expect.any(String));
  expect(label.revision).toEqual(expect.any(Number));
  return label;
}

async function assign(f: ReleasedLibraryPopulation, label: LabelHandle, subjectId: string) {
  const response = status(
    await f.request('alice', 'POST', `/v1/libraryLabels/${label.id}:assign`, { subjectId }, discoveryKey()),
    200,
  );
  expect(response.body.assignment).toMatchObject({ labelId: label.id, subjectId });
}

async function holding(f: ReleasedLibraryPopulation, subjectId: string, type: string) {
  const profile = f.profile(type).profile;
  const kind = required(profile.copies?.kinds[0], `${type} copy kind`, f);
  const choice = required(kind.statuses[0], `${type} copy status`, f);
  const response = status(
    await f.request('alice', 'POST', '/v1/copies', { subjectId, kind: kind.id, status: choice.id }, discoveryKey()),
    201,
  );
  const copy = response.body.copy as CopyHandle;
  expect(copy).toMatchObject({ subjectId, status: choice.id });
  expect(status(await f.request('alice', 'GET', `/v1/copies/${copy.id}`), 200).body.copy).toEqual(copy);
}

async function activeSession(f: ReleasedLibraryPopulation, subjectId: string, type: string) {
  const profile = f.profile(type).profile;
  const mode = required(
    profile.progress?.allowed.find((choice) => choice.mode === 'scalar_amount'),
    `${type} scalar progress`,
    f,
  );
  const unit = required(
    type === 'schema:Recipe' ? mode.units.find((choice) => choice.id === 'minute') : mode.units[0],
    `${type} progress unit`,
    f,
  );
  const created = status(
    await f.request(
      'alice',
      'POST',
      '/v1/progressSessions',
      {
        subjectId,
        mode: mode.mode,
        unit: unit.id,
        ...(unit.totalPolicy === 'required' ? { total: unit.maximum ?? unit.minimum ?? '0' } : {}),
      },
      discoveryKey(),
    ),
    201,
  );
  const session = created.body.progressSession as SessionHandle;
  const recorded = status(
    await f.request(
      'alice',
      'POST',
      `/v1/progressSessions/${session.id}:record`,
      { revision: session.revision, amount: unit.minimum ?? '0' },
      discoveryKey(),
    ),
    200,
  );
  expect(recorded.body.progressSession).toMatchObject({ id: session.id, subjectId, state: 'active' });
  return recorded.body.progressSession as SessionHandle;
}

async function noEntry(f: ReleasedLibraryPopulation, subjectId: string) {
  problem(await f.request('alice', 'GET', `/v1/libraryEntries/${subjectId}`), 404, 'not_found');
}

async function setState(
  f: ReleasedLibraryPopulation,
  subjectId: string,
  state: string,
  persona: 'alice' | 'bob' = 'alice',
) {
  const response = status(
    await f.request(persona, 'PUT', `/v1/libraryEntries/${subjectId}`, { state }, discoveryKey()),
    201,
  );
  const entry = response.body.libraryEntry as EntryHandle;
  expect(entry).toMatchObject({ subjectId, state });
  expect(status(await f.request(persona, 'GET', `/v1/libraryEntries/${subjectId}`), 200).body).toEqual(response.body);
  return entry;
}

async function builtins(f: ReleasedLibraryPopulation) {
  const response = status(
    await f.request('alice', 'GET', `/v1/collections?curatorAccountId=${f.base.personas.alice.accountId}&limit=100`),
    200,
  );
  expect(Array.isArray(response.body.collections), JSON.stringify(response.body)).toBe(true);
  expect(response.body.next).toBeNull();
  return response.body.collections as CollectionView[];
}

async function everything(f: ReleasedLibraryPopulation) {
  const rows = (await builtins(f)).filter(
    (row): row is DynamicCollectionView => row.membershipKind === 'dynamic' && row.builtinKind === 'everything',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.visibility).toBe('private');
  return rows[0]!;
}

async function stateView(f: ReleasedLibraryPopulation, tuple: ReturnType<typeof stateChoice>) {
  const rows = (await builtins(f)).filter(
    (row): row is DynamicCollectionView =>
      row.membershipKind === 'dynamic' &&
      row.builtin?.kind === 'state' &&
      row.builtin.profileId === tuple.profileId &&
      row.builtin.stateSetId === tuple.stateSetId &&
      row.builtin.stateId === tuple.stateId,
  );
  expect(rows, JSON.stringify(tuple)).toHaveLength(1);
  expect(rows[0]!.visibility).toBe('private');
  return rows[0]!;
}

async function catalogue(f: ReleasedLibraryPopulation) {
  // This actual helper can fail at missing released words/diet/profile data. Such a setup failure stays red;
  // a prerequisite descriptor or a rejected editorial write is never a successful source population.
  const sourceGroup = await f.sources();
  const books = await f.base.books();
  const recipes = await f.base.recipes();
  const filters = f.base.filters(await f.base.classification(), await f.base.diet());
  const curated = required(
    sourceGroup.sources.find((item) => item.source.visibility === 'public'),
    'actual public curated source',
    f,
  );
  expect(f.base.meaning.minuteFilter).toBe('http://www.wikidata.org/entity/Q7727');
  return { sourceGroup, curated, books, recipes, filters };
}

// Add only native supports to the shared subjects. In particular B-long stays the helper's label-only subject;
// B-edge is holding-only and B-characters has an active session. No entry or default state is manufactured.
async function withoutState(f: ReleasedLibraryPopulation) {
  const data = await catalogue(f);
  const controls = await createLabel(f, 'Common Collection catalogue controls without state');
  for (const name of ['B-short', 'B-unknown', 'B-tag-only', 'B-form-only'] as const)
    await assign(f, controls, data.books.subjects[name].id);
  await assign(f, controls, data.books.edition.id);
  await holding(f, data.books.subjects['B-edge'].id, 'schema:Book');
  await activeSession(f, data.books.subjects['B-characters'].id, 'schema:Book');

  const history = await f.recipes();
  expect(history.alice.session.state).toBe('completed');
  expect(history.bob.session.state).toBe('completed');
  const quickLabel = await createLabel(f, 'Quick recipe own label-only support');
  await assign(f, quickLabel, data.recipes.subjects['R-quick'].id);
  await holding(f, data.recipes.subjects['R-edge'].id, 'schema:Recipe');
  await activeSession(f, data.recipes.subjects['R-other-cooked'].id, 'schema:Recipe');
  for (const name of ['R-slow', 'R-meat', 'R-unknown'] as const)
    await assign(f, controls, data.recipes.subjects[name].id);
  for (const subject of [...Object.values(data.books.subjects), ...Object.values(data.recipes.subjects)])
    await noEntry(f, subject.id);
  return { ...data, history, quickLabel, collection: await everything(f) };
}

// State cases own a fresh native population, separate from the no-entry cases. All catalogue positives have
// Alice's selected accepted state. Bob's later different state on the same subject cannot replace Alice's.
async function selectedState(f: ReleasedLibraryPopulation) {
  const data = await catalogue(f);
  const bookState = stateChoice(f, 'schema:Book', 'active');
  const recipeState = stateChoice(f, 'schema:Recipe', 'active');
  for (const subject of Object.values(data.books.subjects)) await setState(f, subject.id, bookState.stateId);
  for (const subject of Object.values(data.recipes.subjects)) await setState(f, subject.id, recipeState.stateId);
  const support = await createLabel(f, 'Selected-state quick recipe independent support');
  await assign(f, support, data.recipes.subjects['R-quick'].id);
  await setState(f, data.books.subjects['B-long'].id, stateChoice(f, 'schema:Book', 'completed').stateId, 'bob');
  await setState(f, data.recipes.subjects['R-quick'].id, stateChoice(f, 'schema:Recipe', 'completed').stateId, 'bob');
  return {
    ...data,
    bookState,
    recipeState,
    bookCollection: await stateView(f, bookState),
    recipeCollection: await stateView(f, recipeState),
  };
}

function membersPath(collectionId: string, filter: unknown, cursor?: string) {
  const query = new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', limit: '2' });
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/v1/collections/${collectionId}/members?${query}`;
}

function memberIds(response: HttpResponse) {
  expect(Array.isArray(response.body.members), JSON.stringify(response.body)).toBe(true);
  const rows = response.body.members as { subjectId: string }[];
  for (const row of rows) expect(row.subjectId).toEqual(expect.any(String));
  return rows.map((row) => row.subjectId);
}

// The expected population bounds the number of requests, rather than a raw cursor deciding how long to scan.
// Every original response must fill two slots or be genuinely final. There is no default native preparation
// producer exported by this fixture: readiness/202/503 therefore remains red here until real finite progress is
// wired, rather than being converted into 200, drained by link catchUp, or retried in a client-side evaluator.
async function exactPages(
  f: ReleasedLibraryPopulation,
  collectionId: string,
  filter: unknown,
  expectedIds: readonly string[],
  persona: DiscoveryPersona,
  privatePlan = false,
) {
  const expected = [...expectedIds].sort();
  const responses: HttpResponse[] = [];
  const observed: string[] = [];
  let cursor: string | undefined;
  const pageCount = Math.max(1, Math.ceil(expected.length / 2));
  for (let page = 0; page < pageCount; page++) {
    const response = status(await f.request(persona, 'GET', membersPath(collectionId, filter, cursor)), 200);
    responses.push(response);
    if (privatePlan) privateResponse(response);
    const ids = memberIds(response);
    expect(ids).toEqual(expected.slice(page * 2, page * 2 + 2));
    observed.push(...ids);
    if (page + 1 === pageCount) expect(response.body.next).toBeNull();
    else {
      expect(ids).toHaveLength(2);
      expect(response.body.next).toEqual(expect.any(String));
      expect(response.body.next).not.toBe('');
      expect(response.body.next).not.toBe(cursor);
      cursor = response.body.next as string;
    }
  }
  expect(observed).toEqual(expected);
  expect(new Set(observed).size).toBe(expected.length);
  return responses;
}

async function selectedPages(
  f: ReleasedLibraryPopulation,
  collectionId: string,
  filter: unknown,
  expectedIds: readonly string[],
  clearedId: string,
) {
  await exactPages(f, collectionId, filter, expectedIds, 'alice', true);
  const entry = status(await f.request('alice', 'GET', `/v1/libraryEntries/${clearedId}`), 200).body
    .libraryEntry as EntryHandle;
  status(
    await f.request(
      'alice',
      'DELETE',
      `/v1/libraryEntries/${clearedId}?revision=${entry.revision}`,
      undefined,
      discoveryKey(),
    ),
    204,
  );
  await noEntry(f, clearedId);
  // B-long and quick retain independent label support, so Everything would still include them. This next read
  // must remove just Alice's selected-state membership, regardless of Bob's independently retained state.
  await exactPages(
    f,
    collectionId,
    filter,
    expectedIds.filter((id) => id !== clearedId),
    'alice',
    true,
  );
}

function completedCooking(f: ReleasedLibraryPopulation, dietTime: unknown) {
  // Literal adopted HTTP data pending Semantic's actual shared OwnerLeaf/FilterDocument schema. Do not declare
  // another Filter union or cast this request to a catalogue-only shared type that does not yet admit owner.
  return {
    and: [
      dietTime,
      { owner: { presence: true } },
      { not: { owner: { session: { profileId: f.profile('schema:Recipe').profile.id, lifecycle: 'completed' } } } },
    ],
  };
}

function recipeIds(data: Awaited<ReturnType<typeof catalogue>>) {
  return (['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked'] as const).map((name) => data.recipes.subjects[name].id);
}

function notCompletedIds(data: Awaited<ReturnType<typeof catalogue>>) {
  return [
    data.recipes.subjects['R-quick'].id,
    data.recipes.subjects['R-edge'].id,
    data.recipes.subjects['R-other-cooked'].id,
  ];
}

async function clearCooked(f: ReleasedLibraryPopulation, data: Awaited<ReturnType<typeof withoutState>>) {
  const id = data.recipes.subjects['R-cooked'].id;
  const entry = await setState(f, id, stateChoice(f, 'schema:Recipe', 'completed').stateId);
  const removed = status(
    await f.request(
      'alice',
      'DELETE',
      `/v1/libraryEntries/${id}?revision=${entry.revision}`,
      undefined,
      discoveryKey(),
    ),
    204,
  );
  expect(removed.headers.get('Library-Entry-Deletion-Id')).toEqual(expect.any(String));
  expect(removed.headers.get('Library-Entry-Deletion-Revision')).toBe(String(entry.revision + 1));
  await noEntry(f, id);
  expect(
    status(await f.request('alice', 'GET', `/v1/progressSessions/${data.history.alice.session.id}`), 200).body
      .progressSession,
  ).toEqual(data.history.alice.session);
}

async function concealedLikeUnknown(
  f: ReleasedLibraryPopulation,
  persona: 'bob' | 'anonymous',
  collectionId: string,
  unknownId: string,
  suffix = '',
) {
  const hidden = await f.request(persona, 'GET', `/v1/collections/${collectionId}${suffix}`);
  const unknown = await f.request(persona, 'GET', `/v1/collections/${unknownId}${suffix}`);
  problem(hidden, 404, 'not_found');
  problem(unknown, 404, 'not_found');
  // Request correlation IDs differ; every other native Problem field must have the same concealment formula.
  const { request_id: hiddenRequest, ...hiddenProblem } = hidden.body;
  const { request_id: unknownRequest, ...unknownProblem } = unknown.body;
  expect(hiddenRequest).toEqual(expect.any(String));
  expect(unknownRequest).toEqual(expect.any(String));
  expect(hiddenProblem).toEqual(unknownProblem);
}

describe('released common Collection filters preserve exact public curated Everything without state own-state and completed cooking history meanings under native useful paging', () => {
  native('Public curated words over one million return exactly B-long', async (f) => {
    const d = await catalogue(f);
    await exactPages(f, d.curated.source.id, d.filters.words, [d.books.subjects['B-long'].id], 'anonymous');
  });

  native(
    'Public curated light novel and harem return exactly B-long B-edge B-characters with a full first page and final remainder',
    async (f) => {
      const d = await catalogue(f);
      await exactPages(
        f,
        d.curated.source.id,
        d.filters.formHarem,
        [d.books.subjects['B-long'].id, d.books.subjects['B-edge'].id, d.books.subjects['B-characters'].id],
        'anonymous',
      );
    },
  );

  native('Public curated combined words light novel and harem return exactly B-long', async (f) => {
    const d = await catalogue(f);
    await exactPages(f, d.curated.source.id, d.filters.combined, [d.books.subjects['B-long'].id], 'anonymous');
  });

  native(
    'Public curated vegetarian cooking time at most thirty minutes returns exactly quick edge cooked other-cooked',
    async (f) => {
      const d = await catalogue(f);
      await exactPages(f, d.curated.source.id, d.filters.dietTime, recipeIds(d), 'anonymous');
    },
  );

  native('Own Everything without state words over one million return exactly label-only B-long', async (f) => {
    const d = await withoutState(f);
    await exactPages(f, d.collection.id, d.filters.words, [d.books.subjects['B-long'].id], 'alice', true);
    await noEntry(f, d.books.subjects['B-long'].id);
  });

  native(
    'Own Everything without state light novel and harem return exactly B-long B-edge B-characters across label holding and session supports',
    async (f) => {
      const d = await withoutState(f);
      await exactPages(
        f,
        d.collection.id,
        d.filters.formHarem,
        [d.books.subjects['B-long'].id, d.books.subjects['B-edge'].id, d.books.subjects['B-characters'].id],
        'alice',
        true,
      );
    },
  );

  native('Own Everything without state combined words light novel and harem return exactly B-long', async (f) => {
    const d = await withoutState(f);
    await exactPages(f, d.collection.id, d.filters.combined, [d.books.subjects['B-long'].id], 'alice', true);
  });

  native(
    'Own Everything without state vegetarian cooking time at most thirty minutes returns exactly quick edge cooked other-cooked',
    async (f) => {
      const d = await withoutState(f);
      await exactPages(f, d.collection.id, d.filters.dietTime, recipeIds(d), 'alice', true);
    },
  );

  native(
    'Own selected-state view words over one million return exactly B-long despite Bob different state',
    async (f) => {
      const d = await selectedState(f);
      await selectedPages(
        f,
        d.bookCollection.id,
        d.filters.words,
        [d.books.subjects['B-long'].id],
        d.books.subjects['B-long'].id,
      );
    },
  );

  native('Own selected-state view light novel and harem return exactly B-long B-edge B-characters', async (f) => {
    const d = await selectedState(f);
    await selectedPages(
      f,
      d.bookCollection.id,
      d.filters.formHarem,
      [d.books.subjects['B-long'].id, d.books.subjects['B-edge'].id, d.books.subjects['B-characters'].id],
      d.books.subjects['B-long'].id,
    );
  });

  native('Own selected-state view combined words light novel and harem return exactly B-long', async (f) => {
    const d = await selectedState(f);
    await selectedPages(
      f,
      d.bookCollection.id,
      d.filters.combined,
      [d.books.subjects['B-long'].id],
      d.books.subjects['B-long'].id,
    );
  });

  native(
    'Own selected-state view vegetarian cooking time at most thirty minutes returns exactly quick edge cooked other-cooked despite Bob different state',
    async (f) => {
      const d = await selectedState(f);
      await selectedPages(f, d.recipeCollection.id, d.filters.dietTime, recipeIds(d), d.recipes.subjects['R-quick'].id);
    },
  );

  native(
    'Own completed cooking history excludes only Alice cooked and returns exactly no-entry quick edge other-cooked under presence and NOT completed session',
    async (f) => {
      const d = await withoutState(f);
      await exactPages(f, d.collection.id, completedCooking(f, d.filters.dietTime), notCompletedIds(d), 'alice', true);
      for (const name of ['R-quick', 'R-edge', 'R-other-cooked'] as const)
        await noEntry(f, d.recipes.subjects[name].id);
      expect(
        status(await f.request('bob', 'GET', `/v1/progressSessions/${d.history.bob.session.id}`), 200).body
          .progressSession,
      ).toEqual(d.history.bob.session);
    },
  );

  native(
    'Own completed cooking history still excludes Alice cooked after state clear while Bob completion remains irrelevant',
    async (f) => {
      const d = await withoutState(f);
      const filter = completedCooking(f, d.filters.dietTime);
      await exactPages(f, d.collection.id, filter, notCompletedIds(d), 'alice', true);
      await clearCooked(f, d);
      await exactPages(f, d.collection.id, filter, notCompletedIds(d), 'alice', true);
    },
  );

  native(
    'Own NOT completed entry state includes no-entry and cleared cooked with retained completed history and differs from NOT completed session',
    async (f) => {
      const d = await withoutState(f);
      await clearCooked(f, d);
      const tuple = stateChoice(f, 'schema:Recipe', 'completed');
      const filter = {
        and: [
          d.filters.dietTime,
          { owner: { presence: true } },
          {
            not: {
              owner: { state: { profileId: tuple.profileId, stateSetId: tuple.stateSetId, in: [tuple.stateId] } },
            },
          },
        ],
      };
      await exactPages(f, d.collection.id, filter, recipeIds(d), 'alice', true);
      await exactPages(f, d.collection.id, completedCooking(f, d.filters.dietTime), notCompletedIds(d), 'alice', true);
    },
  );

  native(
    'Own completed cooking query drops quick on the next read when its last label support is removed despite no own completion',
    async (f) => {
      const d = await withoutState(f);
      const filter = completedCooking(f, d.filters.dietTime);
      await exactPages(f, d.collection.id, filter, notCompletedIds(d), 'alice', true);
      const removed = status(
        await f.request(
          'alice',
          'DELETE',
          `/v1/libraryLabels/${d.quickLabel.id}?revision=${d.quickLabel.revision}`,
          undefined,
          discoveryKey(),
        ),
        200,
      );
      expect(removed.body).toEqual({ deleted: true });
      await noEntry(f, d.recipes.subjects['R-quick'].id);
      await exactPages(
        f,
        d.collection.id,
        filter,
        [d.recipes.subjects['R-edge'].id, d.recipes.subjects['R-other-cooked'].id],
        'alice',
        true,
      );
    },
  );

  native(
    'Public curated occurrence editing retains both B-long IDs notes and order while filtered browsing remains unique',
    async (f) => {
      const d = await catalogue(f);
      const editor = status(
        await f.request('alice', 'GET', `/v1/collections/${d.curated.source.id}/members?limit=100`),
        200,
      );
      expect(editor.body.next).toBeNull();
      expect(editor.body.members).toEqual(d.curated.occurrences.map((item) => item.member));
      const duplicates = d.curated.occurrences.filter(
        (item) => item.member.subjectId === d.books.subjects['B-long'].id,
      );
      expect(duplicates).toHaveLength(2);
      expect(new Set(duplicates.map((item) => item.member.id)).size).toBe(2);
      expect(new Set(duplicates.map((item) => item.member.note)).size).toBe(2);
      await exactPages(f, d.curated.source.id, d.filters.words, [d.books.subjects['B-long'].id], 'anonymous');
      expect(
        status(await f.request('alice', 'GET', `/v1/collections/${d.curated.source.id}/members?limit=100`), 200).body,
      ).toEqual(editor.body);
    },
  );

  native(
    'Public curated anonymous completed-session owner predicate is denied rather than ignored or bound to curator',
    async (f) => {
      const d = await catalogue(f);
      const response = await f.request(
        'anonymous',
        'GET',
        membersPath(d.curated.source.id, completedCooking(f, d.filters.dietTime)),
      );
      problem(response, 401, 'authentication_required');
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.body).not.toHaveProperty('members');
    },
  );

  native(
    'Bob private Everything and accepted-state lookups are indistinguishable from unknown including members',
    async (f) => {
      await f.state();
      const collections = [await everything(f), await stateView(f, stateChoice(f, 'schema:Book', 'active'))];
      const unknownId = (await f.base.createSubject('schema:Book', 'Unknown Collection Bob lookup control')).id;
      for (const collection of collections) {
        await concealedLikeUnknown(f, 'bob', collection.id, unknownId);
        await concealedLikeUnknown(f, 'bob', collection.id, unknownId, '/members?limit=2');
      }
    },
  );

  native(
    'Anonymous private Everything and accepted-state lookups are indistinguishable from unknown including members',
    async (f) => {
      await f.state();
      const collections = [await everything(f), await stateView(f, stateChoice(f, 'schema:Book', 'active'))];
      const unknownId = (await f.base.createSubject('schema:Book', 'Unknown Collection anonymous lookup control')).id;
      for (const collection of collections) {
        await concealedLikeUnknown(f, 'anonymous', collection.id, unknownId);
        await concealedLikeUnknown(f, 'anonymous', collection.id, unknownId, '/members?limit=2');
      }
    },
  );

  native(
    'Suspended pre-suspension native token receives401 invalid_credentials and invalid_token on common Collection lookup',
    async (f) => {
      // This genuine base token predates native suspension. Do not mint a hypothetical valid suspended bearer.
      const id = (await f.base.createSubject('schema:Book', 'Unknown Collection native auth control')).id;
      for (const suffix of ['', '/members?limit=2']) {
        const response = await f.request('suspended', 'GET', `/v1/collections/${id}${suffix}`);
        problem(response, 401, 'invalid_credentials');
        expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
        expect(response.body).not.toHaveProperty('members');
      }
    },
  );

  native(
    'Unscoped native personal Collection filter receives403 insufficient_scope without private rows',
    async (f) => {
      const d = await catalogue(f);
      const response = await f.request(
        'unscoped',
        'GET',
        membersPath(d.curated.source.id, completedCooking(f, d.filters.dietTime)),
      );
      problem(response, 403, 'insufficient_scope');
      expect(response.body).not.toHaveProperty('members');
    },
  );

  native(
    'Public curated recipe paging and old continuation use public facts for anonymous and editor after curator private completion changes',
    async (f) => {
      const d = await withoutState(f);
      const before = await exactPages(f, d.curated.source.id, d.filters.dietTime, recipeIds(d), 'anonymous');
      await exactPages(f, d.curated.source.id, d.filters.dietTime, recipeIds(d), 'editor');
      const session = await activeSession(f, d.recipes.subjects['R-quick'].id, 'schema:Recipe');
      status(
        await f.request(
          'alice',
          'POST',
          `/v1/progressSessions/${session.id}:complete`,
          { revision: session.revision },
          discoveryKey(),
        ),
        200,
      );
      const continued = status(
        await f.request(
          'anonymous',
          'GET',
          membersPath(d.curated.source.id, d.filters.dietTime, before[0]!.body.next as string),
        ),
        200,
      );
      expect(continued.body).toEqual(before[1]!.body);
      await exactPages(f, d.curated.source.id, d.filters.dietTime, recipeIds(d), 'anonymous');
      await exactPages(f, d.curated.source.id, d.filters.dietTime, recipeIds(d), 'editor');
      await exactPages(
        f,
        d.collection.id,
        completedCooking(f, d.filters.dietTime),
        [d.recipes.subjects['R-edge'].id, d.recipes.subjects['R-other-cooked'].id],
        'alice',
        true,
      );
    },
  );

  native(
    'Public curated continuation reauthorizes native source deletion and suspended credentials instead of disclosing cached membership',
    async (f) => {
      const d = await catalogue(f);
      const pages = await exactPages(
        f,
        d.curated.source.id,
        d.filters.formHarem,
        [d.books.subjects['B-long'].id, d.books.subjects['B-edge'].id, d.books.subjects['B-characters'].id],
        'anonymous',
      );
      const path = membersPath(d.curated.source.id, d.filters.formHarem, pages[0]!.body.next as string);
      const suspended = await f.request('suspended', 'GET', path);
      problem(suspended, 401, 'invalid_credentials');
      expect(suspended.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      const descriptor = status(await f.request('alice', 'GET', `/v1/collections/${d.curated.source.id}`), 200).body
        .collection as { revision: number };
      status(
        await f.request(
          'alice',
          'DELETE',
          `/v1/collections/${d.curated.source.id}?revision=${descriptor.revision}`,
          undefined,
          discoveryKey(),
        ),
        204,
      );
      problem(await f.request('anonymous', 'GET', path), 404, 'not_found');
    },
  );

  native(
    'Own private Everything continuation conceals its identity from Bob and anonymous under current native authority',
    async (f) => {
      const d = await withoutState(f);
      const pages = await exactPages(
        f,
        d.collection.id,
        d.filters.formHarem,
        [d.books.subjects['B-long'].id, d.books.subjects['B-edge'].id, d.books.subjects['B-characters'].id],
        'alice',
        true,
      );
      const cursor = pages[0]!.body.next as string;
      const unknownId = (await f.base.createSubject('schema:Book', 'Unknown Collection private cursor control')).id;
      const suffix = membersPath(d.collection.id, d.filters.formHarem, cursor).slice(
        `/v1/collections/${d.collection.id}`.length,
      );
      await concealedLikeUnknown(f, 'bob', d.collection.id, unknownId, suffix);
      await concealedLikeUnknown(f, 'anonymous', d.collection.id, unknownId, suffix);
    },
  );

  native(
    'Public curated successful empty page proves genuine exhaustion for contradictory released word predicates',
    async (f) => {
      const d = await catalogue(f);
      await exactPages(f, d.curated.source.id, { and: [d.filters.words, { not: d.filters.words }] }, [], 'anonymous');
    },
  );

  native(
    'Own Everything successful empty page proves genuine exhaustion for contradictory released word predicates',
    async (f) => {
      const d = await withoutState(f);
      await exactPages(f, d.collection.id, { and: [d.filters.words, { not: d.filters.words }] }, [], 'alice', true);
    },
  );

  native(
    'Own selected-state successful empty page proves genuine exhaustion for contradictory released word predicates',
    async (f) => {
      const d = await selectedState(f);
      await exactPages(f, d.bookCollection.id, { and: [d.filters.words, { not: d.filters.words }] }, [], 'alice', true);
    },
  );

  native(
    'Own selected-state view vegetarian quick NOT completed session returns exactly quick edge other-cooked and removes cleared quick while Everything retains it',
    async (f) => {
      const d = await selectedState(f);
      const history = await f.recipes();
      expect(history.released.subjects).toEqual(d.recipes.subjects);
      expect(history.alice.session).toMatchObject({
        subjectId: d.recipes.subjects['R-cooked'].id,
        state: 'completed',
      });
      expect(history.bob.session).toMatchObject({
        subjectId: d.recipes.subjects['R-other-cooked'].id,
        state: 'completed',
      });
      const profileId = f.profile('schema:Recipe').profile.id;
      expect(history.alice.accepted.pin.profileId).toBe(profileId);
      expect(history.bob.accepted.pin.profileId).toBe(profileId);
      // Semantic now exports the actual owner-capable shared type. This is the same catalogue filter and
      // adopted completed-session leaf, over Alice's separate accepted-state population, without new grammar.
      const filter: FilterDocument = {
        and: [
          d.filters.dietTime,
          { owner: { presence: true } },
          { not: { owner: { session: { profileId, lifecycle: 'completed' } } } },
        ],
      };
      await selectedPages(f, d.recipeCollection.id, filter, notCompletedIds(d), d.recipes.subjects['R-quick'].id);
      // Clearing quick's selected state removes it only from that view: its native independent label still
      // supplies presence. Neither Alice's retained cooked history nor Bob's completion changes meaning.
      await exactPages(f, (await everything(f)).id, filter, notCompletedIds(d), 'alice', true);
      expect(
        status(await f.request('alice', 'GET', `/v1/progressSessions/${history.alice.session.id}`), 200).body
          .progressSession,
      ).toEqual(history.alice.session);
      expect(
        status(await f.request('bob', 'GET', `/v1/progressSessions/${history.bob.session.id}`), 200).body
          .progressSession,
      ).toEqual(history.bob.session);
    },
  );
});
