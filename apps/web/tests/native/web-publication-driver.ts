import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { readFile } from 'node:fs/promises';
import { startNativeWebStack } from './stack';
import type { WebPublicationDriver, PublicationFixture, Persona } from '../../../../specs/web-publication-driver';

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
function responseProblem(body: string): { code?: string } | null {
  try {
    return JSON.parse(body) as { code?: string } | null;
  } catch {
    return null;
  }
}

const globalContext = '00000000-0000-8000-8000-000000000000';
// Every command performs source-fence and authorization work under the same
// two-second request deadline. Give each creation its own native request budget.
const fixtureBatchSize = 1;

type ProcessInfo = { pid: number; command: string; environment: string[] };

async function processInfo(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const [command, environment] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readFile(`/proc/${pid}/environ`, 'utf8'),
    ]);
    return { pid, command: command.replaceAll('\0', ' '), environment: environment.split('\0') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
      return undefined;
    throw error;
  }
}

async function childPids(pid: number): Promise<number[]> {
  try {
    const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return children.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
      return [];
    throw error;
  }
}

async function ownedStackHost(): Promise<ProcessInfo> {
  for (const pid of await childPids(process.pid)) {
    const info = await processInfo(pid);
    if (
      info?.command.includes('tests/native/stack.ts') &&
      info.environment.includes('NATIVE_WEB_STACK_HOST=1')
    ) return info;
  }
  throw new Error('Could not find this publication driver\'s native stack host process');
}

async function durableWorker(hostPid: number): Promise<ProcessInfo> {
  for (const pid of await childPids(hostPid)) {
    const info = await processInfo(pid);
    if (
      info?.command.includes('services/kernel/src/worker.ts') &&
      info.environment.some((entry) => /^KERNEL_EXECUTOR_ID=native-web-/.test(entry))
    ) return info;
  }
  throw new Error('Could not find this publication driver\'s durable-work worker process');
}

