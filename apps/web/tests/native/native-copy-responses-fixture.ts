import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import type { Release } from '@rezics/definitions';
import type { NativeHoldingsHistoryFixture } from './native-holdings-history-fixture.ts';

/** Page measurements and story/capture IDs belong to the Copies route reviewer. */
export const nativeCopyScenarios = {
  activeRelease: ['setup', 'anonymous'],
  acceptedRelease: ['setup', 'anonymous'],
  firstCreate: ['created-first', 'alice'],
  secondCreate: ['created-second', 'alice'],
  firstDetail: ['accepted-meaning-and-long-note', 'alice'],
  secondDetail: ['independent-holding', 'alice'],
  currentAdvice: ['current-status-advice', 'alice'],
  firstEdit: ['first-independent-edit', 'alice'],
  secondAfterFirstEdit: ['second-unchanged-after-first-edit', 'alice'],
  secondEdit: ['second-independent-edit', 'alice'],
  firstEditedDetail: ['retained-accepted-meaning', 'alice'],
  secondEditedDetail: ['second-edited-detail', 'alice'],
  staleEdit: ['stale-edit', 'alice'],
  createReplay: ['original-create-replay', 'alice'],
  changedCreateIntent: ['changed-original-intent', 'alice'],
  listFirst: ['first-page', 'alice'],
  listFinal: ['final-page', 'alice'],
  otherList: ['other-empty-list', 'bob'],
  otherDetail: ['other-hidden-detail', 'bob'],
  anonymousList: ['anonymous-denied-list', 'anonymous'],
  anonymousDetail: ['anonymous-hidden-detail', 'anonymous'],
  unsupportedCreate: ['unsupported-profile', 'alice'],
  entryCreate: ['independent-entry', 'alice'],
  progressCreate: ['independent-progress', 'alice'],
  progressRecord: ['independent-progress-record', 'alice'],
  entryBefore: ['entry-before-removal', 'alice'],
  progressBefore: ['progress-before-removal', 'alice'],
  remove: ['removed-original', 'alice'],
  removedDetail: ['removed-hidden', 'alice'],
  listRemoved: ['remaining-independent-holding', 'alice'],
  siblingRemoved: ['sibling-after-removal', 'alice'],
  entryRemoved: ['entry-after-removal', 'alice'],
  progressRemoved: ['progress-after-removal', 'alice'],
  otherRestore: ['other-denied-undo', 'bob'],
  staleRestore: ['stale-undo', 'alice'],
  restore: ['exact-undo', 'alice'],
  restoreReplay: ['original-undo-replay', 'alice'],
  occupiedRestore: ['occupied-undo', 'alice'],
  removalReplay: ['original-removal-replay', 'alice'],
  restoredDetail: ['restored-accepted-meaning', 'alice'],
  siblingRestored: ['sibling-after-undo', 'alice'],
  entryRestored: ['entry-after-undo', 'alice'],
  progressRestored: ['progress-after-undo', 'alice'],
  listRestored: ['restored-independent-holdings', 'alice'],
  historicalAcceptedMeaning: ['historical-accepted-profile', 'alice'],
  expiredRestore: ['expired-undo', 'alice'],
  terminalRestore: ['terminal-undo', 'alice'],
  noJsOperation: ['no-javascript-operation-admission', 'alice'],
} as const;

export type NativeCopyScenario = keyof typeof nativeCopyScenarios;
export type CopyPersona = 'alice' | 'bob' | 'anonymous';
export type CopyCommand = Readonly<{
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  persona: CopyPersona;
  input?: unknown;
  bodyText?: string;
  idempotencyKey?: string;
  /** Observation selecting this command, never an inferred returned fact. */
  observed?: { scenario: NativeCopyScenario; revision: number };
}>;
export const copyResponseHeaders = [
  'content-type',
  'cache-control',
  'retry-after',
  'etag',
  'vary',
  'library-copy-deletion-id',
  'library-copy-deletion-revision',
] as const;
export type CopyResponseExport = Readonly<{
  command: CopyCommand;
  response: {
    status: number;
    headers: Partial<Record<(typeof copyResponseHeaders)[number], string>>;
    bodyText: string;
    body: unknown;
  };
}>;
export type CopyOutcome =
  | { availability: 'produced'; sequence: number; exchange: CopyResponseExport; responseSource?: NativeCopyScenario }
  | {
      availability: 'dependency_unavailable';
      reason: string;
      requiredInterface: string;
      observedResponse?: NativeCopyScenario;
    };
