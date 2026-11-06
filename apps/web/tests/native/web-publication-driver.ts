import { seedPublicationSubjects } from './web-publication-subjects';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { readFile } from 'node:fs/promises';
import { startNativeWebStack } from './stack';
import { currentNativeLifecycle, NativeTestLifecycle, nativeProcessIsSame, inspectNativeProcess } from './lifecycle.ts';
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

type ProcessInfo = {
  pid: number;
  command: string;
  environment: string[];
  identity: NonNullable<ReturnType<typeof inspectNativeProcess>>;
};

async function processInfo(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const [command, environment] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readFile(`/proc/${pid}/environ`, 'utf8'),
    ]);
    const identity = inspectNativeProcess(pid);
    return identity
      ? { pid, command: command.replaceAll('\0', ' '), environment: environment.split('\0'), identity }
      : undefined;
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

async function ownedStackHost(exclude: ReadonlySet<number>): Promise<ProcessInfo> {
  for (const pid of await childPids(process.pid)) {
    if (exclude.has(pid)) continue;
    const info = await processInfo(pid);
    if (info?.command.includes('tests/native/stack.ts') && info.environment.includes('NATIVE_WEB_STACK_HOST=1'))
      return info;
  }
  throw new Error("Could not find this publication driver's native stack host process");
}

async function durableWorker(hostPid: number): Promise<ProcessInfo> {
  for (const pid of await childPids(hostPid)) {
    const info = await processInfo(pid);
    if (
      info?.command.includes('src/worker.ts') &&
      info.environment.some((entry) => /^KERNEL_EXECUTOR_ID=native-web-/.test(entry))
    )
      return info;
  }
  throw new Error("Could not find this publication driver's durable-work worker process");
}

async function waitForProcessState(
  identity: NonNullable<ReturnType<typeof inspectNativeProcess>>,
  stopped: boolean,
): Promise<void> {
  const { pid } = identity;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!nativeProcessIsSame(identity)) {
      if (stopped) throw new Error(`Owned process ${pid} exited before interruption took effect`);
      return;
    }
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
    'schema:author',
    'schema:keywords',
    'schema:suitableForDiet',
    'schema:cookTime',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
  ]) {
    if (!properties[property]) throw new Error(`Missing released definition for fixture fact ${property}`);
  }
}

export async function createWebPublicationDriver(startupTimeoutMs = 180_000): Promise<WebPublicationDriver> {
  const factoryStarted = performance.now();
  const existingChildren = new Set(await childPids(process.pid));
  const lifecycle = new NativeTestLifecycle('native web publication driver', currentNativeLifecycle());
  const stack = await lifecycle.run(
    'start native web publication driver',
    startupTimeoutMs,
    () => startNativeWebStack(),
    false,
  );
  let host: ProcessInfo;
  try {
    host = await ownedStackHost(existingChildren);
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
  let publicOrigin = defaultPublicOrigin;
  let closed: Promise<void> | undefined;
  const interruptionRestores = new Set<() => Promise<void>>();
  const directCredentials = new Map<Persona, Awaited<ReturnType<typeof stack.credentials>>>();
  let ownerReadInterrupted = false;
  let competingDate: (() => Promise<void>) | undefined;
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

    const seeded = await seedPublicationSubjects(kernel, stack.credentials, data);
    const { created } = seeded;
    competingDate = seeded.proposeCompetingDate;

    const urlFor = (key: string, locale = 'en') => {
      const subject = created.get(key);
      if (!subject) throw new Error(`Fixture subject ${key} was not created`);
      return new URL(subjectPath(subject.id, subject.labels[locale] ?? subject.label, locale), publicOrigin).href;
    };
    const subjects = Object.fromEntries(
      [...created.keys()].map((key) => [key, urlFor(key)]),
    ) as PublicationFixture['subjects'];
    const views = Object.fromEntries(
      (['editions', 'contents', 'cast', 'crew', 'inverse', 'relations'] as const).map((name) => {
        const source =
          name === 'inverse'
            ? 'person'
            : name === 'cast' || name === 'crew' || name === 'relations'
              ? `${name}-work`
              : 'book';
        const subject = created.get(source)!;
        const view = name === 'inverse' ? 'works' : name === 'cast' ? 'characters' : name === 'crew' ? 'credits' : name;
        return [name, new URL(`${subjectPath(subject.id, subject.label)}/${view}`, publicOrigin).href];
      }),
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
      qualifiedCredit: subjects.game,
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
      preparingView: views.inverse,
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
      if (!competingDate) throw new Error('proposeCompetingDate requires a provisioned fixture');
      await competingDate();
    },
    async revokeAlice() {
      throw new Error('revokeAlice is delivered by a later task');
    },
    async configurePublicOrigin(origin) {
      await stack.restartWeb({ publicOrigin: origin });
      publicOrigin = origin;
    },
    async interrupt(kind) {
      const target = kind === 'subject-view' ? await durableWorker(host.pid) : host;
      if (kind === 'owner-read') {
        // Cache fixture bearer credentials before stopping the stack host. The
        // served page request remains ordinary HTTP through the production web Worker.
        for (const persona of ['alice', 'bob', 'editor', 'verified-agent', 'suspended'] as const)
          directCredentials.set(persona, { authorization: (await stack.authPersona(persona)).authorization });
      }
      try {
        if (!nativeProcessIsSame(target.identity))
          throw new Error(`Owned ${kind} process ${target.pid} changed identity before interruption`);
        process.kill(target.pid, 'SIGSTOP');
      } catch (error) {
        throw new Error(`Could not stop owned ${kind} process ${target.pid}: ${String(error)}`, { cause: error });
      }
      await waitForProcessState(target.identity, true);
      if (kind === 'owner-read') ownerReadInterrupted = true;

      let restored = false;
      const restore = async () => {
        if (restored) return;
        restored = true;
        interruptionRestores.delete(restore);
        if (kind === 'owner-read') ownerReadInterrupted = false;
        try {
          if (nativeProcessIsSame(target.identity)) process.kill(target.pid, 'SIGCONT');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForProcessState(target.identity, false);
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
        await lifecycle.close();
      })());
    },
  };
}
