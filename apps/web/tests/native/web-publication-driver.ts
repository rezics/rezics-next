import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { startNativeWebStack } from './stack';
import type { WebPublicationDriver, PublicationFixture, SitemapKind } from '../../../../specs/web-publication-driver';

const defaultPublicOrigin = 'https://rezics.example.test';
const typeByKey: Record<string, string> = {
  book: 'schema:Book',
  recipe: 'schema:Recipe',
  game: 'schema:VideoGame',
  release: 'schema:CreativeWork',
  person: 'schema:Person',
  organization: 'schema:Organization',
  automated: 'schema:SoftwareApplication',
};
const titleOf = (value: unknown): string => {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string')
    return String(value);
  return value.title;
};
const subjectPath = (id: string, label: string, locale = 'en') =>
  `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}/${slug(label)}`;

function assertReleasedDefinitions(): void {
  const types = bundledRelease.types as Record<string, unknown>;
  const properties = bundledRelease.properties as Record<string, unknown>;
  for (const [key, type] of Object.entries(typeByKey)) {
    if (!types[type]) throw new Error(`Missing released definition for fixture subject ${key}: ${type}`);
  }
  for (const property of [
    'schema:wordCount',
    'wdt:P7937',
    'schema:keywords',
    'schema:suitableForDiet',
    'schema:cookTime',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
  ]) {
    if (!properties[property]) throw new Error(`Missing released definition for fixture fact ${property}`);
  }
}