export type CopySourceIdentity = {
  revision: string;
  clean: boolean;
  runtime: { name: 'Bun'; version: string; kernelOrigin: string; webOrigin: string };
  build: { state: 'unknown'; requiredInterface: string };
};
export type NativeCopyManifest = {
  schema: 'native-copy-responses/v1';
  evidence: 'native-api-responses';
  currentDevRecording: false;
  rendered: false;
  identity: CopySourceIdentity;
  sourceAtEnd: { revision: string; clean: boolean };
  subjectId: string;
  outcomes: Record<NativeCopyScenario, CopyOutcome>;
  sequence: NativeCopyScenario[];
  routeStates: {
    route: string;
    state: string;
    persona: CopyPersona;
    export: NativeCopyScenario;
    availability: CopyOutcome['availability'];
  }[];
};
export type NativeCopyResponsesFixture = {
  manifest: NativeCopyManifest;
  close(): Promise<void>;
};

const originals = new WeakMap<CopyResponseExport, CopyResponseExport>();
const nativeManifests = new WeakSet<NativeCopyManifest>();
function requireFact(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Copies response binding: ${detail}`);
}
export function copyObject(value: unknown): Record<string, unknown> {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected response object');
  return value as Record<string, unknown>;
}
function copyOf(value: CopyResponseExport): Record<string, unknown> {
  return copyObject(copyObject(value.response.body).copy);
}
function jsonBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Copies-specific transport export. This alone makes no assertion of native execution. */
export async function captureCopyResponse(command: CopyCommand, response: Response): Promise<CopyResponseExport> {
  const headers: CopyResponseExport['response']['headers'] = {};
  for (const name of copyResponseHeaders) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const bodyText = await response.text();
  const exchange = {
    command: structuredClone(command),
    response: { status: response.status, headers, bodyText, body: jsonBody(bodyText) },
  };
  originals.set(exchange, structuredClone(exchange));
  return exchange;
}

/** Consumers can reject normalization, added DTO fields and detached command/response pairs. */
export function assertCopyResponseUnmodified(exchange: CopyResponseExport): void {
  const original = originals.get(exchange);
  requireFact(
    original && isDeepStrictEqual(exchange, original),
    'response or original command was changed or detached',
  );
  requireFact(
    isDeepStrictEqual(exchange.response.body, jsonBody(exchange.response.bodyText)),
    'body differs from bodyText',
  );
  requireFact(
    Object.keys(exchange.response.headers).every((name) => (copyResponseHeaders as readonly string[]).includes(name)),
    'non-allowlisted response header',
  );
  const { command } = exchange;
  requireFact(
    command.input === undefined ? command.bodyText === undefined : command.bodyText === JSON.stringify(command.input),
    'command body differs from original input',
  );
}

/** Exact Undo changes the native revision but preserves the returned personal facts. */
export function assertCopyRestored(original: CopyResponseExport, restored: CopyResponseExport): void {
  const before = copyOf(original),
    after = copyOf(restored);
  for (const field of ['id', 'subjectId', 'kind', 'status', 'location', 'source', 'acquiredOn', 'disposedOn', 'note'])
    requireFact(isDeepStrictEqual(before[field], after[field]), `Undo changed original ${field}`);
  requireFact(
    Number.isInteger(after.revision) && Number(after.revision) > Number(before.revision),
    'Undo did not advance revision',
  );
}

export function assertCopyRetainedMeaning(before: CopyResponseExport, after: CopyResponseExport): void {
  requireFact(
    isDeepStrictEqual(copyOf(before).presentation, copyOf(after).presentation),
    'accepted meaning reconstructed from current Advice',
  );
}

export function assertCopyPersonalFacts(before: CopyResponseExport, after: CopyResponseExport): void {
  requireFact(isDeepStrictEqual(before.response.body, after.response.body), 'independent personal facts changed');
}

function assertCopyWriteResult(exchange: CopyResponseExport): void {
  const input = copyObject(exchange.command.input),
    copy = copyOf(exchange);
  for (const [field, value] of Object.entries(input)) {
    if (field === 'revision')
      requireFact(copy.revision === Number(value) + 1, 'edit did not advance observed revision');
    else requireFact(isDeepStrictEqual(copy[field], value), `write response lost original ${field}`);
  }
}

export function assertCopyIsolation(
  first: CopyResponseExport,
  second: CopyResponseExport,
  siblingAfter: CopyResponseExport,
): void {
  const a = copyOf(first),
    b = copyOf(second);
  requireFact(a.id !== b.id && a.subjectId === b.subjectId, 'two holdings were merged by Subject');
  requireFact(isDeepStrictEqual(second.response.body, siblingAfter.response.body), 'other holding changed');
}

export function assertCopyPrivateResponse(exchange: CopyResponseExport, privateValues: string[]): void {
  requireFact(exchange.command.persona !== 'alice', 'private boundary requires another persona');
  for (const value of privateValues)
    requireFact(!exchange.response.bodyText.includes(value), 'private facts disclosed to another persona');
}

export function assertCopyUndoCommand(removal: CopyResponseExport, restore: CopyResponseExport): void {
  requireFact(
    removal.command.method === 'DELETE' && removal.response.status === 204,
    'original removal receipt absent',
  );
  requireFact(
    restore.command.method === 'POST' && restore.command.path === `${removal.command.path.split('?')[0]}:restore`,
    'Undo targets another holding',
  );
  const deletionId = removal.response.headers['library-copy-deletion-id'];
  const revision = removal.response.headers['library-copy-deletion-revision'];
  requireFact(deletionId && revision && /^[1-9][0-9]*$/.test(revision), 'original deletion receipt headers absent');
  requireFact(
    isDeepStrictEqual(restore.command.input, { deletionId, revision: Number(revision) }),
    'Undo changed original removal intent',
  );
  requireFact(
    restore.command.persona === removal.command.persona && restore.command.idempotencyKey,
    'Undo lost owner or retained command key',
  );
}

export function assertCopyPaging(first: CopyResponseExport, final: CopyResponseExport, holdingIds: unknown[]): void {
  const a = copyObject(first.response.body),
    b = copyObject(final.response.body);
  requireFact(typeof a.next === 'string' && a.next.length > 0, 'native first cursor absent');
  requireFact(
    new URL(final.command.path, 'http://copies.test').searchParams.get('cursor') === a.next,
    'native next cursor changed',
  );
  requireFact(
    Array.isArray(a.copies) &&
      a.copies.length === 1 &&
      Array.isArray(b.copies) &&
      b.copies.length === 1 &&
      b.next === null,
    'native final page replaced by a constructed empty page',
  );
  const ids = [...a.copies, ...b.copies].map((row) => copyObject(row).id);
  requireFact(
    new Set(ids).size === 2 && holdingIds.every((id) => ids.includes(id)),
    'paging lost an independent holding',
  );
}

function gitSource(): { revision: string; clean: boolean } {
  const cwd = resolve(import.meta.dir, '../../../..');
  const run = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const revision = run(['rev-parse', 'HEAD']);
  requireFact(/^[0-9a-f]{40}$/.test(revision), 'source revision unknown');
  return { revision, clean: run(['status', '--porcelain', '--untracked-files=normal']) === '' };
}

export function assertNativeCopyResponses(manifest: NativeCopyManifest): void {
  requireFact(
    nativeManifests.has(manifest),
    'native producer binding absent; source-authored data is not native execution',
  );
  requireFact(
    manifest.schema === 'native-copy-responses/v1' && manifest.evidence === 'native-api-responses',
    'native provenance absent',
  );
  requireFact(
    manifest.currentDevRecording === false && manifest.rendered === false,
    'unknown build or API responses claimed as current-dev/rendered evidence',
  );
  requireFact(
    manifest.identity.revision === manifest.sourceAtEnd.revision &&
      manifest.identity.clean === manifest.sourceAtEnd.clean,
    'source changed during native execution',
  );
  requireFact(
    isDeepStrictEqual(Object.keys(manifest.outcomes).sort(), Object.keys(nativeCopyScenarios).sort()),
    'closed scenario manifest changed',
  );
  for (const [name, outcome] of Object.entries(manifest.outcomes)) {
    if (outcome.availability === 'dependency_unavailable') {
      requireFact(outcome.reason && outcome.requiredInterface, `${name} unavailable without a remaining interface`);
      continue;
    }
    requireFact(
      manifest.sequence[outcome.sequence] === (outcome.responseSource ?? name),
      `${name} lost command sequence`,
    );
    if (outcome.responseSource) {
      const source = manifest.outcomes[outcome.responseSource];
      requireFact(
        name === 'currentAdvice' &&
          outcome.responseSource === 'firstDetail' &&
          source.availability === 'produced' &&
          source.exchange === outcome.exchange,
        'Advice detached from native detail',
      );
    }
    requireFact(
      outcome.exchange.command.persona === nativeCopyScenarios[name as NativeCopyScenario][1],
      `${name} lost persona`,
    );
    assertCopyResponseUnmodified(outcome.exchange);
  }
  const get = (name: NativeCopyScenario) => {
    const outcome = manifest.outcomes[name];
    requireFact(outcome.availability === 'produced', `${name} response absent`);
    return outcome.exchange;
  };
  const expectedRoutes = (
    Object.entries(nativeCopyScenarios) as [NativeCopyScenario, readonly [string, CopyPersona]][]
  ).map(([name, [state, persona]]) => ({
    route: `/en/library/copies?subjectId=${encodeURIComponent(manifest.subjectId)}`,
    state,
    persona,
    export: name,
    availability: manifest.outcomes[name].availability,
  }));
  requireFact(
    isDeepStrictEqual(manifest.routeStates, expectedRoutes),
    'route/state/persona/export map absent or changed',
  );
  for (const name of ['historicalAcceptedMeaning', 'expiredRestore', 'terminalRestore', 'noJsOperation'] as const)
    requireFact(
      manifest.outcomes[name].availability === 'dependency_unavailable',
      `${name} has no installed compatible native producer`,
    );
  for (const name of ['firstCreate', 'secondCreate', 'firstEdit', 'secondEdit'] as const)
    assertCopyWriteResult(get(name));
  const first = get('firstDetail'),
    second = get('secondEditedDetail');
  assertCopyPersonalFacts(get('secondDetail'), get('secondAfterFirstEdit'));
  for (const [field, value] of Object.entries(copyOf(get('firstEdit'))))
    requireFact(
      isDeepStrictEqual(copyOf(get('firstEditedDetail'))[field], value),
      'second edit affected first holding',
    );
  const edited = get('firstEditedDetail'),
    restored = get('restoredDetail');
  assertCopyIsolation(first, second, get('siblingRemoved'));
  assertCopyIsolation(first, second, get('siblingRestored'));
  assertCopyRestored(edited, get('restore'));
  assertCopyRestored(edited, restored);
  assertCopyRetainedMeaning(edited, restored);
  assertCopyRetainedMeaning(first, edited);
  for (const name of ['firstDetail', 'secondDetail'] as const) {
    const detail = get(name),
      copy = copyOf(detail);
    requireFact(typeof copy.note === 'string' && copy.note.length >= 800, `${name} lacks long note`);
    requireFact(copyObject(copy.presentation).meaning === 'known', `${name} native accepted meaning absent`);
    requireFact(
      detail.response.headers['cache-control']?.includes('private') &&
        detail.response.headers['cache-control']?.includes('no-store'),
      'private detail cache policy absent',
    );
  }
  assertCopyPaging(get('listFirst'), get('listFinal'), [copyOf(first).id, copyOf(second).id]);
  assertCopyUndoCommand(get('remove'), get('restore'));
  for (const [original, replay] of [
    ['firstCreate', 'createReplay'],
    ['remove', 'removalReplay'],
    ['restore', 'restoreReplay'],
  ] as const) {
    requireFact(isDeepStrictEqual(get(original).command, get(replay).command), `${replay} changed original command`);
    requireFact(isDeepStrictEqual(get(original).response, get(replay).response), `${replay} changed original response`);
  }
  for (const fact of ['entry', 'progress'] as const)
    for (const phase of ['Removed', 'Restored'] as const)
      assertCopyPersonalFacts(get(`${fact}Before`), get(`${fact}${phase}`));
  const removedRows = copyObject(get('listRemoved').response.body);
  const restoredRows = copyObject(get('listRestored').response.body);
  requireFact(
    Array.isArray(removedRows.copies) &&
      removedRows.copies.length === 1 &&
      copyObject(removedRows.copies[0]).id === copyOf(second).id &&
      removedRows.next === null,
    'removal affected the other holding',
  );
  requireFact(
    Array.isArray(restoredRows.copies) &&
      restoredRows.copies.length === 2 &&
      new Set(restoredRows.copies.map((row) => copyObject(row).id)).size === 2 &&
      restoredRows.copies.some((row) => copyObject(row).id === copyOf(first).id) &&
      restoredRows.copies.some((row) => copyObject(row).id === copyOf(second).id) &&
      restoredRows.next === null,
    'Undo did not restore exactly two holdings',
  );
  const secrets = [copyOf(first).id, copyOf(second).id, copyOf(first).note, copyOf(second).note].map(String);
  for (const name of ['otherList', 'otherDetail', 'anonymousList', 'anonymousDetail', 'otherRestore'] as const)
    assertCopyPrivateResponse(get(name), secrets);
  requireFact(
    isDeepStrictEqual(get('otherList').response.body, { copies: [], next: null }),
    'other list disclosed own holdings',
  );
  const requiredStatuses = {
    otherDetail: 404,
    otherRestore: 404,
    staleEdit: 409,
    changedCreateIntent: 422,
    unsupportedCreate: 422,
    removedDetail: 404,
    staleRestore: 409,
    occupiedRestore: 409,
  } as const;
  for (const [name, status] of Object.entries(requiredStatuses))
    requireFact(get(name as NativeCopyScenario).response.status === status, `${name} did not return ${status}`);
  for (const name of ['anonymousList', 'anonymousDetail'] as const)
    requireFact([401, 404].includes(get(name).response.status), `${name} admitted private read`);
  requireFact(
    copyObject(get('unsupportedCreate').response.body).code === 'unsupported_library_profile',
    'unsupported profile refusal absent',
  );
  requireFact(
    copyObject(get('occupiedRestore').response.body).code === 'copy_restore_occupied',
    'occupied Undo refusal absent',
  );
  requireFact(copyObject(get('staleRestore').response.body).code === 'copy_restore_stale', 'stale Undo refusal absent');
}

/** Executes public APIs on the installed holdings producer; it never seeds SQL or old receipts. */
export async function createNativeCopyResponsesFixture(): Promise<NativeCopyResponsesFixture> {
  const source = gitSource();
  const { createNativeHoldingsHistoryFixture } = await import('./native-holdings-history-fixture.ts');
  const fixture: NativeHoldingsHistoryFixture = await createNativeHoldingsHistoryFixture();
  try {
    const outcomes = {} as NativeCopyManifest['outcomes'];
    const sequence: NativeCopyScenario[] = [];
    const unavailable = (
      name: NativeCopyScenario,
      reason: string,
      requiredInterface: string,
      observedResponse?: NativeCopyScenario,
    ) => {
      outcomes[name] = {
        availability: 'dependency_unavailable',
        reason,
        requiredInterface,
        ...(observedResponse ? { observedResponse } : {}),
      };
    };
    const send = async (name: NativeCopyScenario, command: CopyCommand, statuses: number[]) => {
      const headers: Record<string, string> = { 'accept-language': 'en' };
      if (command.idempotencyKey) headers['idempotency-key'] = command.idempotencyKey;
      if (command.bodyText !== undefined) headers['content-type'] = 'application/json';
      const response = await fixture.stack.kernel(
        command.path,
        {
          method: command.method,
          headers,
          ...(command.bodyText === undefined ? {} : { body: command.bodyText }),
        },
        command.persona === 'anonymous' ? undefined : command.persona,
      );
      const exchange = await captureCopyResponse(command, response);
      requireFact(statuses.includes(response.status), `${name}: ${response.status} ${exchange.response.bodyText}`);
      outcomes[name] = { availability: 'produced', sequence: sequence.length, exchange };
      sequence.push(name);
      return exchange;
    };
    const read = (name: NativeCopyScenario, path: string, statuses = [200]) =>
      send(name, { method: 'GET', path, persona: nativeCopyScenarios[name][1] }, statuses);
    const write = (
      name: NativeCopyScenario,
      method: CopyCommand['method'],
      path: string,
      input: unknown,
      statuses: number[],
      observed?: CopyCommand['observed'],
    ) =>
      send(
        name,
        {
          method,
          path,
          persona: nativeCopyScenarios[name][1],
          input,
          bodyText: JSON.stringify(input),
          idempotencyKey: `"${crypto.randomUUID()}"`,
          ...(observed ? { observed } : {}),
        },
        statuses,
      );
    const active = await read('activeRelease', '/v1/definitions/active');
    const digest = copyObject(active.response.body).digest;
    requireFact(typeof digest === 'string', 'active release digest absent');
    const released = await read('acceptedRelease', `/v1/definitions/releases/${encodeURIComponent(digest)}`);
    const release = copyObject(released.response.body).release as Release;
    const profileId = release.types[fixture.book.type]?.library?.profileId;
    const profile = profileId ? release.libraryProfiles?.[profileId] : undefined;
    const kind = profile?.copies?.kinds.find((item) => item.id === 'physical');
    const status = kind?.statuses.find((item) => item.id === 'owned');
    const activeState = profile?.entryStateSet?.states.find((item) => item.role === 'active');
    requireFact(kind && status && activeState, 'installed Book profile lacks physical/owned and active entry choices');
    const subjectId = fixture.book.id;
    const noteA =
      'First personal holding.\n' +
      'The owner kept this long private note with its original edition and condition. '.repeat(11);
    const noteB =
      'Second personal holding.\n' +
      'This independent shelf and provenance belong only to this other physical copy. '.repeat(11);
    const firstCreate = await write(
      'firstCreate',
      'POST',
      '/v1/copies',
      {
        subjectId,
        kind: kind.id,
        status: status.id,
        location: 'Study',
        source: 'Bookshop',
        acquiredOn: '2024-02-29',
        note: noteA,
      },
      [201],
    );
    const secondCreate = await write(
      'secondCreate',
      'POST',
      '/v1/copies',
      { subjectId, kind: kind.id, status: status.id, location: 'Workshop', source: 'Gift', note: noteB },
      [201],
    );
    const firstId = copyOf(firstCreate).id,
      secondId = copyOf(secondCreate).id;
    requireFact(typeof firstId === 'string' && typeof secondId === 'string', 'native copy IDs absent');
    const firstPath = `/v1/copies/${encodeURIComponent(firstId)}`,
      secondPath = `/v1/copies/${encodeURIComponent(secondId)}`;
    const detail = (path: string) => `${path}?view=FULL&presentation=FULL`;
    const firstDetail = await read('firstDetail', detail(firstPath));
    await read('secondDetail', detail(secondPath));
    const editing = copyObject(copyObject(copyOf(firstDetail).presentation).statusEditing);
    if (editing.state === 'unavailable')
      unavailable(
        'currentAdvice',
        'Native detail returned statusEditing unavailable; accepted meaning is retained separately.',
        'GET /v1/copies/:copyId?presentation=FULL with available statusEditing',
        'firstDetail',
      );
    else {
      requireFact(
        editing.state === 'supported' || editing.state === 'unsupported',
        'native current Advice state absent',
      );
      // Alias the exact returned detail: never manufacture an Advice DTO.
      requireFact(outcomes.firstDetail.availability === 'produced', 'native detail binding absent');
      outcomes.currentAdvice = { ...outcomes.firstDetail, responseSource: 'firstDetail' };
    }
    await write(
      'firstEdit',
      'PATCH',
      firstPath,
      { revision: copyOf(firstCreate).revision, note: noteA + 'Edited first.' },
      [200],
      { scenario: 'firstCreate', revision: Number(copyOf(firstCreate).revision) },
    );
    await read('secondAfterFirstEdit', detail(secondPath));
    await write(
      'secondEdit',
      'PATCH',
      secondPath,
      { revision: copyOf(secondCreate).revision, note: noteB + 'Edited second.' },
      [200],
      { scenario: 'secondCreate', revision: Number(copyOf(secondCreate).revision) },
    );
    const firstEdited = await read('firstEditedDetail', detail(firstPath));
    await read('secondEditedDetail', detail(secondPath));
    await write(
      'staleEdit',
      'PATCH',
      firstPath,
      { revision: copyOf(firstCreate).revision, note: 'stale value must not replace note' },
      [409],
      { scenario: 'firstCreate', revision: Number(copyOf(firstCreate).revision) },
    );
    await send('createReplay', firstCreate.command, [201]);
    await send(
      'changedCreateIntent',
      {
        ...firstCreate.command,
        input: { ...copyObject(firstCreate.command.input), note: 'changed intent' },
        bodyText: JSON.stringify({ ...copyObject(firstCreate.command.input), note: 'changed intent' }),
      },
      [422],
    );
    const listPath = `/v1/copies?subjectId=${encodeURIComponent(subjectId)}&limit=1&view=FULL`;
    const firstPage = await read('listFirst', listPath);
    const cursor = copyObject(firstPage.response.body).next;
    requireFact(typeof cursor === 'string' && cursor.length > 0, 'real next cursor missing');
    await read('listFinal', `${listPath}&cursor=${encodeURIComponent(cursor)}`);
    await read('otherList', listPath);
    await read('otherDetail', detail(firstPath), [404]);
    await read('anonymousList', listPath, [401, 404]);
    await read('anonymousDetail', detail(firstPath), [401, 404]);
    await write(
      'unsupportedCreate',
      'POST',
      '/v1/copies',
      { subjectId: fixture.person.id, kind: kind.id, status: status.id },
      [422],
    );
    const entryPath = `/v1/libraryEntries/${encodeURIComponent(subjectId)}`;
    await write('entryCreate', 'PUT', entryPath, { state: activeState.id }, [201]);
    const progress = await write(
      'progressCreate',
      'POST',
      '/v1/progressSessions',
      { subjectId, mode: 'scalar_amount', unit: 'page', total: '300' },
      [201],
    );
    const session = copyObject(copyObject(progress.response.body).progressSession);
    requireFact(
      typeof session.id === 'string' && Number.isInteger(session.revision),
      'native progress identity absent',
    );
    const progressPath = `/v1/progressSessions/${encodeURIComponent(session.id)}`;
    await write(
      'progressRecord',
      'POST',
      `${progressPath}:record`,
      { revision: session.revision, amount: '37', note: 'Independent private reading note' },
      [200],
      { scenario: 'progressCreate', revision: Number(session.revision) },
    );
    await read('entryBefore', entryPath);
    await read('progressBefore', `${progressPath}?view=FULL`);
    const revision = copyOf(firstEdited).revision;
    requireFact(Number.isInteger(revision), 'current copy revision absent');
    const removal = await send(
      'remove',
      {
        method: 'DELETE',
        path: `${firstPath}?revision=${revision}`,
        persona: 'alice',
        idempotencyKey: `"${crypto.randomUUID()}"`,
        observed: { scenario: 'firstEditedDetail', revision: Number(revision) },
      },
      [204],
    );
    await read('removedDetail', detail(firstPath), [404]);
    const fullList = `/v1/copies?subjectId=${encodeURIComponent(subjectId)}&limit=100&view=FULL`;
    await read('listRemoved', fullList);
    await read('siblingRemoved', detail(secondPath));
    await read('entryRemoved', entryPath);
    await read('progressRemoved', `${progressPath}?view=FULL`);
    const deletionId = removal.response.headers['library-copy-deletion-id'];
    const removedRevision = removal.response.headers['library-copy-deletion-revision'];
    requireFact(
      deletionId && removedRevision && /^[1-9][0-9]*$/.test(removedRevision),
      'native removal receipt absent',
    );
    const undoInput = { deletionId, revision: Number(removedRevision) };
    await write('otherRestore', 'POST', `${firstPath}:restore`, undoInput, [404]);
    await write(
      'staleRestore',
      'POST',
      `${firstPath}:restore`,
      { ...undoInput, revision: undoInput.revision + 1 },
      [409],
    );
    const restore = await write('restore', 'POST', `${firstPath}:restore`, undoInput, [200], {
      scenario: 'remove',
      revision: undoInput.revision,
    });
    await send('restoreReplay', restore.command, [200]);
    await write('occupiedRestore', 'POST', `${firstPath}:restore`, undoInput, [409]);
    await send('removalReplay', removal.command, [204]);
    await read('restoredDetail', detail(firstPath));
    await read('siblingRestored', detail(secondPath));
    await read('entryRestored', entryPath);
    await read('progressRestored', `${progressPath}?view=FULL`);
    await read('listRestored', fullList);
    unavailable(
      'historicalAcceptedMeaning',
      'Installed profile-historical-native-fixture requires its own Pool, AccountActor and command runner; NativeHoldingsHistoryFixture exposes no compatible port. A new Copy is not a historical Copy.',
      'NativeHoldingsHistoryFixture.historical.copy(subjectId, status): original command/key plus actual HTTP replay and GET presentation=FULL on the same Auth owner',
    );
    unavailable(
      'expiredRestore',
      'No installed holdings clock/retention-expiry producer.',
      'NativeHoldingsHistoryFixture.expireCopyRetention(copyId): ordinary expired restore response',
    );
    unavailable(
      'terminalRestore',
      'No installed terminal-removal producer for holdings.',
      'NativeHoldingsHistoryFixture.terminalCopy(copyId): ordinary terminal restore response',
    );
    unavailable(
      'noJsOperation',
      'Installed holdings fixture has no reusable no-JavaScript Copy command driver. API admission is captured by the actual commands, not claimed as no-JavaScript execution.',
      'NativeHoldingsHistoryFixture.noJsCopyCommand(originalInput): actual form admission response without exporting CSRF/session credentials',
    );
    const manifest: NativeCopyManifest = {
      schema: 'native-copy-responses/v1',
      evidence: 'native-api-responses',
      currentDevRecording: false,
      rendered: false,
      identity: {
        ...source,
        runtime: {
          name: 'Bun',
          version: Bun.version,
          kernelOrigin: fixture.stack.kernelOrigin,
          webOrigin: fixture.stack.web,
        },
        build: {
          state: 'unknown',
          requiredInterface:
            'NativeWebStack.buildIdentity(): executable build ID bound to clean source revision and runtime',
        },
      },
      sourceAtEnd: gitSource(),
      subjectId,
      outcomes,
      sequence,
      routeStates: (Object.entries(nativeCopyScenarios) as [NativeCopyScenario, readonly [string, CopyPersona]][]).map(
        ([name, [state, persona]]) => ({
          route: `/en/library/copies?subjectId=${encodeURIComponent(subjectId)}`,
          state,
          persona,
          export: name,
          availability: outcomes[name].availability,
        }),
      ),
    };
    nativeManifests.add(manifest);
    assertNativeCopyResponses(manifest);
    return { manifest, close: () => fixture.close() };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
