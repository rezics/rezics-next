import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { documentText, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { authoredProperties } from '../../src/features/catalogue/authored-properties.ts';
import type { KernelClient } from '@rezics/client';
import { Pool } from 'pg';
import { withBoundedReadOnlyTransaction } from '../../../../services/kernel/src/database/pool.ts';
import { subjectConsumer } from '../../../../services/kernel/src/search/consumer-name.ts';
import {
  readSubjectIndexUuid,
  readSubjectSortFormat,
  subjectGenerations,
  subjectIndexName,
} from '../../../../services/kernel/src/search/indices.ts';
import { createOpenSearch } from '../../../../services/kernel/src/search/opensearch.ts';
import { subjectPartition } from '../../../../services/kernel/src/search/source.ts';
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
  const hasSynopsis = authoredProperties(bundledRelease, type).includes('schema:abstract');
  if (hasSynopsis !== (type !== 'bf:Instance'))
    throw new Error(`Bundled ${type} changed its authored synopsis admission; review its fixture prose contract`);
  // Edition prose describes this publication; Book and Series prose is an authored work synopsis.
  const input = {
    type,
    labels: { en: label },
    ...(type === 'bf:Instance' ? { descriptions: { en: text } } : {}),
    statements: {
      ...(hasSynopsis
        ? { 'schema:abstract': [abstract(text, `https://example.org/native-book-catalogue/${marker}/${type}/text`)] }
        : {}),
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

export async function readCreatedSubject(
  stack: Pick<NativeWebStack, 'kernel'>,
  expected: BookCatalogueIdentity,
  relation?: { property: string; target: string },
): Promise<void> {
  const path = `/v1/subjects/${encodeURIComponent(expected.id)}`;
  const relationDeadline = performance.now() + 60_000;
  let subject;
  for (;;) {
    ({ subject } = await responseJson<{
      subject: {
        id: string;
        type: string;
        labels: Record<string, string>;
        descriptions: Record<string, string>;
        statements: Record<string, { id: string; value: { type: string; content: unknown } }[]>;
      };
    }>(await stack.kernel(path), 200, `GET ${path}`));
    if (subject.id !== expected.id || subject.type !== expected.type || subject.labels.en !== expected.label)
      throw new Error(`GET ${path} returned a different fixture identity`);
    if (
      !relation ||
      subject.statements[relation.property]?.some(
        (statement) => statement.value.type === 'value' && statement.value.content === relation.target,
      )
    )
      break;
    // A new Subject can be public before the durable worker has projected its relations.
    if (performance.now() >= relationDeadline)
      throw new Error(`GET ${path} omitted ${relation.property} to ${relation.target} after waiting 60000ms`);
    await Bun.sleep(250);
  }
  if (expected.type === 'bf:Instance') {
    if (subject.descriptions.en !== expected.text || subject.statements['schema:abstract']?.length)
      throw new Error(
        `GET /v1/subjects/${expected.id} did not preserve its Edition description without a work synopsis`,
      );
  } else {
    const synopsis = subject.statements['schema:abstract']?.find((statement) => {
      const content = statement.value.content;
      return statement.value.type === 'value' && isRecord(content) && content.language === 'en';
    });
    const content = synopsis?.value.content;
    if (!synopsis || !isRecord(content) || typeof content.document !== 'string' || typeof content.digest !== 'string')
      throw new Error(`GET /v1/subjects/${expected.id} omitted its selected authored synopsis locator`);
    const selected = await responseJson<{
      document: {
        id: string;
        subjectId: string;
        candidateId: string;
        digest: string;
        language: string;
        availability: string;
        body: DocumentSnapshot;
      };
    }>(
      await stack.kernel(`/v1/documents/${encodeURIComponent(content.document)}`),
      200,
      `GET /v1/documents/${content.document}`,
    );
    if (
      selected.document.id !== content.document ||
      selected.document.subjectId !== expected.id ||
      selected.document.language !== 'en' ||
      selected.document.availability !== 'available' ||
      selected.document.candidateId !== synopsis.id ||
      selected.document.digest !== content.digest ||
      documentText(selected.document.body).trim() !== expected.text
    )
      throw new Error(`GET /v1/documents/${content.document} did not preserve the selected original fixture synopsis`);
  }
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

async function readSearchFailureSnapshot(stack: NativeWebStack, expected: readonly BookCatalogueIdentity[]) {
  const ownership = stack.searchWorker;
  const url = process.env.OPENSEARCH_URL;
  if (!ownership || !url) throw new Error('Catalogue Search ownership is unavailable');

  // This isolated stack starts without a Subject generation. The ordinary worker allocates generation 1.
  const generation = 1;
  const { prefix, executorId } = ownership;
  const target = subjectIndexName(prefix, generation);
  const search = createOpenSearch(url, { timeoutMs: 1_500 });
  const pool = new Pool({ connectionString: stack.databaseUrl, max: 1, connectionTimeoutMillis: 1_500 });
  const deadline = Date.now() + 4_000;
  try {
    const [engine, database] = await Promise.allSettled([
      subjectGenerations(search, prefix).then(async ({ active, generations }) => {
        const [incarnation, sortFormat] = await Promise.all([
          generations.includes(generation) ? readSubjectIndexUuid(search, prefix, generation) : null,
          active === null ? null : readSubjectSortFormat(search, prefix, active),
        ]);
        return { active, generations, incarnation, sortFormat };
      }),
      withBoundedReadOnlyTransaction(pool, deadline, (client) =>
        client.query(
          `SELECT
             p.locator->>'phase' AS preparation_phase, p.revision AS preparation_revision,
             p.lease_until > extract(epoch FROM now()) * 1000 AS preparation_leased,
             j.phase, j.home, j.pass, j.native_incarnation,
             b.state AS source_state, b.owner_epoch AS source_epoch, b.publication_job IS NOT NULL AS source_pinned,
             b.coverage_after, b.coverage_sealed, seal.ack_after,
             g.publication_home AS writer_home, g.publication_fence IS NOT NULL AS writer_fenced,
             g.publication_fence::text=j.fence AS writer_fence_matches,
             (SELECT jsonb_agg(jsonb_build_object(
                  'home', h.partition_no, 'epoch', h.epoch, 'position', h.position::text, 'state', h.write_state,
                  'witnessPosition', v.position::text, 'relayPosition', c.position::text) ORDER BY h.partition_no)
              FROM core.partition h
              LEFT JOIN search.generation_publication_home v
                ON v.partition_no=h.partition_no AND v.job=j.job AND v.pass=j.pass
              LEFT JOIN core.consumer_checkpoint c ON c.partition_no=h.partition_no AND c.consumer=$8
              WHERE h.partition_no=ANY($5) OR h.partition_no IN (j.home,j.source_home,g.publication_home))
              AS homes,
             (SELECT jsonb_agg(jsonb_build_object(
                  'home', w.partition_no, 'state', w.dispatch_state, 'inFlight', w.writer_token IS NOT NULL,
                  'sourcePosition', w.source_position::text, 'visiblePosition', w.visible_position::text))
              FROM search.identity_writer w
              WHERE w.physical_target=$2 AND w.incarnation=j.native_incarnation
                AND w.partition_no=ANY($5) AND w.original_id=ANY($6)) AS fixture_writers,
             delivery.status AS worker_status, delivery.queue_name AS worker_queue,
             delivery.executor_id=$7 AS owned_executor
           FROM (SELECT $1::text AS prefix) owner
           LEFT JOIN search.public_preparation p ON p.partition_no=0 AND p.prefix=owner.prefix
             AND p.kind='population' AND p.locator->>'key'=$3
           LEFT JOIN LATERAL (
             SELECT * FROM search.generation_publication j
             WHERE j.partition_no=0 AND j.prefix=owner.prefix AND j.physical_target=$2
               AND j.family='subjects' AND j.generation=$3::bigint AND j.consumer->>'meaningDigest'=$4
               AND (p.locator->>'publication' IS NULL OR j.job::text=p.locator->>'publication')
               AND (p.locator IS NULL OR j.native_incarnation=p.locator->>'uuid')
             ORDER BY (j.fence IS NOT NULL) DESC, j.activated_at, j.job
             LIMIT 1
           ) j ON true
           LEFT JOIN search.public_filter_registration r ON r.partition_no=j.source_home
             AND r.physical_target=j.physical_target AND r.state='active'
             AND r.consumer::jsonb=(
               SELECT jsonb_build_array('object', jsonb_agg(
                 jsonb_build_array(key, jsonb_build_array('scalar', value)) ORDER BY key COLLATE "C"
               )) FROM jsonb_each(j.consumer)
             )
           LEFT JOIN LATERAL (
             SELECT b.bootstrap,b.partition_no,b.state,b.owner_epoch,b.coverage_after,b.coverage_sealed,
                    b.publication_job,b.publication_execution
             FROM semantic.public_filter_bootstrap b
             WHERE b.partition_no=j.source_home AND b.snapshot_kind='prepared'
               AND b.read_definition::text=j.consumer->>'readDefinition'
               AND (j.observation IS NULL OR b.publication_observation=j.observation)
               AND (b.publication_job=j.job OR
                 (b.publication_job IS NULL AND b.bootstrap::text=split_part(r.consumer_bootstrap, ':', 2)))
             ORDER BY (b.publication_job IS NOT NULL) DESC LIMIT 1
           ) b ON true
           LEFT JOIN LATERAL (
             SELECT ack_after FROM semantic.public_filter_repair_step t
             WHERE t.partition_no=b.partition_no AND t.bootstrap=b.bootstrap
               AND t.execution=b.publication_execution AND t.complete AND t.verified_next IS NULL
             ORDER BY t.ack_after DESC LIMIT 1
           ) seal ON true
           LEFT JOIN search.identity_writer_gate g ON g.partition_no=0 AND g.physical_target=j.physical_target
             AND g.incarnation=j.native_incarnation AND g.publication_job=j.job
           LEFT JOIN LATERAL (
             SELECT status, queue_name, executor_id FROM dbos.workflow_status w
             WHERE w.name='search.publicPreparation'
               AND (w.workflow_uuid='search.publicPreparation:' || p.id || ':' || p.revision || ':population'
                 OR (w.executor_id=$7 AND w.queue_name='workflows' AND w.status='PENDING'
                   AND w.workflow_uuid LIKE ('search.publicPreparation:' || p.id || ':%:population')))
             ORDER BY (w.status='PENDING') DESC, w.started_at_epoch_ms DESC NULLS LAST LIMIT 1
           ) delivery ON true`,
          [
            prefix,
            target,
            String(generation),
            bundledDigest,
            expected.map(({ id }) => subjectPartition(id)),
            expected.map(({ id }) => id),
            executorId,
            subjectConsumer(prefix, generation),
          ],
        ),
      ),
    ]);
    return JSON.stringify({
      target,
      engine: engine.status === 'fulfilled' ? engine.value : { error: engine.reason?.name ?? 'unavailable' },
      database:
        database.status === 'fulfilled'
          ? database.value.rows[0]
          : { error: database.reason?.code ?? database.reason?.name ?? 'unavailable' },
    });
  } finally {
    await pool.end();
  }
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
  let workerOutput = 'unavailable';
  let readiness = 'unavailable';
  try {
    const lifecycle = currentNativeLifecycle();
    if (!lifecycle) throw new Error('Catalogue Search diagnostics require an active native lifecycle');
    const [worker, snapshot] = await lifecycle.run(
      'read catalogue Search diagnostics',
      5_000,
      () => Promise.allSettled([stack.workerLogs(), readSearchFailureSnapshot(stack, expected)]),
      false,
    );
    workerOutput = worker.status === 'fulfilled' ? worker.value : 'unavailable';
    readiness = snapshot.status === 'fulfilled' ? snapshot.value : 'unavailable';
  } catch (error) {
    workerOutput = `Worker diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new Error(
    `POST /v1/subjects:search did not return every fixture identity through the installed default Search response within 90000ms; last response ${last}\nSubject Search readiness: ${readiness}\nDurable Search worker output:\n${workerOutput}`,
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
    console.info(
      'book-catalogue-journey-fixture',
      JSON.stringify({
        stage: 'anonymous Subject readback',
        series: series.id,
        book: book.id,
        edition: edition.id,
        relations: ['wdt:P179', 'schema:exampleOfWork'],
      }),
    );

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