async function waitForProcessState(pid: number, stopped: boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
        return '';
      throw error;
    });
    if (!status) {
      if (stopped) throw new Error(`Owned process ${pid} exited before interruption took effect`);
      return;
    }
    const state = /^State:\s+(\S+)/m.exec(status)?.[1];
    if ((state === 'T' || state === 't') === stopped) return;
    await Bun.sleep(10);
  }
  throw new Error(`Owned process ${pid} did not ${stopped ? 'stop' : 'resume'} in time`);
}

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
  const interruptionRestores = new Set<() => Promise<void>>();
  const directCredentials = new Map<Persona, Awaited<ReturnType<typeof stack.credentials>>>();
  let ownerReadInterrupted = false;
  let provisioned:
    | { data: typeof import('../../../../specs/fixtures/web-publication.json'); fixture: PublicationFixture }
    | undefined;
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
      const problem = (await response
        .clone()
        .json()
        .catch(() => null)) as { retryable?: unknown; request_id?: unknown } | null;
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
    let response: Response;
    if (ownerReadInterrupted) {
      const requested = new URL(url, publicOrigin);
      const target = new URL(stack.web);
      target.pathname = requested.pathname;
      target.search = requested.search;
      const supplied = new Headers(headers);
      if (persona && persona !== 'anonymous') {
        let credentials = directCredentials.get(persona);
        if (!credentials) {
          credentials = await stack.credentials(persona);
          directCredentials.set(persona, credentials);
        }
        supplied.set('authorization', credentials.authorization);
        if (credentials.cookie)
          supplied.set('cookie', [supplied.get('cookie'), credentials.cookie].filter(Boolean).join('; '));
      }
      // The stack host is intentionally paused during owner-read. Send this real
      // HTTP request to the same production Worker without asking that paused host
      // to acknowledge its diagnostic observation before returning the Response.
      response = await fetch(target, { headers: supplied, redirect: 'manual' });
    } else {
      response = await stack.request(url, persona, headers);
    }
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

    const created = new Map<string, { id: string; label: string; labels: Record<string, string>; type: string }>();
    const entries = Object.entries(data.subjects).map(([key, value]) => ({
      key,
      type: typeByKey[key]!,
      label: titleOf(value),
      labels: { en: titleOf(value), ...('zhHansTitle' in value ? { 'zh-Hans': value.zhHansTitle } : {}) } as Record<
        string,
        string
      >,
      descriptions: 'description' in value ? { en: String(value.description) } : undefined,
    }));
    for (const view of data.traversal.views) {
      const count = data.traversal.countPerView;
      for (let index = 1; index <= count; index++) {
        const key = `${view}-${String(index).padStart(3, '0')}`;
        entries.push({
          key,
          type: 'schema:Book',
          label: `${view} ${index}`,
          labels: { en: `${view} ${index}` },
          descriptions: undefined,
        });
      }
      entries.push({
        key: `${view}-withheld`,
        type: 'schema:Book',
        label: `${view} withheld`,
        labels: { en: `${view} withheld` },
        descriptions: undefined,
      });
    }
    for (const [index, title] of [...data.search.matchingBooks].reverse().entries()) {
      entries.push({
        key: `search-book-${index + 1}`,
        type: 'schema:Book',
        label: title,
        labels: { en: title, [data.search.locale]: title },
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
          const commands = batch.map(({ key, type, labels, descriptions }) => ({
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
            subject: { type, labels, ...(descriptions ? { descriptions } : {}) },
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
            created.set(item.key, { id: item.value.id, label: entry.label, labels: entry.labels, type: entry.type });
          }
        }
      }),
    );

    const urlFor = (key: string, locale = 'en') => {
      const subject = created.get(key);
      if (!subject) throw new Error(`Fixture subject ${key} was not created`);
      return new URL(subjectPath(subject.id, subject.labels[locale] ?? subject.label, locale), publicOrigin).href;
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
    provisioned = { data: structuredClone(data), fixture };
    console.info(
      `web-publication-driver-growth: setup=${Math.round(performance.now() - factoryStarted)}ms provision=${Math.round(performance.now() - started)}ms peak-memory=${stack.peakMemoryBytes()}bytes fixture-subjects=${created.size}`,
    );
    return fixture;
  };

  const settle = async () => {
    if (!provisioned) throw new Error('settle requires a provisioned publication fixture');
    const { data, fixture } = provisioned;
    const routes = [
      ['collection', '/v1/sitemap/collections'],
      ['realm', '/v1/sitemap/realms'],
      ['space', '/v1/sitemap/spaces'],
      ['board', '/v1/sitemap/boards'],
      ['thread', '/v1/sitemap/threads'],
      ['subject', '/v1/subject-pages'],
    ] as const;
    const pending = new Map<string, Set<string>>(
      routes.map(([kind, route]) => [
        route,
        new Set(
          fixture.sitemap[kind].eligible.map(({ url }) => {
            const id = new URL(url).pathname.split('/')[3];
            if (!id) throw new Error(`Fixture sitemap URL lacks its created identity: ${url}`);
            return decodeURIComponent(id);
          }),
        ),
      ]),
    );
    const expected = new Map([...pending].map(([route, ids]) => [route, new Set(ids)]));
    let missingTitles = [...data.search.matchingBooks];
    let searchPending = true;
    const deadline = performance.now() + 180_000;
    let round = 0;
    const unmet = () => [
      ...[...pending].map(([route, ids]) => `${route} missing IDs=${JSON.stringify([...ids])}`),
      ...(searchPending ? [`/v1/subjects:search missing titles=${JSON.stringify(missingTitles)}`] : []),
    ];
    while (true) {
      try {
        for (const [kind, route] of routes) {
          if (!pending.has(route)) continue;
          const missing = new Set(expected.get(route)!);
          pending.set(route, missing);
          let cursor: string | null = null;
          let pages = 0;
          let emptyPages = 0;
          let unavailable = false;
          const measurements = { times: [] as number[], retries: 0 };
          feedMeasurements.set(route, measurements);
          try {
            do {
              if (performance.now() >= deadline) break;
              const query = new URLSearchParams({ limit: '100' });
              if (cursor !== null) query.set('cursor', cursor);
              const response = await kernel(`${route}?${query}`);
              if (!response.ok) {
                const body = await response.text();
                const problem = responseProblem(body);
                if (response.status === 503 && problem?.code === 'semantic_not_ready') {
                  console.info(`web-publication-driver-feed: route=${route} unavailable=semantic_not_ready`);
                  unavailable = true;
                  break;
                }
                throw new Error(`Native sitemap feed ${route} returned ${response.status}: ${body}`);
              }
              const page = (await response.json()) as {
                items?: { id: string }[];
                subjectPages?: { id: string }[];
                next: unknown;
              };
              const items = kind === 'subject' ? page.subjectPages : page.items;
              if (!Array.isArray(items) || (page.next !== null && typeof page.next !== 'string'))
                throw new Error(`Native sitemap feed ${route} omitted its items or continuation`);
              for (const { id } of items) missing.delete(id);
              pages++;
              if (items.length === 0) emptyPages++;
              cursor = page.next;
              // Empty candidate pages carry progress too. Exhaust the native cursor
              // even when all fixture IDs appeared before the end of the feed.
            } while (cursor !== null);
          } finally {
            feedMeasurements.delete(route);
            const times = measurements.times.sort((a, b) => a - b);
            const middle = Math.floor(times.length / 2);
            const median =
              times.length === 0 ? 0 : times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
            console.info(
              `web-publication-driver-feed: route=${route} requests=${times.length} pages=${pages} empty-pages=${emptyPages} retries=${measurements.retries} median=${Math.round(median)}ms slowest=${Math.round(times.at(-1) ?? 0)}ms`,
            );
          }
          if (unavailable || (pages > 0 && cursor === null && missing.size === 0)) pending.delete(route);
        }
        if (searchPending && performance.now() < deadline) {
          const response = await kernel('/v1/subjects:search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: data.search.query, languages: [data.search.locale], limit: 100 }),
          });
          if (!response.ok) {
            const body = await response.text();
            if (response.status === 503 && responseProblem(body)?.code === 'index_not_ready') {
              console.info('web-publication-driver-search: unavailable=index_not_ready');
              searchPending = false;
            } else {
              throw new Error(`Native search returned ${response.status}: ${body}`);
            }
          } else {
            const result = (await response.json()) as { subjects: { type: string; labels: Record<string, string> }[] };
            const titles = new Set(
              result.subjects
                .filter(({ type }) => type === 'schema:Book')
                .map(({ labels }) => labels[data.search.locale]),
            );
            missingTitles = data.search.matchingBooks.filter((title) => !titles.has(title));
            searchPending = missingTitles.length !== 0;
          }
        }
      } finally {
        console.info(`web-publication-driver-settle: round=${++round} unmet=${JSON.stringify(unmet())}`);
      }
      if (pending.size === 0 && !searchPending) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error(`Publication fixture did not settle within 180 seconds: ${unmet().join('; ')}`);
      await Bun.sleep(Math.min(1000 * 2 ** Math.min(round - 1, 3), remaining));
    }
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
      const host = await ownedStackHost();
      const target = kind === 'subject-view' ? await durableWorker(host.pid) : host;
      if (kind === 'owner-read') {
        // Cache fixture credentials before stopping the stack host. The served
        // page request remains ordinary HTTP through the production web Worker.
        for (const persona of ['alice', 'bob', 'editor', 'suspended'] as const)
          directCredentials.set(persona, await stack.credentials(persona));
      }
      try {
        process.kill(target.pid, 'SIGSTOP');
      } catch (error) {
        throw new Error(`Could not stop owned ${kind} process ${target.pid}: ${String(error)}`, { cause: error });
      }
      await waitForProcessState(target.pid, true);
      if (kind === 'owner-read') ownerReadInterrupted = true;

      let restored = false;
      const restore = async () => {
        if (restored) return;
        restored = true;
        interruptionRestores.delete(restore);
        if (kind === 'owner-read') ownerReadInterrupted = false;
        try {
          process.kill(target.pid, 'SIGCONT');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForProcessState(target.pid, false);
      };
      interruptionRestores.add(restore);
      return restore;
    },
    async nativeSearch() {
      throw new Error('nativeSearch is delivered by a later task');
    },
    close() {
      return (closed ??= (async () => {
        for (const restore of [...interruptionRestores]) await restore();
        await stack.stop();
      })());
    },
  };
}
