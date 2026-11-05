import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { planReads, platformRegistry, UI_LOCALES, type CompositionDocument } from '@rezics/composition';
import { Compile } from 'typebox/compile';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { ZonePageResponseSchema } from '../../src/zones/contract.ts';
import { ZonePageReadProgressSchema } from '../../src/zones/page-continuation.ts';
import { createReleasedLibraryPopulation } from '../library/support/released-library-population.ts';
import { discoveryKey, type DiscoveryPersona } from '../support/released-discovery.ts';
import { createBody, page, resourceFixture } from '../zones/resource-fixture.ts';

// A saved Zone site over real Search and curated Collections. Readers are anonymous, a signed-in member without
// grants, and the Zone owner. The only delegated source is the owner's private Collection, read after an explicit grant.
type Answer = { status: number; headers: Headers; body: any };
type Reader = 'anonymous' | 'outsider' | 'editor';
type Target = { route: string } | { subject: string; view?: string };
type Listed = 'name' | 'collections';
const NOTES = ['First controlled occurrence', 'Second occurrence with a distinct note', 'PRIVATE-JOURNEY-NOTE'];
const path = (id: string) => `/v1/zones/${id}`;

function complete(answer: Answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(Compile(ZonePageResponseSchema).Check(answer.body), JSON.stringify(answer.body)).toBe(true);
  expect(answer.headers.get('cache-control')).toBe('private, no-store');
  return answer.body;
}

