import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import hub from '../../../../../scripts/qa/cases/outcomes/anime/anime-manga-and-vn-hub-parts-wholes-and-relations.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { readDatedAnimeHub, readWorkParts, readWorkWholes } from '../../../../../apps/web/features/work-page/anime-hub-recorded-page.ts';
import { readSuppliedContents } from '../../../../../apps/web/features/work-page/games-hub-recorded-page.ts';
import { mainTrackingApi } from '../../../../../apps/web/features/tracking/api.ts';
import { animeRelationsReads, readAnimeRelationsConnections } from '../../../../../apps/web/features/work-page/anime-relations-recorded-page.ts';
import { booksEditionReads, readBooksEditionStatus } from '../../../../../apps/web/features/work-page/books-edition-page.read.ts';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { seedTypes, typeEntry } from '../../../../../apps/web/features/catalogue/types.ts';
import { progressControl } from '../../../../../apps/web/features/tracking/medium-progress.tsx';
import { standingOf } from '../../../../../apps/web/features/tracking/episodes.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Fixture = Work & {
  type: string;
  composition: Composition;
  relations: string[];
  hiddenRelation: string;
};
setDefaultTimeout(120_000);
let sessions: PersonaSessions;
const roots: Fixture[] = [];
const parts: Work[] = [];
let privatePart: Work;
let privateWhole: Work;
let privateComposition: Composition;
const recording = new OutcomeRecorder(hub);
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession, fields: Record<string, string> = {}) =>
  new URLSearchParams({
    ...fields,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
async function answer<T>(request: Promise<Response>, status = 200, context = ''): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${context} ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  sessions = await personaSessions();
  await recording.prepare();
  const owner = sessions.owner;
  const operator = sessions.operator;
  // An explicit creation grant admits administrator media kinds. It grants
  // the operator no authority over any of the owner's resulting Works.
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
        title: `${title} ${randomUUID()}`,
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
          body: `Original synthetic ${title}: a seed gardener opens a path to a new island. Written by the fixture owner.`,
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
  const compose = async (work: Work, targets: Work[]) => {
    const initial = await answer<Composition>(
      owner.main('POST', '/v1/compositions', {
        profile: 'work-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: owner.actingSubject,
      }),
      201,
    );
    return answer<Composition>(
      owner.main('POST', `/v1/compositions/${short(initial.structure)}/changes`, {
        profile: 'work-composition',
        expectedHead: initial.revision,
        actingSubject: owner.actingSubject,
        operations: targets.map((target, index) => ({
          op: 'insert',
          role: 'part',
          parent: initial.structure,
          position: 'last',
          target: target.work,
          displayLabel: `Part ${index + 1}`,
          inclusion: 'required',
        })),
      }),
    );
  };
  for (const name of ['First seed journey', 'Second seed journey'])
    parts.push(await create(name, 'https://schema.org/DigitalDocument'));
  privatePart = await create('Private seed journey', 'https://schema.org/DigitalDocument', false);
  privateWhole = await create('Private seed omnibus', 'https://schema.org/Book', false);
  privateComposition = await compose(privateWhole, [parts[0]!]);
  for (const [title, type] of [
    ['Animated seed islands', 'https://schema.org/TVSeries'],
    ['Seed islands manga', 'https://schema.org/Book'],
    ['Seed islands visual novel', 'https://schema.org/VideoGame'],
  ] as const) {
    const work = await create(title, type);
    roots.push({
      ...work,
      type,
      composition: await compose(work, [privatePart, ...parts]),
      relations: [],
      hiddenRelation: '',
    });
  }
  const definition = await answer<{ component: string; revision: string }>(
    operator.main('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1',
      expectedHead: null,
      actingSubject: operator.actingSubject,
      state: {
        component: 'definition',
        kind: 'relation',
        notation: `seed-counterpart-${randomUUID()}`,
        workSubjectRole: 'target',
        roles: ['source', 'target'].map((key) => ({
          key,
          minParticipants: 1,
          maxParticipants: 1,
          ordered: false,
        })),
      },
    }),
    201,
  );
  const relate = async (source: Work, target: Work) =>
    (
      await answer<{ occurrence: string }>(
        owner.main('POST', '/v1/relations/changes', {
          profile: 'relation-change-v1',
          expectedHead: null,
          definition: definition.revision,
          participations: [
            { role: 'source', participant: { kind: 'resource', ref: source.work } },
            { role: 'target', participant: { kind: 'resource', ref: target.work } },
          ],
          evidence: `https://example.test/original-seed-counterparts/${short(source.work)}/${short(target.work)}`,
          actingSubject: owner.actingSubject,
        }),
        201,
      )
    ).occurrence;
  for (const root of roots) {
    for (const target of parts) root.relations.push(await relate(root, target));
    root.hiddenRelation = await relate(root, privatePart);
  }
}, 300_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await sessions?.close(); }
});

