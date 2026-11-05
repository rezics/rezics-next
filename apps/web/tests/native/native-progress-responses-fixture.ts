import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  createNativeHoldingsHistoryFixture,
  nativeJson,
  type NativeHoldingsHistoryFixture,
} from './native-holdings-history-fixture.ts';

type Persona = 'alice' | 'bob' | 'anonymous' | 'suspended';
type Session = { id: string; revision: number };
type SessionBody = { progressSession: Session };
type HistoryBody = { changes?: unknown[]; completedUnits?: string[]; next: string | null };

/** Only these response headers leave the native fixture. Missing headers remain missing. */
export const PROGRESS_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'www-authenticate'] as const;

export type NativeProgressResponse = Readonly<{
  sequence: number;
  method: 'GET' | 'POST';
  path: string;
  persona: Persona;
  status: number;
  body: unknown;
  bodyText: string;
  headers: Readonly<Partial<Record<(typeof PROGRESS_RESPONSE_HEADERS)[number], string>>>;
  capturedAt: string;
  /** A GET is current at its capture time, even when retained after a later command. */
  temporal: 'current_at_capture';
}>;

export type NativeProgressCommand = Readonly<{
  responseSequence: number;
  method: 'POST';
  path: string;
  persona: Persona;
  input: Readonly<{ body: unknown; bodyText: string; commandKey: string }>;
  /** The response that supplied the compare-and-swap revision, independent of command input. */
  observedRevision?: Readonly<{ responseSequence: number; revision: number }>;
}>;

type Produced = Readonly<{ availability: 'produced'; responseSequences: readonly number[] }>;
type Unavailable = Readonly<{
  availability: 'dependency_unavailable';
  missingInterface: string;
  observedResponseSequences: readonly number[];
}>;
export type NativeProgressScenario = Produced | Unavailable;

/** Closed route/state/persona/export map for the existing Progress route/history reviewer.
 * These are API bindings; browser rendering and captures belong to that reviewer.
 */
export const PROGRESS_RESPONSE_SCENARIOS = {
  ownerIndex: { route: '/en/library/progress', state: 'sessions', persona: 'alice' },
  otherIndex: { route: '/en/library/progress', state: 'own-empty', persona: 'bob' },
  anonymousIndex: { route: '/en/library/progress', state: 'refused', persona: 'anonymous' },
  ownerDetail: { route: '/en/library/progress/$id', state: 'scalar-page', persona: 'alice' },
  zeroDetail: { route: '/en/library/progress/$id', state: 'zero-page', persona: 'alice' },
  recipeDetail: { route: '/en/library/progress/$id', state: 'scalar-minute', persona: 'alice' },
  rereadDetail: { route: '/en/library/progress/$id', state: 'reread', persona: 'alice' },
  completedDetail: { route: '/en/library/progress/$id', state: 'completed-session', persona: 'alice' },
  otherDetail: { route: '/en/library/progress/$id', state: 'unavailable-private', persona: 'bob' },
  anonymousDetail: { route: '/en/library/progress/$id', state: 'refused', persona: 'anonymous' },
  suspendedDetail: { route: '/en/library/progress/$id', state: 'refused', persona: 'suspended' },
  terminalAccount: { route: '/en/library/progress/$id', state: 'terminal-account', persona: 'alice' },
  missingDetail: { route: '/en/library/progress/$id', state: 'not-found', persona: 'alice' },
  changes: { route: '/en/library/progress/$id', state: 'changes-pages', persona: 'alice' },
  changesReset: { route: '/en/library/progress/$id', state: 'changes-reset', persona: 'alice' },
  changesRetry: { route: '/en/library/progress/$id', state: 'changes-retry', persona: 'alice' },
  otherChanges: { route: '/en/library/progress/$id', state: 'unavailable-changes', persona: 'bob' },
  anonymousChanges: { route: '/en/library/progress/$id', state: 'refused-changes', persona: 'anonymous' },
  units: { route: '/en/library/progress/$id', state: 'units-first-empty', persona: 'alice' },
  unitsReset: { route: '/en/library/progress/$id', state: 'units-reset', persona: 'alice' },
  unitsRetry: { route: '/en/library/progress/$id', state: 'units-retry', persona: 'alice' },
  unitsLater: { route: '/en/library/progress/$id', state: 'units-later', persona: 'alice' },
  otherUnits: { route: '/en/library/progress/$id', state: 'unavailable-units', persona: 'bob' },
  anonymousUnits: { route: '/en/library/progress/$id', state: 'refused-units', persona: 'anonymous' },
  crossListCursor: { route: '/en/library/progress/$id', state: 'invalid-units-cursor', persona: 'alice' },
  unsupportedCursor: { route: '/en/library/progress', state: 'unsupported-cursor-mode', persona: 'alice' },
  unsupportedUnits: { route: '/en/library/progress', state: 'unsupported-units-mode', persona: 'alice' },
  unsupportedProfile: { route: '/en/library/progress', state: 'unsupported-profile', persona: 'alice' },
  noncontiguousUnits: { route: '/en/library/progress/$id', state: 'noncontiguous-units', persona: 'alice' },
  historicalUnit: { route: '/en/library/progress/$id', state: 'unknown-historic-unit', persona: 'alice' },
  emptyWithContinuation: { route: '/en/library/progress/$id', state: 'empty-with-continuation', persona: 'alice' },
  unavailableDetail: { route: '/en/library/progress/$id', state: 'retryable-unavailable', persona: 'alice' },
} as const;
export type NativeProgressScenarioName = keyof typeof PROGRESS_RESPONSE_SCENARIOS;