test('a saved Zone site serves TypeList, union and Subject pages to anonymous, member and delegated readers', async () => {
  const population = await createReleasedLibraryPopulation({ version: 1, search: 'native' });
  const call = (
    who: DiscoveryPersona,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    target: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Answer> => population.request(who, method, target, body, headers);
  try {
    const fixture = population.base;
    const curated = (await population.sources()).sources;
    const sourceOf = (visibility: 'public' | 'unlisted') =>
      curated.find(({ source }) => source.visibility === visibility)!.source;
    const books = await fixture.books();
    const recipes = await fixture.recipes();
    const book = books.subjects['B-long'].id;
    const shortBook = books.subjects['B-short'].id;
    const recipe = recipes.subjects['R-quick'].id;
    const typeList = (id: Listed): CompositionDocument => ({
      root: { props: {} },
      content: [{ type: 'TypeList', props: { id, title: { en: id }, types: ['schema:Book'], sort: id, limit: 24 } }],
    });
    const configuration = createBody().configuration;
    configuration.pages = [
      { route: '', document: typeList('name') },
      { route: 'about', document: page('About this site') },
      { route: 'ranked', document: typeList('collections') },
    ];

    // Owner setup: create a Zone with the public and unlisted curated sources, then publish it.
    await fixture.grant(
      'editor',
      ['zone:create', 'collection:create', 'collection:read', 'collection:update', 'gate:collections'],
      GLOBAL_CONTEXT,
    );
    const created = await call(
      'editor',
      'POST',
      '/v1/zones',
      { configuration, mounts: [sourceOf('public').id, sourceOf('unlisted').id], visibility: 'private' },
      discoveryKey(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const zone = created.body.zone as { id: string; revision: string };
    const save = async (saved: typeof configuration, mounts: string[], base: string) => {
      const answer = await call(
        'editor',
        'PUT',
        `${path(zone.id)}/configuration`,
        { configuration: saved, mounts },
        { ...discoveryKey(), 'if-match': `"${base}"` },
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body.zone.revision as string;
    };
    const publish = async (visibility: 'public' | 'private', base: string) => {
      const answer = await call(
        'editor',
        'POST',
        `${path(zone.id)}:publish`,
        { visibility },
        { ...discoveryKey(), 'if-match': `"${base}"` },
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body.zone.revision as string;
    };
    let revision = await publish('public', zone.revision);

    const read = (
      who: Reader,
      target: Target,
      options: { cursor?: string | undefined; languages?: string[] | undefined } = {},
    ) =>
      call(
        who,
        'POST',
        `${path(zone.id)}:readPage${options.cursor === undefined ? '' : `?${new URLSearchParams({ cursor: options.cursor })}`}`,
        { target, languages: options.languages ?? ['en'] },
      );
    // Retained preparation is followed by its own continuation, never repeated or reshaped into a partial page.
    const resolve = async (who: Reader, target: Target, languages?: string[] | undefined): Promise<Answer> => {
      let answer = await read(who, target, { languages });
      const seen = new Set<string>();
      while (answer.status === 202) {
        expect(Compile(ZonePageReadProgressSchema).Check(answer.body), JSON.stringify(answer.body)).toBe(true);
        expect(answer.headers.get('cache-control')).toBe('private, no-store');
        const next = answer.body.next as string;
        expect(seen.has(next)).toBe(false);
        seen.add(next);
        answer = await read(who, target, { cursor: next, languages });
      }
      return answer;
    };
    const listed = async (who: Reader, route: string, id: Listed, languages?: string[]) => {
      const result = complete(await resolve(who, { route }, languages));
      const list = result.reads[planReads(platformRegistry, result.document, { subject: null }).nodes[id]!];
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.next).toBeNull();
      const ids = (list.body.subjects as { id: string }[]).map(({ id: subject }) => subject);
      expect(new Set(ids).size, 'each canonical subject appears once').toBe(ids.length);
      return ids;
    };
    const native = async (sort: Listed) => {
      const answer = await call('anonymous', 'POST', '/v1/subjects:search', {
        filter: { type: { in: ['schema:Book'] } },
        sort,
        limit: 24,
        languages: ['en'],
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(answer.body.next).toBeNull();
      return (answer.body.subjects as { id: string }[]).map(({ id }) => id);
    };

    // Source-dependent pages stay closed until the ordinary platform gate opens.
    const closed = await read('anonymous', { route: '' });
    expect(closed.status).toBe(403);
    expect(closed.body.code).toBe('platform_closed');
    await fixture.setup.openFeatures(['zone_sources']);

    // Phase 1: saved catalogue scope plus overlapping public and unlisted mounts. Each TypeList keeps the native order.
    const names = await native('name');
    const ranks = await native('collections');
    expect(names).toContain(book);
    for (const who of ['anonymous', 'outsider', 'editor'] as const) {
      expect(await listed(who, '', 'name')).toEqual(names);
      expect(await listed(who, 'ranked', 'collections')).toEqual(ranks);
    }
    for (const locale of UI_LOCALES) expect(await listed('anonymous', '', 'name', [locale])).toEqual(names);

    const home = complete(await resolve('anonymous', { route: '' }));
    expect(home.zone).toEqual(
      expect.objectContaining({
        id: zone.id,
        revision,
        navigation: configuration.pages.map(({ route }) => ({ route })),
      }),
    );
    expect(complete(await resolve('outsider', { route: 'about' })).document).toEqual(configuration.pages[1]!.document);
    for (const who of ['anonymous', 'outsider'] as const) {
      const subjectPage = complete(await resolve(who, { subject: book, view: 'overview' }));
      expect(subjectPage.subject).toBe(book);
      expect(subjectPage.views).toContain('overview');
      for (const note of NOTES) expect(JSON.stringify(subjectPage)).not.toContain(note);
    }
    const union = await call('anonymous', 'GET', `${path(zone.id)}/subjects?limit=100`);
    expect(union.status, JSON.stringify(union.body)).toBe(200);
    const unionIds = (union.body.subjects as { id: string }[]).map(({ id }) => id);
    expect(new Set(unionIds).size).toBe(unionIds.length);
    expect(unionIds).toEqual(expect.arrayContaining([book, recipe]));
    for (const note of NOTES) expect(JSON.stringify(union.body)).not.toContain(note);
    expect((await resolve('anonymous', { subject: randomUUID() })).status).toBe(404);

    // Phase 2: the owner's private Collection is the only source here. Other readers gain it through an explicit grant.
    const own = await call(
      'editor',
      'POST',
      '/v1/collections',
      { title: 'Journey private source', visibility: 'private' },
      discoveryKey(),
    );
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const ownId = own.body.collection.id as string;
    const addMember = (subjectId: string, note: string) =>
      call('editor', 'POST', `/v1/collections/${ownId}/members`, { subjectId, note }, discoveryKey());
    expect((await addMember(book, 'PRIVATE-JOURNEY-NOTE')).status).toBe(201);
    revision = await save({ ...configuration, scope: [] }, [ownId], revision);
    expect(await listed('anonymous', '', 'name')).toEqual([]);
    expect(await listed('outsider', '', 'name')).toEqual([]);
    expect(await listed('editor', '', 'name')).toEqual([book]);
    expect((await resolve('outsider', { subject: book })).status).toBe(404);
    expect(complete(await resolve('editor', { subject: book, view: 'overview' })).subject).toBe(book);

    const grant = {
      resource: { route: routeOf(ownId)!, id: ownId },
      subject: { kind: 'account', id: fixture.personas.outsider.accountId },
      actions: ['collection:read'],
      valid: '(,)',
    };
    expect((await call('editor', 'POST', '/v1/grants', grant, discoveryKey())).status).toBe(201);
    expect(await listed('outsider', '', 'name')).toEqual([book]);
    expect(complete(await resolve('outsider', { subject: book, view: 'overview' })).subject).toBe(book);
    expect(await listed('anonymous', '', 'name')).toEqual([]);
    // A source change appears on the next readback of the same mounted Collection.
    expect((await addMember(shortBook, 'Added after the grant')).status).toBe(201);
    const afterChange = await listed('outsider', '', 'name');
    expect(afterChange).toHaveLength(2);
    expect(afterChange).toEqual(expect.arrayContaining([book, shortBook]));
    expect((await call('editor', 'POST', '/v1/grants:revoke', grant, discoveryKey())).status).toBe(200);
    expect(await listed('outsider', '', 'name')).toEqual([]);
    expect((await resolve('outsider', { subject: book })).status).toBe(404);

    // Phase 3: restore the public mounts; edits replace the full configuration and a retried command keeps its first answer.
    const mounts = [sourceOf('public').id, sourceOf('unlisted').id];
    const edited = { ...configuration, labels: { ...configuration.labels, en: 'Journey site, edited' } };
    const retry = discoveryKey();
    const firstBody = { configuration: edited, mounts };
    const first = await call('editor', 'PUT', `${path(zone.id)}/configuration`, firstBody, {
      ...retry,
      'if-match': `"${revision}"`,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const original = revision;
    revision = first.body.zone.revision as string;
    revision = await save({ ...edited, labels: { ...edited.labels, en: 'Journey site, revised' } }, mounts, revision);
    const replay = await call('editor', 'PUT', `${path(zone.id)}/configuration`, firstBody, {
      ...retry,
      'if-match': `"${original}"`,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toEqual(first.body);
    const conflict = await call(
      'editor',
      'PUT',
      `${path(zone.id)}/configuration`,
      { ...firstBody, mounts: [] },
      { ...retry, 'if-match': `"${revision}"` },
    );
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('idempotency_conflict');
    expect(complete(await resolve('anonymous', { route: '' })).zone.labels.en).toBe('Journey site, revised');
    expect(await listed('anonymous', '', 'name')).toEqual(names);

    // Publication changes visibility only; the private Zone is refused to readers and answered to its owner.
    revision = await publish('private', revision);
    expect((await resolve('anonymous', { route: '' })).status).toBe(404);
    expect((await resolve('outsider', { subject: book })).status).toBe(404);
    expect(complete(await resolve('editor', { route: '' })).zone.visibility).toBe('private');
    revision = await publish('public', revision);
    expect(complete(await resolve('anonymous', { route: '' })).zone.labels.en).toBe('Journey site, revised');
  } finally {
    await population.close();
  }
}, 600_000);

test('a published saved Zone keeps its configuration through replay, deletion and restoration', async () => {
  const f = await resourceFixture();
  try {
    await f.available();
    const input = createBody();
    input.configuration.scope = [];
    input.configuration.pages = [
      { route: '', document: page('Journey home') },
      { route: 'about', document: page('About this site') },
    ];
    const zone = await f.create(input);
    const published = await f.call(
      'owner',
      'POST',
      `${path(zone.id)}:publish`,
      { visibility: 'public' },
      f.conditional(zone.revision),
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    let revision = published.body.zone.revision as string;
    expect(complete(await f.read(zone.id, 'anonymous')).zone.visibility).toBe('public');

    const retry = { 'idempotency-key': JSON.stringify(randomUUID()) };
    const edited = { ...input.configuration, labels: { ...input.configuration.labels, en: 'Journey site, edited' } };
    const body = { configuration: edited, mounts: [] };
    const saved = await f.call('owner', 'PUT', `${path(zone.id)}/configuration`, body, {
      ...retry,
      ...f.conditional(revision),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const original = revision;
    revision = saved.body.zone.revision as string;
    const replayed = await f.call('owner', 'PUT', `${path(zone.id)}/configuration`, body, {
      ...retry,
      ...f.conditional(original),
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(saved.body);

    const deleted = await f.call('owner', 'DELETE', path(zone.id), undefined, f.conditional(revision));
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    revision = deleted.body.zone.revision as string;
    for (const who of ['anonymous', 'owner'] as const) expect((await f.read(zone.id, who)).status).toBe(404);

    const restored = await f.call('owner', 'POST', `${path(zone.id)}:restore`, {}, f.conditional(revision));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const readback = complete(await f.read(zone.id, 'anonymous'));
    expect(readback.zone.labels.en).toBe('Journey site, edited');
    expect(readback.zone.visibility).toBe('public');
    expect((await f.call('owner', 'GET', `${path(zone.id)}/configuration`)).body.configuration).toEqual(edited);
  } finally {
    await f.close();
  }
}, 180_000);