export async function createWebPublicationDriver(): Promise<WebPublicationDriver> {
  const stack = await startNativeWebStack();
  let publicOrigin = defaultPublicOrigin;
  let closed: Promise<void> | undefined;
  const request: WebPublicationDriver['request'] = (url, persona, headers) => stack.request(url, persona, headers);
  const provision = async (data: typeof import('../../../../specs/fixtures/web-publication.json')) => {
    assertReleasedDefinitions();
    const active = await stack.kernel('/v1/definitions/active');
    if (!active.ok) throw new Error(`Could not read released definition: ${active.status} ${await active.text()}`);
    const activeBody = (await active.json()) as { digest: string };
    if (activeBody.digest !== bundledDigest)
      throw new Error(`Native stack released definition mismatch: expected ${bundledDigest}, received ${activeBody.digest}`);

    const created = new Map<string, { id: string; label: string; type: string }>();
    const entries = Object.entries(data.subjects).map(([key, value]) => ({
      key,
      type: typeByKey[key] ?? 'schema:Book',
      label: titleOf(value),
      descriptions: 'description' in value ? { en: String(value.description) } : undefined,
    }));
    for (const [view, count] of Object.entries({ editions: 105, contents: 105, cast: 105, crew: 105, inverse: 105, relations: 105 })) {
      for (let index = 1; index <= count; index++) {
        const key = `${view}-${String(index).padStart(3, '0')}`;
        entries.push({ key, type: 'schema:Book', label: `${view} ${index}`, descriptions: undefined });
      }
      entries.push({ key: `${view}-withheld`, type: 'schema:Book', label: `${view} withheld`, descriptions: undefined });
    }
    for (let start = 0; start < entries.length; start += 100) {
      const batch = entries.slice(start, start + 100);
      const commands = batch.map(({ key, type, label, descriptions }) => ({
        op: 'create',
        key,
        source: {
          source: 'web-publication-fixture',
          external_id: key,
          record_revision: '1',
          digest: '0'.repeat(64),
          converter_revision: 'web-publication-fixture@1',
          field_group: 'facts',
        },
        subject: { type, labels: { en: label }, ...(descriptions ? { descriptions } : {}) },
      }));
      const response = await stack.kernel(
        '/v1/subjects:batchWrite',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commands }) },
        'editor',
      );
      if (!response.ok)
        throw new Error(`Could not batch-create fixture subjects through kernel API: ${response.status} ${await response.text()}`);
      const result = (await response.json()) as { results: { key: string; status: number; value?: { id: string } }[] };
      for (const item of result.results) {
        const entry = batch.find(({ key }) => key === item.key)!;
        if (item.status !== 201 || !item.value?.id)
          throw new Error(`Could not create fixture subject ${item.key}: API status ${item.status}`);
        created.set(item.key, { id: item.value.id, label: entry.label, type: entry.type });
      }
    }

    const urlFor = (key: string, locale = 'en') => {
      const subject = created.get(key);
      if (!subject) throw new Error(`Fixture subject ${key} was not created`);
      return new URL(subjectPath(subject.id, subject.label, locale), publicOrigin).href;
    };
    const subjects = Object.fromEntries([...created.keys()].map((key) => [key, urlFor(key)])) as PublicationFixture['subjects'];
    const views = Object.fromEntries(
      (['editions', 'contents', 'cast', 'crew', 'inverse', 'relations'] as const).map((name) => [
        name,
        new URL(`${subjectPath(created.get('book')!.id, created.get('book')!.label)}/${name}`, publicOrigin).href,
      ]),
    ) as PublicationFixture['views'];
    const sitemap = Object.fromEntries(
      (['subject', 'collection', 'realm', 'space', 'board', 'thread'] as const).map((kind) => [kind, { eligible: [], excluded: [] }]),
    ) as PublicationFixture['sitemap'];
    const fixture: PublicationFixture = {
      releaseDigest: activeBody.digest,
      publicOrigin,
      subjects,
      views,
      details: new URL(`${new URL(subjects.book).pathname}/details`, publicOrigin).href,
      qualifiedCredit: views.cast,
      staleBookZhHans: urlFor('book', 'zh-Hans').replace(/\/[^/]+$/, '/former-lantern-title'),
      canonicalBookZhHans: urlFor('book', 'zh-Hans'),
      verifiedSubject: subjects.person,
      verifiedProfile: new URL('/en/@lantern-verified', publicOrigin).href,
      publicPage: subjects.book,
      personalRead: new URL('/v1/subjects/00000000-0000-4000-8000-000000000000', stack.kernelOrigin).href,
      bannedRead: new URL('/v1/subjects/00000000-0000-4000-8000-000000000000', stack.kernelOrigin).href,
      privateCollection: new URL('/en/collections/00000000-0000-4000-8000-000000000000', publicOrigin).href,
      unknownCollection: new URL('/en/collections/00000000-0000-4000-8000-000000000001', publicOrigin).href,
      emptyPublicList: new URL('/en/subjects', publicOrigin).href,
      preparingView: views.relations,
      unavailableView: views.inverse,
      searchZhHans: new URL('/zh-Hans/search?q=%E7%81%AF%E7%AC%BC%E6%A1%A3%E6%A1%88', publicOrigin).href,
      sitemap,
    };
    return fixture;
  };

  const settle = async () => {
    // Feed reads are native API requests. An empty page is not exhaustion when it
    // carries a continuation; always follow the opaque cursor until next is null.
    const feeds: SitemapKind[] = ['collection', 'realm', 'space', 'board', 'thread'];
    const routes: Record<string, string> = {
      collection: 'collections',
      realm: 'realms',
      space: 'spaces',
      board: 'boards',
      thread: 'threads',
    };
    for (const feed of feeds) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ limit: '2' });
        if (cursor) query.set('cursor', cursor);
        const response = await stack.kernel(`/v1/sitemap/${routes[feed]}?${query}`);
        if (!response.ok) throw new Error(`Native sitemap feed ${feed} returned ${response.status}: ${await response.text()}`);
        const page = (await response.json()) as { next: string | null };
        cursor = page.next;
        if (++pages > 10_000) throw new Error(`Native sitemap feed ${feed} did not terminate`);
      } while (cursor !== null);
    }
    await Bun.sleep(50);
  };

  return {
    provision,
    request,
    settle,
    async proposeCompetingDate() { throw new Error('proposeCompetingDate is delivered by a later task'); },
    async revokeAlice() { throw new Error('revokeAlice is delivered by a later task'); },
    async configurePublicOrigin(origin) {
      await stack.restartWeb({ publicOrigin: origin });
      publicOrigin = origin;
    },
    async interrupt(kind) { throw new Error(`interrupt is delivered by a later task: ${kind}`); },
    async nativeSearch() { throw new Error('nativeSearch is delivered by a later task'); },
    close() {
      return (closed ??= stack.stop());
    },
  };
}