async function pages<T>(
  person: PersonaSession,
  path: string,
  field: 'parts' | 'wholes' | 'occurrences' | 'items',
) {
  const items: T[] = [];
  let after: string | null = null;
  let count = 0;
  do {
    expect(++count).toBeLessThan(20);
    const page: { next: string | null } & Partial<Record<typeof field, T[]>> = await answer(
      person.main('GET', `${path}?${query(person, { limit: '1', ...(after ? { after } : {}) })}`),
      200,
      `GET ${path}, limit=1, continuationLength=${after?.length ?? 0}`,
    );
    items.push(...page[field]!);
    after = page.next;
  } while (after);
  return items;
}

async function read(name: PersonaName) {
  const session = sessions[name];
  const sample = recording.session(name, session);
  let request = 0;
  const person: PersonaSession = { ...session,
    main: (...args) => sample(`proof-${++request}`, ...args) };
  const expectedParts = name === 'owner' ? [privatePart, ...parts] : parts;
  for (const root of roots) {
    const base = `/v1/resources/${short(root.work)}`;
    const page = await answer<{ work: { id: string }; registry: { type: string } }>(
      person.main('GET', `${base}/page?${query(person)}`),
    );
    expect(page.registry.type).toBe(root.type);
    const entries = await pages<{ work: string }>(person, `${base}/parts`, 'parts');
    expect(entries.map((item) => item.work)).toEqual(expectedParts.map((part) => part.work));
    const composition = await pages<{ target: string }>(
      person,
      `/v1/compositions/${short(root.composition.structure)}`,
      'occurrences',
    );
    expect(composition.map((item) => item.target)).toEqual(expectedParts.map((part) => part.work));
    const relations = await pages<{ relation: string }>(person, `${base}/relations`, 'items');
    expect(relations.map((item) => item.relation)).toEqual(
      [...root.relations, ...(name === 'owner' ? [root.hiddenRelation] : [])].sort(),
    );
    if (name !== 'owner')
      expect(JSON.stringify([page, entries, composition, relations])).not.toContain(
        privatePart.work,
      );
    const credits = await answer<{ items: { role: string; agent: string }[] }>(
      person.main('GET', `/v1/works/${short(root.work)}/credits?${query(person)}`),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject }),
    );
    const variants = await answer<{ variants: { author: string; language: string }[] }>(
      person.main('GET', `/v1/main-versions/${short(root.mainVersion)}/native-variants`),
    );
    expect(variants.variants).toContainEqual(
      expect.objectContaining({ author: sessions.owner.actingSubject, language: 'en' }),
    );
  }
  const wholes = await pages<{ work: string }>(
    person,
    `/v1/resources/${short(parts[0]!.work)}/wholes`,
    'wholes',
  );
  expect(wholes.map((item) => item.work).sort()).toEqual(
    [...roots.map((root) => root.work), ...(name === 'owner' ? [privateWhole.work] : [])].sort(),
  );
  for (const suffix of ['page', 'parts', 'wholes', 'relations']) {
    const hidden = person.main(
      'GET',
      `/v1/resources/${short(privateWhole.work)}/${suffix}?${query(person)}`,
    );
    if (name === 'owner') await answer(hidden);
    else
      expect(await answer(hidden, 404)).toEqual(
        await answer(
          person.main('GET', `/v1/resources/${randomUUID()}/${suffix}?${query(person)}`),
          404,
        ),
      );
  }
  const privatePath = `/v1/compositions/${short(privateComposition.structure)}?${query(person)}`;
  if (name === 'owner')
    expect(await answer(person.main('GET', privatePath))).toMatchObject({
      work: privateWhole.work,
    });
  else
    expect(await answer(person.main('GET', privatePath), 404)).toEqual(
      await answer(person.main('GET', `/v1/compositions/${randomUUID()}?${query(person)}`), 404),
    );
}

