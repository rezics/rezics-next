import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import { buildSearchImage, cgroupArgs, waitForSearch } from '../../../../services/kernel/scripts/search.ts';
import { currentNativeLifecycle } from './lifecycle.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type BookCatalogueType = 'schema:Book' | 'schema:BookSeries' | 'bf:Instance';
export type BookCatalogueIdentity = {
  id: string;
  type: BookCatalogueType;
  label: string;
  text: string;
};

type NativeSearchRequest = Parameters<KernelClient['subjects']['$search']['post']>[0];
type NativeSearchPage = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>,
  { subjects: unknown }
>;
type NativeSearchSubject = NativeSearchPage['subjects'][number];
type NativeRelease = {
  release: {
    types: Record<string, { library?: { profileId?: string } }>;
    libraryProfiles: Record<
      string,
      {
        entryStateSet?: {
          states: { id: string; role: string; labels: Record<string, string> }[];
        };
      }
    >;
  };
};
type NativeSubjectCreate = Parameters<KernelClient['subjects']['post']>[0];
type NativeState = { id: string; label: string };
type LibraryEntryRead = { subjectId: string; state: string; revision: number };

export type BookCatalogueJourneyFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  marker: string;
  subjects: Record<'series' | 'book' | 'edition', BookCatalogueIdentity>;
  states: {
    bookPlanned: NativeState;
    bookCompleted: NativeState;
    editionPlanned: NativeState;
    seriesPlanned?: NativeState;
  };
  initialBookEntry: LibraryEntryRead;
  search: NativeSearchPage;
  searchContainer?: string;
};

const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args]);
  if (result.exitCode !== 0)
    throw new Error(`Native Book catalogue Search setup failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

async function prepareSearch(): Promise<{ container?: string }> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Book catalogue Search setup requires an active native test lifecycle');
  lifecycle.assertOpen('prepare Book catalogue Search');
  if (process.env.OPENSEARCH_URL) return {};

  const container = `native-book-catalogue-search-${randomUUID().slice(0, 12)}`;
  const priorUrl = process.env.OPENSEARCH_URL;
  let stopped = false;
  const restore = async () => {
    if (stopped) return;
    stopped = true;
    try {
      docker(['rm', '-fv', container]);
    } finally {
      if (priorUrl === undefined) delete process.env.OPENSEARCH_URL;
      else process.env.OPENSEARCH_URL = priorUrl;
    }
  };

  docker([
    'run',
    '-d',
    ...cgroupArgs(),
    '--name',
    container,
    '-p',
    '127.0.0.1::9200',
    '--tmpfs',
    '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
    '-e',
    'discovery.type=single-node',
    '-e',
    'DISABLE_SECURITY_PLUGIN=true',
    '-e',
    'DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e',
    'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
    buildSearchImage(),
  ]);
  lifecycle.register({ label: 'native Book catalogue Search container', close: restore, force: restore });
  try {
    const address = docker(['port', container, '9200/tcp']).split('\n')[0];
    if (!address) throw new Error('Native Book catalogue Search setup returned no published port');
    process.env.OPENSEARCH_URL = `http://${address}`;
    await waitForSearch(process.env.OPENSEARCH_URL, container);
    return { container };
  } catch (error) {
    await restore();
    throw error;
  }
}

const idempotencyKey = () => JSON.stringify(randomUUID());

async function responseJson<T>(response: Response, expected: number, operation: string): Promise<T> {
  const body = await response.text();
  if (response.status !== expected)
    throw new Error(`${operation} expected HTTP ${expected}, received HTTP ${response.status}: ${body}`);
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${body.slice(0, 400)}`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSearchPage(value: unknown): value is NativeSearchPage {
  return (
    isRecord(value) &&
    Array.isArray(value.subjects) &&
    value.subjects.every(
      (subject) =>
        isRecord(subject) &&
        typeof subject.id === 'string' &&
        typeof subject.type === 'string' &&
        isRecord(subject.labels) &&
        Object.values(subject.labels).every((label) => typeof label === 'string'),
    )
  );
}

function abstract(text: string, sourceUrl: string) {
  return {
    property: { id: 'schema:abstract' },
    value: {
      type: 'value',
      content: { document: fromPlainText(text), language: 'en', licence: 'CC-BY-4.0' },
    },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }],
      },
    ],
    qualifiers: [],
    rank: 'normal',
  };
}

function relation(property: string, target: string, sourceUrl: string) {
  return {
    property: { id: property },
    value: { type: 'value', content: target },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }],
      },
    ],
    qualifiers: [],
    rank: 'normal',
  };
}

async function createSubject(
  stack: NativeWebStack,
  marker: string,
  type: BookCatalogueType,
  label: string,
  text: string,
  relations: Record<string, unknown[]> = {},
): Promise<BookCatalogueIdentity> {
  const input = {
    type,
    labels: { en: label },
    statements: {
      'schema:abstract': [abstract(text, `https://example.org/native-book-catalogue/${marker}/${type}/text`)],
      ...relations,
    },
  } satisfies NativeSubjectCreate;
  const response = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
      body: JSON.stringify(input),
    },
    'editor',
  );
  const body = await responseJson<{ subject: { id: string; type: string } }>(
    response,
    201,
    `POST /v1/subjects (${type}, ${label})`,
  );
  if (body.subject.type !== type)
    throw new Error(`POST /v1/subjects returned ${body.subject.type} for requested ${type} (${body.subject.id})`);
  return { id: body.subject.id, type, label, text };
}

