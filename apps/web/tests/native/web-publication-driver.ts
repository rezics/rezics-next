import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { startNativeWebStack } from './stack';
import type { WebPublicationDriver, PublicationFixture } from '../../../../specs/web-publication-driver';

const defaultPublicOrigin = 'https://rezics.example.test';
const typeByKey: Record<string, string> = {
  book: 'schema:Book',
  recipe: 'schema:Recipe',
  game: 'schema:VideoGame',
  release: 'wd:Q20631656',
  person: 'schema:Person',
  organization: 'schema:Organization',
  automated: 'schema:SoftwareApplication',
};
const fixtureTypeByKey: Record<string, string> = {
  book: 'Book',
  recipe: 'Recipe',
  game: 'VideoGame',
  release: 'released game release profile',
  person: 'Person',
  organization: 'Organization',
  automated: 'released automated agent profile',
};
const titleOf = (value: unknown): string => {
  if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string')
    return String(value);
  return value.title;
};
const subjectPath = (id: string, label: string, locale = 'en') =>
  `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}/${slug(label)}`;
const globalContext = '00000000-0000-8000-8000-000000000000';
// Every command performs source-fence and authorization work under the same
// two-second request deadline. Give each creation its own native request budget.
const fixtureBatchSize = 1;

function accountIdFromAuthorization(authorization: string): string {
  const token = authorization.match(/^Bearer ([^.]+)\.([^.]+)\./)?.[2];
  if (!token) throw new Error('Native fixture account did not receive a bearer token');
  const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { sub?: unknown };
  if (typeof claims.sub !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.sub))
    throw new Error('Native fixture bearer did not identify its account');
  return claims.sub;
}

