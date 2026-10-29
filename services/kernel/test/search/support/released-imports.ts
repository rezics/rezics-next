import { bundledDigest } from '@rezics/definitions/bundled';
import { FIELD_GROUPS, type BatchWriteRequest, type BatchWriteResult, type Source } from '@rezics/definitions/bulk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Statement } from '../../../../../specs/semantic-driver.ts';
import { IMPORTER_SCOPES } from '../../../../importer/src/credentials.ts';
import { readDump } from '../../../../importer/src/dumps.ts';
import { Importer, type ImportRunResult } from '../../../../importer/src/importer.ts';
import { createSourceRegistration } from '../../../../importer/src/source-registry.ts';
import type { Claim } from '../../../../importer/src/record-bindings.ts';
import type { SemanticOutcomeDriver } from '../../semantic/outcome-driver.ts';
import type { WireResponse } from './outcome-supervisor.ts';

export type ReleasedBookInput = { version: 1 };
type NativeCandidate = {
  id: string;
  statement: Omit<Statement, 'value'> & { value: Statement['value'] | { type: 'somevalue' } | { type: 'novalue' } };
  source: Source;
  head: number | null;
  retracted: number | null;
};
type BatchObservation = {
  request: BatchWriteRequest;
  response: Omit<WireResponse, 'body'> & { body: BatchWriteResult };
};
type RunObservation = {
  run: ImportRunResult;
  binding: Claim | null;
  candidates: { candidate: string; key: string; subject: string }[];
  batches: BatchObservation[];
};
export type ReleasedBookReceipt = {
  version: 1;
  fixtureHash: string;
  converterRevision: string;
  release: string;
  subjectId: string;
  initial: RunObservation;
  reopened: RunObservation;
  selected: {
    candidate: string;
    property: string;
    source: Source;
    statement: NativeCandidate['statement'];
    acceptance: WireResponse;
    adoption: WireResponse;
  }[];
  beforeReplay: WireResponse;
  afterReplay: WireResponse;
  replayed: WireResponse[];
};

export function releasedBookInput(input: unknown): asserts input is ReleasedBookInput {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'version') ||
    (input as ReleasedBookInput).version !== 1
  )
    throw new Error('importReleasedBook requires only {version: 1}');
}