async function readCreatedSubject(
  stack: NativeWebStack,
  expected: BookCatalogueIdentity,
  relation?: { property: string; target: string },
): Promise<void> {
  const response = await stack.kernel(`/v1/subjects/${encodeURIComponent(expected.id)}`);
  const body = await responseJson<{
    subject: {
      id: string;
      type: string;
      labels: Record<string, string>;
      statements: Record<string, { value: { content: unknown } }[]>;
    };
  }>(response, 200, `GET /v1/subjects/${expected.id}`);
  const subject = body.subject;
  if (subject.id !== expected.id || subject.type !== expected.type || subject.labels.en !== expected.label)
    throw new Error(`GET /v1/subjects/${expected.id} returned a different fixture identity`);
  if (!JSON.stringify(subject.statements['schema:abstract'] ?? []).includes(expected.text))
    throw new Error(`GET /v1/subjects/${expected.id} omitted its original fixture text`);
  if (
    relation &&
    !subject.statements[relation.property]?.some((statement) => statement.value.content === relation.target)
  )
    throw new Error(`GET /v1/subjects/${expected.id} omitted ${relation.property} to ${relation.target}`);
}

function releasedState(
  release: NativeRelease,
  type: BookCatalogueType,
  role: 'planned' | 'completed',
  required: boolean,
): NativeState | undefined {
  const profileId = release.release.types[type]?.library?.profileId;
  if (!profileId) {
    if (required) throw new Error(`GET /v1/definitions/releases: released ${type} has no personal Library profile`);
    return undefined;
  }
  const states = release.release.libraryProfiles[profileId]?.entryStateSet?.states ?? [];
  const state = states.find((candidate) => candidate.role === role);
  if (!state)
    throw new Error(`GET /v1/definitions/releases: ${type} Library profile ${profileId} has no ${role} state`);
  const label = state.labels.en;
  if (!label) throw new Error(`GET /v1/definitions/releases: ${type} ${role} state has no English label`);
  return { id: state.id, label };
}

async function openPersonalLibrary(stack: NativeWebStack): Promise<void> {
  const response = await stack.kernel(
    '/v1/platform/exposure/personal_library:open',
    { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } },
    'governor',
  );
  await responseJson(response, 200, 'POST /v1/platform/exposure/personal_library:open');
}