function assertReleasedDefinitions(data: typeof import('../../../../specs/fixtures/web-publication.json')): void {
  const types = bundledRelease.types as Record<string, unknown>;
  const properties = bundledRelease.properties as Record<string, unknown>;
  for (const [key, type] of Object.entries(typeByKey)) {
    if (!types[type]) throw new Error(`Missing released definition for fixture subject ${key}: ${type}`);
  }
  for (const [key, subject] of Object.entries(data.subjects)) {
    const type = typeByKey[key];
    if (!type || fixtureTypeByKey[key] !== subject.type)
      throw new Error(`Missing released definition for fixture subject ${key}: ${subject.type}`);
    const definition = bundledRelease.types[type];
    if (definition?.schemaOrgType !== `https://schema.org/${subject.schemaOrgType}`)
      throw new Error(`Missing released Schema.org definition for fixture subject ${key}: ${subject.schemaOrgType}`);
  }
  for (const property of [
    data.definitions.wordCount,
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
  const factoryStarted = performance.now();
  const stack = await startNativeWebStack();
  let publicOrigin = defaultPublicOrigin;
  let closed: Promise<void> | undefined;
  const feedMeasurements = new Map<string, { times: number[]; retries: number }>();
  // Only native setup/control requests retry. Served documents must retain their
  // original HTTP response, including retryable failures and manual redirects.
  const kernel: typeof stack.kernel = async (path, init, persona) => {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const response = await stack.kernel(path, init, persona);
      const measurements = feedMeasurements.get(new URL(path, stack.kernelOrigin).pathname);
      measurements?.times.push(performance.now() - started);
      if (response.ok) return response;
      const problem = (await response.clone().json().catch(() => null)) as
        | { retryable?: unknown; request_id?: unknown }
        | null;
      if (problem?.retryable !== true || attempt === 3) return response;
      if (measurements) measurements.retries++;
      console.info(
        `web-publication-driver-retry: route=${path} status=${response.status} request_id=${String(problem.request_id)} retry=${attempt + 1}`,
      );
      await response.body?.cancel();
      await Bun.sleep(1000 * 2 ** attempt);
    }
  };
  const request: WebPublicationDriver['request'] = async (url, persona, headers) => {
    const before = stack.kernelRequests().length;
    const response = await stack.request(url, persona, headers);
    console.info(
      `web-publication-driver-document: path=${new URL(url, publicOrigin).pathname} kernel-requests=${stack.kernelRequests().length - before}`,
    );
    return response;
  };
  const provision = async (data: typeof import('../../../../specs/fixtures/web-publication.json')) => {
    const started = performance.now();
    assertReleasedDefinitions(data);
    const active = await kernel('/v1/definitions/active');
    if (!active.ok) throw new Error(`Could not read released definition: ${active.status} ${await active.text()}`);
    const activeBody = (await active.json()) as { digest: string };
    if (activeBody.digest !== bundledDigest)
      throw new Error(
        `Native stack released definition mismatch: expected ${bundledDigest}, received ${activeBody.digest}`,
      );

    const created = new Map<string, { id: string; label: string; type: string }>();
    const entries = Object.entries(data.subjects).map(([key, value]) => ({
      key,
      type: typeByKey[key]!,
      label: titleOf(value),
      descriptions: 'description' in value ? { en: String(value.description) } : undefined,
    }));
    for (const view of data.traversal.views) {
      const count = data.traversal.countPerView;
      for (let index = 1; index <= count; index++) {
        const key = `${view}-${String(index).padStart(3, '0')}`;
        entries.push({ key, type: 'schema:Book', label: `${view} ${index}`, descriptions: undefined });
      }
      entries.push({
        key: `${view}-withheld`,
        type: 'schema:Book',
        label: `${view} withheld`,
        descriptions: undefined,
      });
    }
    const writerCount = Math.ceil(entries.length / 220);
    const writers = await Promise.all(
      Array.from({ length: writerCount }, async (_, index) => {
        const persona = `web-fixture-writer-${index + 1}`;
        const credentials = await stack.credentials(persona);
        const accountId = accountIdFromAuthorization(credentials.authorization);
        const grantKey = crypto.randomUUID();
        const grant = await kernel(
          '/v1/grants',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(grantKey) },
            body: JSON.stringify({
              resource: { route: 0, id: globalContext },
              subject: { kind: 'account', id: accountId },
              actions: ['subject:batch_write', 'subject:create'],
              valid: '(,)',
            }),
          },
          'governor',
        );
        if (!grant.ok)
          throw new Error(`Could not grant native fixture writer ${persona}: ${grant.status} ${await grant.text()}`);
        const rateTierKey = crypto.randomUUID();
        const rateTier = await kernel(
          `/v1/accounts/${encodeURIComponent(accountId)}:setRateTier`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(rateTierKey) },
            body: JSON.stringify({ key: rateTierKey, tier: 'trusted' }),
          },
          'governor',
        );
        if (!rateTier.ok)
          throw new Error(
            `Could not set native fixture writer rate tier ${persona}: ${rateTier.status} ${await rateTier.text()}`,
          );
        return persona;
      }),
    );
    const batches = Array.from({ length: writerCount }, (_, index) => {
      const writerEntries = entries.slice(index * 220, index * 220 + 220);
      return { persona: writers[index]!, entries: writerEntries };
    });
    await Promise.all(
      batches.map(async ({ persona, entries: writerEntries }) => {
        for (let start = 0; start < writerEntries.length; start += fixtureBatchSize) {
          const batch = writerEntries.slice(start, start + fixtureBatchSize);
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
          let response: Response;
          response = await kernel(
            '/v1/subjects:batchWrite',
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commands }) },
            persona,
          );
          if (!response.ok)
            throw new Error(
              `Could not batch-create fixture subjects through kernel API: ${response.status} ${await response.text()}`,
            );
          const result = (await response.json()) as {
            results: { key: string; status: number; value?: { id: string }; problem?: unknown }[];
          };
          for (const item of result.results) {
            const entry = batch.find(({ key }) => key === item.key)!;
            if (item.status !== 201 || !item.value?.id)
              throw new Error(
                `Could not create fixture subject ${item.key}: API status ${item.status} ${JSON.stringify(item.problem)}`,
              );
            created.set(item.key, { id: item.value.id, label: entry.label, type: entry.type });
          }
        }
      }),
    );

    const urlFor = (key: string, locale = 'en') => {
      const subject = created.get(key);
      if (!subject) throw new Error(`Fixture subject ${key} was not created`);
      return new URL(subjectPath(subject.id, subject.label, locale), publicOrigin).href;
    };
    const subjects = Object.fromEntries(
      [...created.keys()].map((key) => [key, urlFor(key)]),
    ) as PublicationFixture['subjects'];
    const views = Object.fromEntries(
      (['editions', 'contents', 'cast', 'crew', 'inverse', 'relations'] as const).map((name) => [
        name,
        new URL(`${subjectPath(created.get('book')!.id, created.get('book')!.label)}/${name}`, publicOrigin).href,
      ]),
    ) as PublicationFixture['views'];
    const sitemap = Object.fromEntries(
      (['subject', 'collection', 'realm', 'space', 'board', 'thread'] as const).map((kind) => [
        kind,
        { eligible: [], excluded: [] },
      ]),
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
    console.info(
      `web-publication-driver-growth: setup=${Math.round(performance.now() - factoryStarted)}ms provision=${Math.round(performance.now() - started)}ms peak-memory=${stack.peakMemoryBytes()}bytes fixture-subjects=${created.size}`,
    );
    return fixture;
  };

  const settle = async () => {
    // Feed reads are native API requests. An empty page is not exhaustion when it
    // carries a continuation; always follow the opaque cursor until next is null.
    const routes = [
      '/v1/sitemap/collections',
      '/v1/sitemap/realms',
      '/v1/sitemap/spaces',
      '/v1/sitemap/boards',
      '/v1/sitemap/threads',
      '/v1/subject-pages',
    ];
    for (const route of routes) {
      let cursor: string | null = null;
      let pages = 0;
      const measurements = { times: [] as number[], retries: 0 };
      feedMeasurements.set(route, measurements);
      try {
        do {
          const query = new URLSearchParams({ limit: '100' });
          if (cursor !== null) query.set('cursor', cursor);
          const response = await kernel(`${route}?${query}`);
          if (!response.ok)
            throw new Error(`Native sitemap feed ${route} returned ${response.status}: ${await response.text()}`);
          const page = (await response.json()) as { next: unknown };
          if (page.next !== null && typeof page.next !== 'string')
            throw new Error(`Native sitemap feed ${route} omitted its continuation`);
          cursor = page.next;
          if (++pages > 10_000) throw new Error(`Native sitemap feed ${route} did not terminate`);
        } while (cursor !== null);
      } finally {
        feedMeasurements.delete(route);
        const times = measurements.times.sort((a, b) => a - b);
        const middle = Math.floor(times.length / 2);
        const median =
          times.length === 0 ? 0 : times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
        console.info(
          `web-publication-driver-feed: route=${route} requests=${times.length} pages=${pages} retries=${measurements.retries} median=${Math.round(median)}ms slowest=${Math.round(times.at(-1) ?? 0)}ms`,
        );
      }
    }
    // Exhausted discovery feeds do not establish asynchronous consumer progress.
    // Do not replace the missing native completion read with a timed sleep.
    throw new Error(
      'settle requires a native HTTP read reporting durable projections and the search index drained; the kernel exposes none',
    );
  };

  return {
    provision,
    request,
    settle,
    async proposeCompetingDate() {
      throw new Error('proposeCompetingDate is delivered by a later task');
    },
    async revokeAlice() {
      throw new Error('revokeAlice is delivered by a later task');
    },
    async configurePublicOrigin(origin) {
      await stack.restartWeb({ publicOrigin: origin });
      publicOrigin = origin;
    },
    async interrupt(kind) {
      throw new Error(`interrupt is delivered by a later task: ${kind}`);
    },
    async nativeSearch() {
      throw new Error('nativeSearch is delivered by a later task');
    },
    close() {
      return (closed ??= stack.stop());
    },
  };
}