/** Private same-world journey. The only input selects this fixed, synthetic fixture version. */
export function createReleasedBookImport(semantic: SemanticOutcomeDriver) {
  let running: Promise<ReleasedBookReceipt> | undefined;
  let closed = false;
  let directory: string | undefined;
  let importer: Importer | undefined;
  // Media permissions in the CLI's superset are unnecessary for this metadata-only record.
  const scopes = IMPORTER_SCOPES.filter((scope) => !scope.startsWith('media:'));
  let account: Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>> | undefined;
  let session: string | undefined;
  let firstImportFailure: Error | undefined;
  function wire(response: Awaited<ReturnType<SemanticOutcomeDriver['request']>>): WireResponse {
    const headers: [string, string][] = [];
    for (const [key, value] of response.headers) if (key.toLowerCase() !== 'set-cookie') headers.push([key, value]);
    for (const value of response.headers.getSetCookie()) headers.push(['set-cookie', value]);
    return { status: response.status, body: response.body, headers };
  }
  function nativeFailure(response: WireResponse, path: string, request?: unknown) {
    return Object.assign(
      new Error(`Released Book ${path}: HTTP ${response.status}: ${JSON.stringify(response.body)}`),
      {
        path,
        response,
        ...(request === undefined ? {} : { request }),
      },
    );
  }
  function required(response: WireResponse, status: number, path: string) {
    if (response.status !== status) throw nativeFailure(response, path);
    return response;
  }
  async function sendImport(method: 'GET' | 'POST', path: string, body?: unknown) {
    const response = await semantic.fixtures.send(account!, method, path, body, {
      ...(session ? { 'rezics-session-token': session } : {}),
    });
    session = response.headers.get('rezics-session-token') ?? session;
    const observation = wire(response);
    if (response.status !== 200) {
      firstImportFailure ??= nativeFailure(observation, path, body);
      throw firstImportFailure;
    }
    return observation;
  }
  async function request(persona: 'anonymous' | 'editor' | 'acceptor', path: string, body?: unknown) {
    return required(
      wire(
        await semantic.request(
          persona,
          body === undefined ? 'GET' : 'POST',
          path,
          body,
          body === undefined ? undefined : { 'Idempotency-Key': `"${randomUUID()}"` },
        ),
      ),
      200,
      path,
    );
  }
  async function cleanup() {
    try {
      await importer?.close();
    } finally {
      importer = undefined;
      if (directory) {
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
      }
    }
  }
  async function perform(): Promise<ReleasedBookReceipt> {
    try {
      firstImportFailure = undefined;
      const active = await request('anonymous', '/v1/definitions/active');
      if (active.body.digest !== bundledDigest)
        throw new Error('Released Book requires the actual active bundled release');
      if (!account) {
        account = await semantic.fixtures.person('released_book_importer', { scopes });
        await semantic.fixtures.grantAccount(account, scopes, semantic.globalContext);
      }
      const fixtureBytes = await Bun.file(
        new URL('../../../../../specs/fixtures/imports/wikidata/entity.json', import.meta.url),
      ).text();
      const fixture = JSON.parse(fixtureBytes) as { id: string };
      const registration = createSourceRegistration('wikidata');
      const owner = { source: registration.source, external_id: fixture.id };
      const bytes = new TextEncoder().encode(`${JSON.stringify(JSON.parse(fixtureBytes))}\n`);
      directory = await mkdtemp(join(tmpdir(), 'search-released-book-'));
      const path = join(directory, 'import.sqlite');
      async function run(): Promise<RunObservation> {
        const batches: BatchObservation[] = [];
        importer = new Importer({
          path,
          transport: {
            async batchWrite(body) {
              const response = await sendImport('POST', '/v1/subjects:batchWrite', body);
              const native = response.body as BatchWriteResult;
              if (native.results.some((result) => result.status !== 200 && result.status !== 201))
                firstImportFailure ??= nativeFailure(response, '/v1/subjects:batchWrite', body);
              batches.push({ request: structuredClone(body), response: { ...response, body: native } });
              return native;
            },
            async readFence(tuple) {
              const query = new URLSearchParams({
                source: tuple.source,
                externalId: tuple.external_id,
                fieldGroup: tuple.field_group,
              });
              const response = await sendImport('GET', `/v1/sourceFences:check?${query}`);
              if (
                typeof response.body.fenced !== 'boolean' ||
                !(response.body.securityRevision === null || typeof response.body.securityRevision === 'string')
              )
                throw new Error(`Invalid native fence response: ${JSON.stringify(response.body)}`);
              return response.body as { fenced: boolean; securityRevision: string | null };
            },
          },
        });
        const run = await importer.runRecords(
          registration,
          readDump(
            'wikidata',
            (async function* () {
              yield bytes;
            })(),
          ),
          { collectionLimit: 1 },
        );
        if (run.status !== 'committed')
          throw firstImportFailure ?? new Error(`Released Book import: ${JSON.stringify(run)}`);
        const binding = importer.session.bindings.claim(owner);
        const candidates = FIELD_GROUPS.flatMap((group) =>
          importer!.session.bindings.candidates(owner, group, { limit: 100 }),
        ).map(({ candidate, key, subject }) => ({ candidate, key, subject }));
        await importer.close();
        importer = undefined;
        return { run, binding, candidates, batches };
      }
      const initial = await run();
      if (initial.binding?.state !== 'bound') throw new Error('Importer returned no native Book binding');
      const subjectId = initial.binding.subject;
      const commands = initial.batches.flatMap((b) => b.request.commands).filter((c) => c.op === 'propose');
      const selected: ReleasedBookReceipt['selected'] = [];
      for (const property of new Set(commands.map((c) => c.statement.property.id))) {
        const query = new URLSearchParams({ property, context: semantic.globalContext, limit: '100' });
        const listing = await request('editor', `/v1/subjects/${subjectId}/candidates?${query}`);
        if (listing.body.next) throw new Error('Pinned Book exceeded the single candidate-page bound');
        const candidates = (listing.body.candidates as NativeCandidate[]).filter(
          (c) =>
            initial.candidates.some((owned) => owned.candidate === c.id) &&
            c.source?.source === owner.source &&
            c.source.external_id === owner.external_id &&
            c.retracted === null,
        );
        if (candidates.length !== commands.filter((c) => c.statement.property.id === property).length)
          throw new Error(`Native source candidate mismatch: ${property}: ${JSON.stringify(listing.body)}`);
        const acceptances = new Map<string, WireResponse>();
        for (const candidate of candidates) {
          acceptances.set(
            candidate.id,
            await request('acceptor', `/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
              context: semantic.globalContext,
              expected_head: candidate.head,
            }),
          );
        }
        const adoption = await request('acceptor', `/v1/subjects/${subjectId}:adopt`, {
          context: semantic.globalContext,
          property,
          mode: 'replace',
          selection: candidates.map((c) => ({ candidate: c.id, rank: c.statement.rank })),
          expected_head: (listing.body.adoption as { head: number } | null)?.head ?? null,
        });
        for (const candidate of candidates)
          selected.push({
            candidate: candidate.id,
            property,
            source: candidate.source,
            statement: candidate.statement,
            acceptance: acceptances.get(candidate.id)!,
            adoption,
          });
      }
      const beforeReplay = await request('anonymous', `/v1/subjects/${subjectId}`);
      // A new Importer opens the same durable journal; no baseline or receipt is manufactured.
      const reopened = await run();
      const replayed: WireResponse[] = [];
      for (const batch of initial.batches)
        replayed.push(await sendImport('POST', '/v1/subjects:batchWrite', batch.request));
      const afterReplay = await request('anonymous', `/v1/subjects/${subjectId}`);
      return {
        version: 1,
        fixtureHash: createHash('sha256').update(fixtureBytes).digest('hex'),
        converterRevision: registration.converter_revision,
        release: active.body.digest as string,
        subjectId,
        initial,
        reopened,
        selected,
        beforeReplay,
        afterReplay,
        replayed,
      };
    } finally {
      await cleanup();
    }
  }
  return {
    import(input: unknown) {
      releasedBookInput(input);
      if (closed) throw new Error('Released Book importer is closing');
      if (running) throw new Error('Released Book import already running');
      const operation = perform();
      running = operation;
      void operation
        .finally(() => {
          running = undefined;
        })
        .catch(() => {});
      return operation;
    },
    async close() {
      closed = true;
      await running?.catch(() => {});
      await cleanup();
    },
  };
}
