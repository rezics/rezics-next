import { beforeEach, describe, expect, test } from 'bun:test';
import { seedServedTypes, servedTypes } from '../features/catalogue/type-fixtures.ts';
import { showsBookControls, workExperience } from '../features/entity-page/experience.ts';
import { baseSections, projectionFor } from '../features/entity-page/fixtures.ts';
import { baseSections as mainBaseSections } from '../../../services/main/src/modules/entity-page/read.ts';
import { summaryHref } from '../features/entity-page/views.tsx';
import { followHref } from '../features/entity-page/href.ts';
import { continueHref, entityHref, parseEntityCursors, parseEntityRef, standaloneHrefFor }
  from '../features/entity-page/route.ts';
import type { TargetBase } from '../features/entity-page/types.ts';
import { drawnSections } from '../features/entity-page/views.tsx';
import { newPostProgress, submitPost } from '../features/post-composer/api.ts';
import { isPublicPagePath, localizedPath } from '../i18n/locale.ts';

const id = '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d';
const iri = (uuid: string) => `https://rezics.com/id/${uuid}`;

/** An Eden client that records the path and options of the `get` it reaches, for any path. */
function recorder() {
  const calls: { path: string[]; options: unknown }[] = [];
  const node = (path: string[]): unknown => new Proxy(() => undefined, {
    get: (_, key: string) => key === 'get'
      ? (options: unknown) => { calls.push({ path, options }); return Promise.resolve({ data: {}, error: null }); }
      : node([...path, key]),
  });
  return { calls, main: node([]) };
}

describe('G-644 /e addresses', () => {
  test('a ref is a UUID or a native IRI; a resource has no slug', () => {
    expect(parseEntityRef(id)).toBe(id);
    expect(parseEntityRef(iri(id))).toBe(id);
    expect(parseEntityRef('sword-art-online')).toBeNull();
    expect(parseEntityRef('')).toBeNull();
    expect(entityHref(iri(id))).toBe(`/e/${id}`);
  });

  test('/e and the composer it leads to are locale pages, so a link keeps the reader’s language', () => {
    expect(isPublicPagePath(`/zh-Hant/e/${id}`)).toBe(true);
    expect(isPublicPagePath('/en/submit')).toBe(true);
    expect(localizedPath(`/e/${id}`, 'zh-Hant')).toBe(`/zh-Hant/e/${id}`);
    expect(localizedPath(`/submit?target=${id}`, 'ja')).toBe(`/ja/submit?target=${id}`);
    expect(isPublicPagePath('/eventually')).toBe(false);
  });

  test('list cursors are single, bounded values; anything else is refused', () => {
    expect(parseEntityCursors({})).toEqual({});
    expect(parseEntityCursors({ statements: 'a', relations: 'b', discussion: 'c', other: 'x' }))
      .toEqual({ statements: 'a', relations: 'b', discussion: 'c' });
    expect(parseEntityCursors({ statements: ['a', 'b'] })).toBeNull();
    expect(parseEntityCursors({ discussion: 'x'.repeat(2049) })).toBeNull();
  });

  test('continuing one list keeps the others and the section anchor', () => {
    expect(continueHref(`/e/${id}`, { relations: 'r1' }, 'statements', 's2'))
      .toBe(`/e/${id}?relations=r1&statements=s2#statements`);
    expect(continueHref(`/e/${id}`, { statements: 's2' }, 'statements', null)).toBe(`/e/${id}#statements`);
  });

  test('a Work links to its /w host and everything else to /e; a Zone can map both', () => {
    const hrefFor = standaloneHrefFor({}, `/e/${id}`);
    expect(hrefFor({ kind: 'resource', iri: iri(id), base: 'work', type: 'work' })).toBe(`/w/${id}`);
    for (const base of ['release', 'occurrence', 'realization', 'resource'] as const) {
      expect(hrefFor({ kind: 'resource', iri: iri(id), base, type: 'resource' })).toBe(`/e/${id}`);
    }
    expect(hrefFor({ kind: 'continue', section: 'discussion', cursor: 'c2' })).toBe(`/e/${id}?discussion=c2#discussion`);
  });
});

describe('G-644 links', () => {
  test('a reference that is no page target (a Realm, a context, a concept) is named without a link', () => {
    const hrefFor = standaloneHrefFor({}, `/e/${id}`);
    const link = summaryHref(hrefFor);
    const summary = (base: string | null, type: string) => ({ reference: iri(id), status: 'available', type, base,
      work: null, disclosure: 'public', name: { value: 'x', language: 'en', direction: 'ltr', basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'k', resourceType: type } }) as never;
    for (const type of ['realm', 'space', 'context', 'concept', 'main-version']) {
      expect(link(summary(null, type)), type).toBeNull();
    }
    expect(link(summary('release', 'release'))).toBe(`/e/${id}`);
    expect(link(summary('work', 'work'))).toBe(`/w/${id}`);
  });
});

describe('G-644 fixtures follow Main', () => {
  test('the fixtures’ section table equals the one Main builds pages from', () => {
    expect(baseSections).toEqual(mainBaseSections as unknown as typeof baseSections);
  });
});