async function createLibraryEntry(
  stack: NativeWebStack,
  subject: BookCatalogueIdentity,
  state: NativeState,
): Promise<LibraryEntryRead> {
  const response = await stack.kernel(
    `/v1/libraryEntries/${encodeURIComponent(subject.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
      body: JSON.stringify({ state: state.id }),
    },
    'alice',
  );
  const body = await responseJson<{ libraryEntry: LibraryEntryRead }>(
    response,
    201,
    `PUT /v1/libraryEntries/${subject.id}`,
  );
  if (body.libraryEntry.subjectId !== subject.id || body.libraryEntry.state !== state.id)
    throw new Error(`PUT /v1/libraryEntries/${subject.id} returned a mismatched entry`);
  return body.libraryEntry;
}

function searchSubjectMap(page: NativeSearchPage): Map<string, NativeSearchSubject> {
  return new Map(page.subjects.map((subject) => [subject.id, subject]));
}

async function waitForNativeSearch(
  stack: NativeWebStack,
  marker: string,
  expected: readonly BookCatalogueIdentity[],
): Promise<NativeSearchPage> {
  const input = { text: marker, languages: ['en'] } satisfies NativeSearchRequest;
  const deadline = performance.now() + 90_000;
  let last = 'no response';
  while (performance.now() < deadline) {
    const response = await stack.kernel('/v1/subjects:search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const text = await response.text();
    last = `HTTP ${response.status}: ${text.slice(0, 400)}`;
    if (response.status === 200) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`POST /v1/subjects:search returned invalid JSON: ${text.slice(0, 400)}`, { cause: error });
      }
      if (!isSearchPage(parsed))
        throw new Error(`POST /v1/subjects:search returned an invalid default response: ${text.slice(0, 400)}`);
      const found = searchSubjectMap(parsed);
      if (
        expected.every((subject) => {
          const hit = found.get(subject.id);
          return hit?.type === subject.type && hit.labels.en === subject.label;
        })
      )
        return parsed;
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `POST /v1/subjects:search did not return every fixture identity through the installed default Search response within 90000ms; last response ${last}`,
  );
}

export async function startBookCatalogueJourneyFixture(): Promise<BookCatalogueJourneyFixture> {
  const searchContainer = await prepareSearch();
  const stack = await startNativeWebStack({ writeRateOverrides });
  let auth: NativeAuthStack | undefined;
  try {
    const active = await responseJson<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      200,
      'GET /v1/definitions/active',
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Native fixture uses Definitions ${active.digest}; expected installed bundled ${bundledDigest}`);
    const release = await responseJson<NativeRelease>(
      await stack.kernel(`/v1/definitions/releases/${encodeURIComponent(active.digest)}`),
      200,
      `GET /v1/definitions/releases/${encodeURIComponent(active.digest)}`,
    );

    const marker = `bookcatalogue${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const prefix = `Native Book Catalogue ${marker}`;
    const series = await createSubject(
      stack,
      marker,
      'schema:BookSeries',
      `${prefix}: Greywater Lanterns`,
      'Three original books follow the keepers who mark fog channels around Greywater Sound.',
    );
    const book = await createSubject(
      stack,
      marker,
      'schema:Book',
      `${prefix}: The Last Ferry`,
      'On the last ferry to Gull Lantern, Mara finds a map written in the margin of an ordinary atlas.',
      {
        'wdt:P179': [relation('wdt:P179', series.id, `https://example.org/native-book-catalogue/${marker}/series`)],
      },
    );
    const edition = await createSubject(
      stack,
      marker,
      'bf:Instance',
      `${prefix}: The Last Ferry, first edition`,
      "A blue paper jacket preserves the author's first printed arrangement of The Last Ferry.",
      {
        'schema:exampleOfWork': [
          relation('schema:exampleOfWork', book.id, `https://example.org/native-book-catalogue/${marker}/work`),
        ],
      },
    );
    const expected = [series, book, edition];
    await readCreatedSubject(stack, series);
    await readCreatedSubject(stack, book, { property: 'wdt:P179', target: series.id });
    await readCreatedSubject(stack, edition, { property: 'schema:exampleOfWork', target: book.id });

    const bookPlanned = releasedState(release, book.type, 'planned', true)!;
    const bookCompleted = releasedState(release, book.type, 'completed', true)!;
    const editionPlanned = releasedState(release, edition.type, 'planned', true)!;
    const seriesPlanned = releasedState(release, series.type, 'planned', false);
    await openPersonalLibrary(stack);
    const initialBookEntry = await createLibraryEntry(stack, book, bookPlanned);
    await createLibraryEntry(stack, edition, editionPlanned);
    if (seriesPlanned) await createLibraryEntry(stack, series, seriesPlanned);

    const search = await waitForNativeSearch(stack, marker, expected);
    auth = await startAuthStack(stack);
    console.info(
      'book-catalogue-journey-fixture',
      JSON.stringify({
        stage: 'fixture preparation',
        definitions: active.digest,
        defaultSearchStatus: 200,
        defaultSearchIdentities: expected.map(({ id, type, label }) => ({ id, type, label })),
        releasedLibraryStates: {
          book: { planned: bookPlanned, completed: bookCompleted },
          edition: editionPlanned,
          series: seriesPlanned ?? 'no personal Library profile in this release',
        },
        searchContainer: searchContainer.container ?? 'shared OPENSEARCH_URL',
      }),
    );
    return {
      stack,
      auth,
      marker,
      subjects: { series, book, edition },
      states: { bookPlanned, bookCompleted, editionPlanned, ...(seriesPlanned ? { seriesPlanned } : {}) },
      initialBookEntry,
      search,
      searchContainer: searchContainer.container,
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