type Source = Readonly<{ revision: string; clean: boolean }>;
export type NativeProgressResponseManifest = Readonly<{
  identity: Readonly<{
    source: Source;
    sourceAfter: Source;
    runtime: Readonly<{ engine: 'Bun'; version: string; kernelOrigin: string; webOrigin: string }>;
    /** The installed stack exposes no attested build identifier. Never invent one from HEAD. */
    build: Readonly<{ availability: 'dependency_unavailable'; missingInterface: string }>;
    currentDevRecording: false;
  }>;
  producer: Readonly<{
    entryPoint: 'createNativeHoldingsHistoryFixture';
    definitionsDigest: string;
    subjects: NativeHoldingsHistoryFixture['book'][];
    /** Setup remains owned by the composed producer; no credentials or Auth journey escape. */
    progressEntryPoint: 'createNativeProgressResponsesFixture';
  }>;
  responses: readonly NativeProgressResponse[];
  commands: readonly NativeProgressCommand[];
  scenarios: Readonly<Record<NativeProgressScenarioName, NativeProgressScenario>>;
  reviewer: readonly Readonly<{
    route: string;
    state: string;
    persona: Persona;
    export: string;
    availability: NativeProgressScenario['availability'];
    responseSequences: readonly number[];
  }>[];
  histories: Readonly<{
    changes: NativeProgressHistory;
    units: NativeProgressHistory;
  }>;
}>;

export type NativeProgressHistory = Readonly<{
  addressField: 'changes' | 'units';
  pages: readonly Readonly<{
    responseSequence: number;
    /** Null means the first request omitted cursor; returned next stays inside the raw response. */
    requestedCursor: string | null;
  }>[];
  reset: Readonly<{ intent: 'reset'; responseSequence: number }>;
  retry: Readonly<{ intent: 'retry'; responseSequence: number }>;
}>;

export type NativeProgressResponsesFixture = Readonly<{
  manifest: NativeProgressResponseManifest;
  close(): Promise<void>;
}>;

function sourceIdentity(): Source {
  const cwd = resolve(import.meta.dir, '../../../..');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    return result.stdout.trim();
  };
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Native Progress source revision is not a full commit');
  return { revision, clean: git(['status', '--porcelain', '--untracked-files=all']) === '' };
}

