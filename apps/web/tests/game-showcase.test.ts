import { afterEach, expect, test } from 'bun:test';
import { createKernelClient, type SubjectLinksResponse } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import {
  game,
  gameSparse,
  gameDefinitions,
  gameDigest,
  gameReleases,
  gameSubjects,
  gameSubjectMap,
  gameSubjectRead,
  gameSummary,
} from '../src/kernel/fixtures/game-showcase';
import { gameEntryState, gameShowcasePage, selectGameShowcase } from '../src/kernel/fake/game-showcase';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { gameOverviewInitial } from '../src/features/pages/game-overview';
import {
  gameReaderEditionPage,
  readGameReader,
  type GameReaderReady,
} from '../src/features/catalogue/game-reader/model';
import { gameDatePresentation } from '../src/features/catalogue/game-reader/date';
import { subjectTabs } from '../src/features/pages/views';
import { QUESTION } from '../src/kernel/fake/ratings';

const kernel = () => createKernelClient('https://kernel.invalid', { fetch: createStoryRecordedKernelFetch() });
const headers = { authorization: 'Bearer story-viewer' };
const guide = { ...gameDefinitions, digest: gameDigest };
afterEach(() => selectGameShowcase());
const views: View[] = [
  'overview',
  'editions',
  'contents',
  'characters',
  'credits',
  'relations',
  'reviews',
  'discussion',
  'lists',
  'details',
];
function leaf(page: ReturnType<typeof gameShowcasePage>, name: string) {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    context: page.context,
    ...(page.continuation ? { continuation: page.continuation } : {}),
  });
  return page.reads[plan.nodes[name]!]!;
}
async function ready(): Promise<GameReaderReady> {
  const result = await readGameReader(
    kernel(),
    guide,
    {
      id: game.id,
      context: gameSubjectRead(game.id).subject.context,
      type: 'schema:VideoGame',
    },
    'en',
  );
  if (!result.ok) throw new Error(`Expected a native Game reading, received ${result.reason}`);
  return result;
}

test('every installed Game tab is served by its released composition and has its planned responses', async () => {
  const client = kernel();
  expect(
    subjectTabs(gameShowcasePage())
      .map((tab) => tab.view)
      .sort(),
  ).toEqual([...views].sort());
  for (const view of views) {
    const response = await client.pages.$read.post({ target: { subject: game.id, view }, languages: ['en'] });
    expect(response.status).toBe(200);
    const page = response.data as ReturnType<typeof gameShowcasePage>;
    const plan = planReads(platformRegistry, page.document as CompositionDocument, {
      subject: page.subject,
      context: page.context,
    });
    expect(Object.keys(page.reads).sort()).toEqual(Object.keys(plan.reads).sort());
    expect(Object.values(page.reads).every((read) => read.status === 200)).toBe(true);
  }
});

test('each disclosed release has an exact destination, comparison, native date and association back to the work', async () => {
  const reading = await ready();
  expect(reading.editions.map((row) => row.subject)).toEqual(gameReleases.map((item) => item.id));
  expect(reading.workReleaseCards?.state).toBe('available');
  for (const row of reading.editions) {
    const response = await kernel().subjects({ id: row.subject }).get();
    expect(response.status).toBe(200);
    expect(response.data?.subject.statements['schema:exampleOfWork']![0]).toEqual(row.assertion!);
    expect(row.assertion?.value).toEqual({ type: 'value', content: game.id });
    expect(row.assertion?.qualifiers).toHaveLength(1);
    expect(row.assertion?.references).toHaveLength(1);
    expect(gameShowcasePage(row.subject).subject).toBe(row.subject);
  }
  const dates = gameReleases.map((item) => item.statements['schema:datePublished']![0]!);
  expect(gameDatePresentation(dates[0]!, gameDigest, 'en').kind).toBe('exact');
  expect(gameDatePresentation(dates[2]!, gameDigest, 'en').kind).toBe('partial');
  expect(gameDatePresentation(dates[4]!, gameDigest, 'en').kind).toBe('tba');
  const initial = gameOverviewInitial(gameShowcasePage(), { ...reading, editions: [], editionsAdmitted: false });
  expect(initial?.ok && initial.editions).toEqual(reading.editions);
});

test('every internal assertion destination and local cover variant belongs to the coherent fixture family', async () => {
  for (const item of gameSubjects) {
    for (const statement of Object.values(item.statements).flat()) {
      for (const snak of [statement, ...statement.qualifiers]) {
        if (snak.property.data_type === 'wikibase-item' && snak.value.type === 'value') {
          expect(gameSubjectMap.has(String(snak.value.content))).toBe(true);
        }
      }
    }
    const summary = gameSummary(item.id);
    for (const variant of summary.cover?.variants ?? []) {
      expect(
        await Bun.file(
          new URL(`../.storybook/media/${summary.cover!.media}/${variant.format}-${variant.width}`, import.meta.url),
        ).exists(),
      ).toBe(true);
    }
  }
});