/** Record the shared production readers with this persona's unchanged acting Person. */
async function visit(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  await Promise.all([...roots, parts[0]!, privateWhole].map(async (work, index) => {
    let request = 0;
    const faults: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      try { return await sample(`visit-${index + 1}-${++request}`, init?.method ?? 'GET', path, body); }
      catch (error) { faults.push(error); throw error; }
    };
    const main = browserMainApi('http://record.invalid', { anonymous: !person.actingSubject, fetcher });
    const host = { main, actingSubject: person.actingSubject ?? undefined };
    const id = short(work.work);
    const registry = await main.v1.types.get();
    if (registry.data) seedTypes(registry.data);
    const page = await readDatedAnimeHub(main, host.actingSubject, id);
    if (faults.length) throw faults[0];
    if (!page.header.ok) return;
    await Promise.all([
      readAnimeRelationsConnections(animeRelationsReads(host), id, { grain: 'series' }),
      readWorkParts(main, host.actingSubject, id, { limit: 7 }),
      readWorkWholes(main, host.actingSubject, id, { limit: 3 }),
      readSuppliedContents(host, id, {}),
      readBooksEditionStatus(booksEditionReads(host), id, 'en'),
      host.actingSubject ? mainRelationships(host.actingSubject, {
        origin: `http://record.invalid${BFF_PREFIX}`, fetch: fetcher,
      }).state(work.work, 'work') : null,
    ]);
    if (host.actingSubject) {
      const tracking = mainTrackingApi(host.actingSubject, () => main);
      const [preference] = await Promise.all([
        tracking.preference(work.work), tracking.editions(work.work), tracking.relations(work.work),
        tracking.definition('correspondence-equivalent'),
      ]);
      await tracking.series(work.work, preference.ok ? preference.data?.language ?? 'en' : 'en');
      if (tracking.media) {
        const types = await tracking.media.types(work.work);
        if (types.ok || types.failure !== 'missing') {
          const choice = await progressControl(tracking.media, tracking.episodes ?? null, work.work,
            types.ok && types.data ? typeEntry(types.data)?.presentation ?? null : null);
          if (choice.kind === 'episodes' && tracking.episodes) await standingOf(tracking.episodes, work.work);
          else if (choice.kind === 'chapters') {
            const standing = await tracking.media.standing(work.work);
            if (standing.ok && !standing.data.opened) await tracking.media.positions(work.work);
          } else if (choice.kind === 'work') await tracking.media.workStanding(work.work);
          else if (choice.kind === 'game') {
            const routes = await tracking.media.routes(work.work);
            if (routes.ok) await Promise.all(routes.data.items.map(route => tracking.media!.progress(route)));
          }
        }
      }
    }
    if (faults.length) throw faults[0];
  }));
}

async function proveAndVisit(name: PersonaName) {
  await read(name);
  await visit(name);
}

outcomeTest(hub, 'visitor', () => proveAndVisit('visitor'), recording);
outcomeTest(hub, 'stranger', () => proveAndVisit('stranger'), recording);
outcomeTest(hub, 'member', () => proveAndVisit('member'), recording);
outcomeTest(hub, 'owner', () => proveAndVisit('owner'), recording);
outcomeTest(hub, 'moderator', () => proveAndVisit('moderator'), recording);
outcomeTest(hub, 'operator', () => proveAndVisit('operator'), recording);