/** Runs public native Progress APIs using the existing installed subjects and real Auth personas.
 * Book/Recipe support scalar progress. The only bundled completed-unit profile is abstract
 * LegacyFixedProfile: it is not a producer for a creatable subject, so later unit pages and
 * noncontiguous units stay explicitly unavailable. No profile or stored history is rewritten.
 */
export async function createNativeProgressResponsesFixture(): Promise<NativeProgressResponsesFixture> {
  const source = sourceIdentity();
  const fixture = await createNativeHoldingsHistoryFixture();
  try {
    const responses: NativeProgressResponse[] = [];
    const commands: NativeProgressCommand[] = [];
    async function request<T>(
      method: 'GET' | 'POST',
      path: string,
      persona: Persona,
      expectedStatus: number,
      input?: { body: unknown; observed?: { responseSequence: number; revision: number } },
    ): Promise<NativeProgressResponse & { body: T }> {
      const bodyText = input === undefined ? undefined : JSON.stringify(input.body);
      const commandKey = input === undefined ? undefined : JSON.stringify(crypto.randomUUID());
      const response = await fixture.stack.kernel(
        path,
        {
          method,
          ...(bodyText === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json', 'idempotency-key': commandKey! },
                body: bodyText,
              }),
        },
        persona,
      );
      // Parse a clone with the existing producer's status assertion; retain the original bytes as text.
      // Transport/setup errors and unexpected statuses propagate, including unexpected 503s.
      const body = await nativeJson<T>(response.clone(), expectedStatus);
      const headers: Partial<Record<(typeof PROGRESS_RESPONSE_HEADERS)[number], string>> = {};
      for (const name of PROGRESS_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const fact = {
        sequence: responses.length,
        method,
        path,
        persona,
        status: response.status,
        body,
        bodyText: await response.text(),
        headers,
        capturedAt: new Date().toISOString(),
        temporal: 'current_at_capture' as const,
      };
      responses.push(fact);
      if (input !== undefined)
        commands.push({
          responseSequence: fact.sequence,
          method: 'POST',
          path,
          persona,
          input: { body: JSON.parse(bodyText!), bodyText: bodyText!, commandKey: commandKey! },
          ...(input.observed === undefined ? {} : { observedRevision: input.observed }),
        });
      return fact;
    }
    const read = <T>(path: string, persona: Persona = 'alice', status = 200) =>
      request<T>('GET', path, persona, status);
    const create = (subjectId: string, mode: string, unit: string, status = 201, total: string | null = null) =>
      request<SessionBody>('POST', '/v1/progressSessions', 'alice', status, {
        body: { subjectId, mode, unit, total },
      });
    const detailPath = (id: string) => `/v1/progressSessions/${encodeURIComponent(id)}?view=FULL&presentation=FULL`;
    const produced = (...facts: NativeProgressResponse[]): Produced => ({
      availability: 'produced',
      responseSequences: facts.map(({ sequence }) => sequence),
    });
    const unavailable = (missingInterface: string, ...facts: NativeProgressResponse[]): Unavailable => ({
      availability: 'dependency_unavailable',
      missingInterface,
      observedResponseSequences: facts.map(({ sequence }) => sequence),
    });
    const started = await create(fixture.book.id, 'scalar_amount', 'page', 201, '300');
    const id = started.body.progressSession.id;
    let current = started;
    for (const amount of ['0', '125', '0']) {
      const observed = { responseSequence: current.sequence, revision: current.body.progressSession.revision };
      current = await request<SessionBody>('POST', `/v1/progressSessions/${id}:record`, 'alice', 200, {
        body: { revision: observed.revision, amount },
        observed,
      });
    }
    const zero = await read<SessionBody>(detailPath(id));
    const ownerDetail = await read<SessionBody>(detailPath(id));

    async function history(list: 'changes' | 'completedUnits'): Promise<NativeProgressHistory> {
      const base = `/v1/progressSessions/${id}/${list}?view=FULL&limit=1`;
      const pages: { responseSequence: number; requestedCursor: string | null }[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const path = base + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const fact = await read<HistoryBody>(path);
        pages.push({ responseSequence: fact.sequence, requestedCursor: cursor });
        cursor = fact.body.next;
        if (cursor !== null) {
          if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error(`Native ${list} cursor did not advance`);
          seen.add(cursor);
        }
        if (pages.length > 20) throw new Error(`Native ${list} exceeded the bounded fixture history`);
      } while (cursor !== null);
      const reset = await read<HistoryBody>(base);
      const retryPage = pages[1] ?? pages[0]!;
      const retry = await read<HistoryBody>(responses[retryPage.responseSequence]!.path);
      return {
        addressField: list === 'changes' ? 'changes' : 'units',
        pages,
        reset: { intent: 'reset', responseSequence: reset.sequence },
        retry: { intent: 'retry', responseSequence: retry.sequence },
      };
    }
    const changes = await history('changes');
    const units = await history('completedUnits');
    const changesFirst = responses[changes.pages[0]!.responseSequence]!;
    const changesCursor = (changesFirst.body as HistoryBody).next;
    if (changesCursor === null) throw new Error('Native changes history did not produce a continuation cursor');
    const crossListCursor = await read(
      `/v1/progressSessions/${id}/completedUnits?view=FULL&limit=1&cursor=${encodeURIComponent(changesCursor)}`,
      'alice',
      400,
    );

    const recipe = await create(fixture.recipe.id, 'scalar_amount', 'minute', 201, '90');
    const recipeDetail = await read(detailPath(recipe.body.progressSession.id));
    const completed = await request<SessionBody>('POST', `/v1/progressSessions/${id}:complete`, 'alice', 200, {
      body: { revision: current.body.progressSession.revision },
      observed: { responseSequence: current.sequence, revision: current.body.progressSession.revision },
    });
    const completedDetail = await read(detailPath(completed.body.progressSession.id));
    const reread = await create(fixture.book.id, 'scalar_amount', 'page');
    const rereadDetail = await read(detailPath(reread.body.progressSession.id));
    const indexPath = `/v1/progressSessions?subjectId=${encodeURIComponent(fixture.book.id)}&view=FULL&limit=100`;
    const ownerIndex = await read(indexPath);
    const otherIndex = await read(indexPath, 'bob');
    const anonymousIndex = await read(indexPath, 'anonymous', 401);
    const otherDetail = await read(detailPath(id), 'bob', 404);
    const anonymousDetail = await read(detailPath(id), 'anonymous', 401);
    const suspendedDetail = await read(detailPath(id), 'suspended', 401);
    // The subject's actual native ID is not a Progress session ID, without guessing a routed UUID.
    const missingDetail = await read(detailPath(fixture.person.id), 'alice', 404);
    const otherChanges = await read(`/v1/progressSessions/${id}/changes?view=FULL&limit=1`, 'bob', 404);
    const anonymousChanges = await read(`/v1/progressSessions/${id}/changes?view=FULL&limit=1`, 'anonymous', 401);
    const otherUnits = await read(`/v1/progressSessions/${id}/completedUnits?view=FULL&limit=1`, 'bob', 404);
    const anonymousUnits = await read(`/v1/progressSessions/${id}/completedUnits?view=FULL&limit=1`, 'anonymous', 401);
    const unsupportedCursor = await create(fixture.book.id, 'cursor_position', 'page', 422);
    const unsupportedUnits = await create(fixture.book.id, 'completed_units', 'page', 422);
    const unsupportedProfile = await create(fixture.person.id, 'scalar_amount', 'page', 422);
    const unitFacts = units.pages.map(({ responseSequence }) => responses[responseSequence]!);
    const scenarios: Record<NativeProgressScenarioName, NativeProgressScenario> = {
      ownerIndex: produced(ownerIndex),
      otherIndex: produced(otherIndex),
      anonymousIndex: produced(anonymousIndex),
      ownerDetail: produced(ownerDetail),
      zeroDetail: produced(zero),
      recipeDetail: produced(recipeDetail),
      rereadDetail: produced(rereadDetail),
      completedDetail: produced(completedDetail),
      otherDetail: produced(otherDetail),
      anonymousDetail: produced(anonymousDetail),
      suspendedDetail: produced(suspendedDetail),
      terminalAccount: unavailable(
        'Installed terminal Auth persona and its private Progress read; no account termination seam is exposed.',
      ),
      missingDetail: produced(missingDetail),
      changes: produced(...changes.pages.map(({ responseSequence }) => responses[responseSequence]!)),
      changesReset: produced(responses[changes.reset.responseSequence]!),
      changesRetry: produced(responses[changes.retry.responseSequence]!),
      otherChanges: produced(otherChanges),
      anonymousChanges: produced(anonymousChanges),
      units: produced(...unitFacts),
      unitsReset: produced(responses[units.reset.responseSequence]!),
      unitsRetry: produced(responses[units.retry.responseSequence]!),
      unitsLater: unavailable(
        'Creatable installed subject with completed_units support, native noncontiguous unit commands and an emitted completedUnits.next cursor.',
        unsupportedUnits,
        ...unitFacts,
      ),
      otherUnits: produced(otherUnits),
      anonymousUnits: produced(anonymousUnits),
      crossListCursor: produced(crossListCursor),
      unsupportedCursor: produced(unsupportedCursor),
      unsupportedUnits: produced(unsupportedUnits),
      unsupportedProfile: produced(unsupportedProfile),
      noncontiguousUnits: unavailable(
        'Installed producer accepting completed_units on a creatable subject; Book/Recipe are scalar-only and LegacyFixedProfile is abstract.',
        unsupportedUnits,
      ),
      historicalUnit: unavailable(
        'Installed producer retaining a session across accepting profile/unit retirement; current presentation cannot be labelled historic.',
      ),
      emptyWithContinuation: unavailable(
        'Native history response with an empty list and a non-null next cursor; none was emitted.',
        ...unitFacts,
      ),
      unavailableDetail: unavailable(
        'Installed dependency outage producer returning a native 503 and original Retry-After through Progress; transport injection is not a native outage.',
      ),
    };
    const sourceAfter = sourceIdentity();
    if (source.revision !== sourceAfter.revision || source.clean !== sourceAfter.clean)
      throw new Error('Native Progress source changed during response capture');
    const manifest: NativeProgressResponseManifest = {
      identity: {
        source,
        sourceAfter,
        runtime: {
          engine: 'Bun',
          version: Bun.version,
          kernelOrigin: fixture.stack.kernelOrigin,
          webOrigin: fixture.stack.web,
        },
        build: {
          availability: 'dependency_unavailable',
          missingInterface: 'NativeWebStack build/artifact identity bound to the running kernel and Web processes.',
        },
        currentDevRecording: false,
      },
      producer: {
        entryPoint: 'createNativeHoldingsHistoryFixture',
        progressEntryPoint: 'createNativeProgressResponsesFixture',
        definitionsDigest: bundledDigest,
        subjects: [fixture.book, fixture.recipe, fixture.person],
      },
      responses,
      commands,
      scenarios,
      histories: { changes, units },
      reviewer: (Object.keys(PROGRESS_RESPONSE_SCENARIOS) as NativeProgressScenarioName[]).map((name) => {
        const scenario = scenarios[name];
        return {
          ...PROGRESS_RESPONSE_SCENARIOS[name],
          export: `manifest.scenarios.${name}`,
          availability: scenario.availability,
          responseSequences:
            scenario.availability === 'produced' ? scenario.responseSequences : scenario.observedResponseSequences,
        };
      }),
    };
    return { manifest, close: () => fixture.close() };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