test('independent release and review failures retain siblings and recover through their native addresses', async () => {
  const seed = await ready();
  const page = gameShowcasePage(game.id, 'overview', { failReleases: true });
  const failed = gameOverviewInitial(page, seed);
  expect(failed?.ok && failed.editionFailure).toEqual({ ok: false, reason: 'unavailable' });
  expect(failed?.ok && failed.public.subject.id).toBe(game.id);
  const broken = gameShowcasePage();
  const plan = planReads(platformRegistry, broken.document as CompositionDocument, {
    subject: game.id,
    context: broken.context,
  });
  const releaseKey = Object.entries(plan.reads).find(
    ([, read]) => read.kind === 'links' && read.property === 'schema:exampleOfWork',
  )![0];
  const releasePage = broken.reads[releaseKey]!.body as SubjectLinksResponse;
  const row = releasePage.links[0]!;
  for (const body of [
    {},
    { ...releasePage, links: [null] },
    { ...releasePage, links: [{ ...row, assertion: { id: row.statement, value: row.assertion!.value } }] },
    { ...releasePage, links: [{ ...row, assertion: { id: row.statement, property: row.assertion!.property } }] },
  ]) {
    broken.reads[releaseKey] = { status: 200, body };
    expect(gameOverviewInitial(broken, seed)).toMatchObject({
      ok: true,
      public: seed.public,
      groups: seed.groups,
      editionsAdmitted: true,
      editionFailure: { ok: false, reason: 'unavailable' },
    });
  }
  broken.reads[releaseKey] = { status: 403, body: { code: 'forbidden' } };
  expect(gameOverviewInitial(broken, seed)).toEqual({ ok: false, reason: 'withheld' });
  for (const state of ['release-failure', 'review-failure'] as const) {
    selectGameShowcase(state);
    const client = kernel();
    const first = await client.pages.$read.post({ target: { subject: game.id }, languages: ['en'] });
    expect(Object.values(first.data!.reads).filter((read) => read.status === 503)).toHaveLength(1);
    const retry = await client.pages.$read.post({ target: { subject: game.id }, languages: ['en'] });
    expect(Object.values(retry.data!.reads).every((read) => read.status === 200)).toBe(true);
  }
  const sparse = gameShowcasePage(gameSparse.id);
  expect((leaf(sparse, 'editions').body as SubjectLinksResponse).links).toEqual([]);
  expect(gameSummary(gameSparse.id).cover).toBeNull();
});

test('member library and score controls read back per Subject without changing another release', async () => {
  selectGameShowcase();
  const client = kernel();
  const entry = client.libraryEntries({ subjectId: game.id });
  expect((await entry.put({ state: gameEntryState(2) }, { headers })).status).toBe(200);
  expect((await entry.get({ headers })).data?.libraryEntry.state).toBe(gameEntryState(2));
  expect((await client.libraryEntries({ subjectId: gameReleases[0]!.id }).get({ headers })).status).toBe(404);
  const vote = client.subjects({ id: game.id }).ratings({ questionId: QUESTION }).vote;
  expect((await vote.put({ units: 19 }, { headers })).status).toBe(200);
  expect((await vote.get({ headers })).data?.units).toBe(19);
  expect((await vote.delete(undefined, { headers })).status).toBe(204);
  expect((await vote.get({ headers })).status).toBe(404);
  expect((await entry.get()).status).toBe(401);
});