describe('G-644 every section reads from the projection’s href', () => {
  beforeEach(seedServedTypes);

  test('following an href reaches exactly that path, with the section’s own query', async () => {
    const { calls, main } = recorder();
    await followHref(main, `/v1/resources/${id}/statements`, { actingSubject: iri(id), cursor: 'c' })();
    await followHref(main, `/v1/recipes/works/${id}`)();
    expect(calls).toEqual([
      { path: ['v1', 'resources', id, 'statements'], options: { query: { actingSubject: iri(id), cursor: 'c' } } },
      { path: ['v1', 'recipes', 'works', id], options: { query: {} } },
    ]);
  });

  test('a link that is not a Main path is refused rather than followed', () => {
    const { main } = recorder();
    expect(() => followHref(main, 'https://example.com/v1/x')).toThrow();
    expect(() => followHref(main, '/other/x')).toThrow();
  });

  test('every section of every base is reachable through its own href', async () => {
    for (const base of Object.keys(baseSections) as TargetBase[]) {
      const types = base === 'work' ? ['https://schema.org/Recipe'] : base === 'resource'
        ? ['https://rezics.com/vocab/Character'] : ['https://rezics.com/vocab/Release'];
      const page = projectionFor({ id, base, types, name: 'x' });
      for (const section of page.sections) {
        const { calls, main } = recorder();
        await followHref(main, section.href)();
        expect(`/${calls[0]!.path.join('/')}`, `${base} ${section.id}`).toBe(section.href);
      }
    }
  });
});

describe('G-644 class guard: no type draws a book’s controls or another base’s sections', () => {
  beforeEach(seedServedTypes);

  test('across the registry, only the book presentation gets book controls', () => {
    for (const entry of servedTypes.types.filter(candidate => candidate.base === 'work')) {
      const page = projectionFor({ base: 'work', types: [entry.type], name: 'x' });
      expect(showsBookControls(workExperience(page, [entry.type])), entry.type).toBe(entry.presentation === 'book');
    }
    // Unregistered and absent types fall to the default, which is not a book.
    for (const types of [[], ['https://example.com/Hologram']]) {
      expect(showsBookControls(workExperience(null, types)), types.join()).toBe(false);
    }
  });

  test('the generic page draws only sections its base binds, never a book’s contents or releases', () => {
    for (const base of Object.keys(baseSections) as TargetBase[]) {
      for (const entry of servedTypes.types) {
        const page = projectionFor({ base, types: [entry.type], name: 'x'.repeat(3) });
        const drawn = page.sections.filter(section => drawnSections.includes(section.id)).map(section => section.id);
        expect(drawn.every(section => baseSections[base].includes(section)), `${base} ${entry.type}`).toBe(true);
        expect(drawn).not.toContain('contents');
        expect(drawn).not.toContain('releases');
        expect(drawn).not.toContain('credits');
      }
    }
  });

  test('only a Work is offered a type section, and only from a presentation that has one', () => {
    for (const base of ['release', 'occurrence', 'realization', 'resource'] as const) {
      const page = projectionFor({ base, types: ['https://schema.org/Recipe'], name: 'x' });
      expect(page.sections.map(section => section.id)).not.toContain('recipe');
    }
    expect(projectionFor({ base: 'work', types: ['https://schema.org/Book'], name: 'x' }).sections
      .map(section => section.id)).not.toContain('recipe');
  });
});

describe('G-644 the discussion composer takes any target', () => {
  test('a target’s own revision roots the post, with no Main Version lookup', async () => {
    const calls: string[] = [];
    const revision = iri('c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c');
    const reply = (name: string, data: object) => { calls.push(name); return Promise.resolve({ data, error: null }); };
    const main = {
      v1: {
        'main-versions': () => { throw new Error('no Main Version for a release'); },
        'member-reply-drafts': { post: (body: { rootTarget: string; rootRevision: string }) => {
          expect(body.rootTarget).toBe(iri(id));
          expect(body.rootRevision).toBe(revision);
          return reply('draft', { revisionId: 'rev-1' });
        } },
        'realm-replies': { post: (body: { rootTarget: string; rootRevision: string }) => {
          expect([body.rootTarget, body.rootRevision]).toEqual([iri(id), revision]);
          return reply('identity', {});
        } },
        'member-replies': () => ({ get: () => reply('digest', { revisionDigest: 'digest-1' }) }),
        'realm-reply-placements': { post: () => reply('place', { reply: iri('d0e1f2a3-b4c5-4d6e-8f7a-000000000001') }) },
      },
    };
    const outcome = await submitPost({ realm: iri('7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a'), work: iri(id),
      mainVersion: null, revision, title: 'Who is this?', body: 'A question about the release.', spoiler: false,
      language: 'en', actingSubject: iri('a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a') }, newPostProgress(), () => undefined,
    main as never);
    expect(outcome.kind).toBe('posted');
    expect(calls).toEqual(['draft', 'identity', 'digest', 'place']);
  });

  test('a post with neither a revision nor a Main Version fails instead of guessing a root', async () => {
    const outcome = await submitPost({ realm: iri('7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a'), work: iri(id),
      mainVersion: null, title: 't', body: '', spoiler: false, language: 'en',
      actingSubject: iri('a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a') }, newPostProgress(), () => undefined, {} as never);
    expect(outcome.kind).toBe('failed');
  });
});