test('comparison HTTP admission preserves native facts and useful memberships independently', async () => {
  const seed = await ready();
  const page = gameShowcasePage();
  const response = leaf(page, 'editions');
  const body = response.body as SubjectLinksResponse;
  const address = { id: game.id, context: seed.public.subject.context, type: 'schema:VideoGame' };
  const admit = (workReleaseCards: unknown) => gameReaderEditionPage(seed, address, 200, { ...body, workReleaseCards });
  for (const comparison of [body.workReleaseCards, { state: 'available', cards: [] }, { state: 'unavailable' }]) {
    const result = admit(comparison);
    expect(result.ok && result.workReleaseCards).toBe(comparison);
    expect(result.ok && result.editions).toBe(body.links);
  }
  const invalid = [
    undefined, null, {}, { state: 'available' }, { state: 'available', cards: {} }, { state: 'other' },
    { state: 'available', cards: [null] },
    { state: 'available', cards: [], extra: 'x'.repeat(2 * 1024 * 1024) },
  ];
  for (const comparison of invalid) {
    const result = admit(comparison);
    expect(result).toMatchObject({ ok: true, workReleaseCards: { state: 'unavailable' }, next: body.next });
    expect(result.ok && result.public).toBe(seed.public);
    expect(result.ok && result.editions).toBe(body.links);
    response.body = { ...body, workReleaseCards: comparison };
    expect(gameOverviewInitial(page, seed)).toMatchObject({
      ok: true, editions: body.links, workReleaseCards: { state: 'unavailable' },
    });
  }
  expect(gameReaderEditionPage(seed, address, 200, { ...body, links: [...body.links, body.links[0]] })).toEqual({ ok: false, reason: 'unavailable' });
  expect(gameReaderEditionPage(seed, address, 200, { ...body, next: 'x'.repeat(4097) })).toEqual({ ok: false, reason: 'unavailable' });
  expect(gameReaderEditionPage(seed, address, 200, { ...body, extra: 'x'.repeat(3 * 1024 * 1024) })).toEqual({ ok: false, reason: 'unavailable' });
});

test('malformed native comparison identities, evidence and budgets never become rendered facts', async () => {
  const seed = await ready();
  const body = leaf(gameShowcasePage(), 'editions').body as SubjectLinksResponse;
  if (body.workReleaseCards?.state !== 'available') throw new Error('Expected native comparison cards');
  const card = body.workReleaseCards.cards[0]!;
  const property = 'schema:inLanguage';
  const field = card.fields[property];
  if (field.state !== 'available') throw new Error('Expected native language facts');
  const statement = field.statements[0]!;
  const replace = (value: unknown) => ({ ...card, fields: { ...card.fields, [property]: value } });
  const address = { id: game.id, context: seed.public.subject.context, type: 'schema:VideoGame' };
  const admit = (workReleaseCards: unknown) => gameReaderEditionPage(seed, address, 200, { ...body, workReleaseCards });
  for (const state of ['unsupported', 'missing', 'withheld', 'unavailable']) {
    const comparison = { state: 'available', cards: [replace({ state })] };
    const result = admit(comparison);
    expect(result.ok && result.workReleaseCards).toBe(comparison);
  }
  for (const type of ['somevalue', 'novalue']) {
    const comparison = { state: 'available', cards: [replace({ ...field, statements: [{ ...statement, value: { type } }] })] };
    const result = admit(comparison);
    expect(result.ok && result.workReleaseCards).toBe(comparison);
  }
  const invalid = [
    { ...card, subject: game.id },
    { ...card, type: 'schema:Person' },
    { ...card, summary: { ...card.summary, id: game.id } },
    { ...card, membership: { ...card.membership, id: statement.id } },
    { ...card, membership: { ...card.membership, value: { type: 'value', content: gameSparse.id } } },
    { ...card, related: { [game.id]: null } },
    { ...card, summary: { ...card.summary, cover: { ...card.summary.cover!, credit: null } } },
    { ...card, fields: {} }, replace(null), replace({ state: 'other' }),
    replace({ state: 'available' }), replace({ ...field, related: [] }),
    replace({ ...field, statements: [null] }),
    replace({ ...field, statements: [{ ...statement, property: { ...statement.property, id: 'schema:publisher' } }] }),
    replace({ ...field, statements: [{ ...statement, value: { type: 'value' } }] }),
    replace({ ...field, statements: [{ ...statement, qualifiers: [null] }] }),
    replace({ ...field, statements: [{ ...statement, references: [{ hash: 'source', parts: [null] }] }] }),
    replace({ ...field, statements: [{ ...statement, rezics: null }] }),
    replace({ ...field, statements: Array(33).fill(statement) }),
    replace({ ...field, statements: [{ ...statement, qualifiers: Array(65).fill(statement) }] }),
    replace({ ...field, statements: [{ ...statement, references: Array(33).fill({ hash: 'source', parts: [] }) }] }),
    replace({ ...field, statements: [{ ...statement, references: [{ hash: 'source', parts: Array(65).fill(statement) }] }] }),
    replace({ ...field, statements: [{ ...statement, value: { type: 'value', content: 'x'.repeat(64 * 1024) } }] }),
  ];
  for (const cards of [...invalid.map((value) => [value]), [card, card], Array(21).fill(card)]) {
    const result = admit({ state: 'available', cards });
    expect(result).toMatchObject({ ok: true, workReleaseCards: { state: 'unavailable' } });
    expect(result.ok && result.editions).toBe(body.links);
  }
});
