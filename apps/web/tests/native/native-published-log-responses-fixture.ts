import { resolve } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  createNativeHoldingsHistoryFixture,
  type NativeHoldingsHistoryFixture,
} from './native-holdings-history-fixture.ts';

export const nativePublishedLogResponseHeaderAllowlist = [
  'cache-control',
  'content-type',
  'etag',
  'last-modified',
  'library-published-log-deletion-id',
  'library-published-log-deletion-revision',
  'library-published-log-revision',
  'retry-after',
  'www-authenticate',
] as const;

export type NativePublishedLogResponsePersona = 'alice' | 'bob' | 'anonymous';
export type NativePublishedLogReviewSurface = 'owner-log-history' | 'public-log-reader' | 'private-source' | 'publish-command';

type ScenarioDescriptor = Readonly<{
  surface: NativePublishedLogReviewSurface;
  state: string;
  persona: NativePublishedLogResponsePersona;
  availability: 'available' | 'unavailable';
  binding?: string;
}>;

/** Closed API evidence map for the existing owner-history and public-reader reviews. */
export const nativePublishedLogResponseScenarioManifest = {
  ownerHistoryBeforePublication: {
    surface: 'owner-log-history',
    state: 'empty-before-explicit-publication',
    persona: 'alice',
    availability: 'available',
  },
  otherHistoryEmpty: {
    surface: 'owner-log-history',
    state: 'empty-owner-history',
    persona: 'bob',
    availability: 'available',
  },
  sourceOwnerBeforeDelete: {
    surface: 'private-source',
    state: 'published-source-before-delete',
    persona: 'alice',
    availability: 'available',
  },
  sourceOtherBeforeDelete: {
    surface: 'private-source',
    state: 'published-source-before-delete',
    persona: 'bob',
    availability: 'available',
  },
  sourceAnonymousBeforeDelete: {
    surface: 'private-source',
    state: 'published-source-before-delete',
    persona: 'anonymous',
    availability: 'available',
  },
  publicOwnerBeforeDelete: {
    surface: 'public-log-reader',
    state: 'published-after-source-advance-before-delete',
    persona: 'alice',
    availability: 'available',
  },
  publicOtherBeforeDelete: {
    surface: 'public-log-reader',
    state: 'published-after-source-advance-before-delete',
    persona: 'bob',
    availability: 'available',
  },
  publicAnonymousBeforeDelete: {
    surface: 'public-log-reader',
    state: 'published-after-source-advance-before-delete',
    persona: 'anonymous',
    availability: 'available',
  },
  explicitPublicationResult: {
    surface: 'publish-command',
    state: 'explicit-publication-result',
    persona: 'alice',
    availability: 'available',
  },
  ownerHistoryFirstBeforeDelete: {
    surface: 'owner-log-history',
    state: 'first-page-before-delete',
    persona: 'alice',
    availability: 'available',
  },
  ownerHistoryFinalBeforeDelete: {
    surface: 'owner-log-history',
    state: 'final-page-before-delete',
    persona: 'alice',
    availability: 'available',
  },
  sourceOwnerWhileHidden: {
    surface: 'private-source',
    state: 'source-retained-while-public-log-hidden',
    persona: 'alice',
    availability: 'available',
  },
  sourceOtherWhileHidden: {
    surface: 'private-source',
    state: 'source-retained-while-public-log-hidden',
    persona: 'bob',
    availability: 'available',
  },
  sourceAnonymousWhileHidden: {
    surface: 'private-source',
    state: 'source-retained-while-public-log-hidden',
    persona: 'anonymous',
    availability: 'available',
  },
  publicOwnerWhileHidden: {
    surface: 'public-log-reader',
    state: 'deleted-log-hidden',
    persona: 'alice',
    availability: 'available',
  },
  publicOtherWhileHidden: {
    surface: 'public-log-reader',
    state: 'deleted-log-hidden',
    persona: 'bob',
    availability: 'available',
  },
  publicAnonymousWhileHidden: {
    surface: 'public-log-reader',
    state: 'deleted-log-hidden',
    persona: 'anonymous',
    availability: 'available',
  },
  ownerHistoryWhileHidden: {
    surface: 'owner-log-history',
    state: 'final-page-while-log-hidden',
    persona: 'alice',
    availability: 'available',
  },
  ordinaryRestoreResult: {
    surface: 'publish-command',
    state: 'exact-ordinary-restore-result',
    persona: 'alice',
    availability: 'available',
  },
  sourceOwnerAfterRestore: {
    surface: 'private-source',
    state: 'source-after-actual-restore',
    persona: 'alice',
    availability: 'available',
  },
  sourceOtherAfterRestore: {
    surface: 'private-source',
    state: 'source-after-actual-restore',
    persona: 'bob',
    availability: 'available',
  },
  sourceAnonymousAfterRestore: {
    surface: 'private-source',
    state: 'source-after-actual-restore',
    persona: 'anonymous',
    availability: 'available',
  },
  publicOwnerAfterRestore: {
    surface: 'public-log-reader',
    state: 'visible-after-actual-restore',
    persona: 'alice',
    availability: 'available',
  },
  publicOtherAfterRestore: {
    surface: 'public-log-reader',
    state: 'visible-after-actual-restore',
    persona: 'bob',
    availability: 'available',
  },
  publicAnonymousAfterRestore: {
    surface: 'public-log-reader',
    state: 'visible-after-actual-restore',
    persona: 'anonymous',
    availability: 'available',
  },
  ownerHistoryFirstAfterRestore: {
    surface: 'owner-log-history',
    state: 'first-page-after-actual-restore',
    persona: 'alice',
    availability: 'available',
  },
  ownerHistoryFinalAfterRestore: {
    surface: 'owner-log-history',
    state: 'final-page-after-actual-restore',
    persona: 'alice',
    availability: 'available',
  },
  restoreOccupied: {
    surface: 'public-log-reader',
    state: 'restore-occupied-conflict',
    persona: 'alice',
    availability: 'available',
  },
  restoreStale: {
    surface: 'public-log-reader',
    state: 'restore-stale-receipt-conflict',
    persona: 'alice',
    availability: 'available',
  },
  restoreExpired: {
    surface: 'public-log-reader',
    state: 'restore-expired',
    persona: 'alice',
    availability: 'unavailable',
    binding: 'No supported native clock and retention workflow in this fixture can advance a real deletion beyond its restore window.',
  },
  restoreHistorical: {
    surface: 'public-log-reader',
    state: 'restore-historical-source',
    persona: 'alice',
    availability: 'unavailable',
    binding: 'No supported native command in this fixture can detach or destroy the private source while retaining the public snapshot.',
  },
} as const satisfies Readonly<Record<string, ScenarioDescriptor>>;

export type NativePublishedLogResponseScenario = keyof typeof nativePublishedLogResponseScenarioManifest;

export type NativePublishedLogCommand = Readonly<{
  sequence: number;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  persona: NativePublishedLogResponsePersona;
  input: Readonly<{
    body?: unknown;
    bodyText: string | null;
    idempotencyKey: string | null;
  }>;
}>;

export type NativePublishedLogResponse = Readonly<{
  method: NativePublishedLogCommand['method'];
  path: string;
  persona: NativePublishedLogResponsePersona;
  status: number;
  body: unknown;
  bodyText: string;
  headers: Readonly<Record<string, string>>;
}>;

export type NativePublishedLogCall = Readonly<{
  sequence: number;
  command: NativePublishedLogCommand;
  response: NativePublishedLogResponse;
}>;

export type NativePublishedLogScenarioResult =
  | Readonly<{ availability: 'available'; callSequence: number }>
  | Readonly<{ availability: 'unavailable'; binding: string }>;

export type NativePublishedLogResponseManifest = Readonly<{
  identity: Readonly<{
    source: Readonly<{ repository: 'rezics'; revision: string | null; clean: boolean }>;
    build: Readonly<{ id: string | null; runtime: 'Bun'; runtimeVersion: string; definitionsDigest: string }>;
  }>;
  ids: Readonly<{
    subjectId: string;
    aliceAccountId: string;
    bobAccountId: string;
    sourceSessionId: string;
    publishedLogId: string;
    generatedLogIds: readonly string[];
  }>;
  commandKeys: Readonly<Record<string, string>>;
  observedRevisions: Readonly<Record<string, number>>;
  calls: readonly NativePublishedLogCall[];
  scenarios: Readonly<Record<NativePublishedLogResponseScenario, NativePublishedLogScenarioResult>>;
}>;

export type NativePublishedLogResponseFixture = Readonly<{
  manifest: NativePublishedLogResponseManifest;
  close(): Promise<void>;
}>;

type Persona = NativePublishedLogResponsePersona;
type Method = NativePublishedLogCommand['method'];
type MutableScenarios = Record<NativePublishedLogResponseScenario, NativePublishedLogScenarioResult>;

const historyLimit = 100;
const longNote = 'N'.repeat(1000);
const pageNote = (index: number) => `Native published-log history ${String(index + 1).padStart(3, '0')}`;
const idempotencyKey = () => `"${crypto.randomUUID()}"`;

function responseBodyRecord(response: NativePublishedLogResponse, label: string): Record<string, unknown> {
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body))
    throw new Error(`${label} did not return a JSON object: ${response.bodyText}`);
  return response.body as Record<string, unknown>;
}

function nestedRecord(value: unknown, key: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was not an object`);
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw new Error(`${label}.${key} was not an object`);
  return nested as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} was absent`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} was not a positive integer`);
  return value;
}

function parseResponseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function requiredHeader(call: NativePublishedLogCall, name: (typeof nativePublishedLogResponseHeaderAllowlist)[number]): string {
  return requiredString(call.response.headers[name], `Native ${call.command.method} ${call.command.path} ${name}`);
}

function headerInteger(call: NativePublishedLogCall, name: (typeof nativePublishedLogResponseHeaderAllowlist)[number]): number {
  const value = Number(requiredHeader(call, name));
  return requiredInteger(value, `Native ${call.command.method} ${call.command.path} ${name}`);
}

function requireStatus(call: NativePublishedLogCall, status: number, label: string): void {
  if (call.response.status !== status)
    throw new Error(`${label} returned ${call.response.status}: ${call.response.bodyText}`);
}

function bodyValue(call: NativePublishedLogCall, outer: string, field: string, label: string): unknown {
  return nestedRecord(call.response.body, outer, label)[field];
}

function nextCursor(call: NativePublishedLogCall, label: string): string {
  const value = responseBodyRecord(call.response, label).next;
  return requiredString(value, `${label}.next`);
}

function historyPath(accountId: string, cursor?: string): string {
  const query = new URLSearchParams({ accountId, limit: String(historyLimit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/v1/publishedLogs?${query.toString()}`;
}

async function nativeIdentity(): Promise<NativePublishedLogResponseManifest['identity']> {
  const root = resolve(import.meta.dir, '../../../..');
  const revisionResult = Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: root });
  const statusResult = Bun.spawnSync({ cmd: ['git', 'status', '--porcelain'], cwd: root });
  const revisionText = revisionResult.exitCode === 0 ? revisionResult.stdout.toString().trim() : '';
  const revision = /^[0-9a-f]{40}$/i.test(revisionText) ? revisionText : null;
  const clean =
    revision !== null && statusResult.exitCode === 0 && statusResult.stdout.toString().trim().length === 0;
  return {
    source: { repository: 'rezics', revision, clean },
    build: {
      id: clean && revision ? `native-production-web-worker:${revision}:${bundledDigest}` : null,
      runtime: 'Bun',
      runtimeVersion: Bun.version,
      definitionsDigest: bundledDigest,
    },
  };
}

export async function createNativePublishedLogResponseFixture(): Promise<NativePublishedLogResponseFixture> {
  const fixture: NativeHoldingsHistoryFixture = await createNativeHoldingsHistoryFixture();
  try {
    const identity = await nativeIdentity();
    const calls: NativePublishedLogCall[] = [];
    const scenarioResults = {} as MutableScenarios;

    const recordScenario = (scenario: NativePublishedLogResponseScenario, call: NativePublishedLogCall) => {
      if (scenarioResults[scenario]) throw new Error(`Native scenario ${scenario} was recorded more than once`);
      scenarioResults[scenario] = { availability: 'available', callSequence: call.sequence };
      return call;
    };

    const perform = async (
      method: Method,
      path: string,
      persona: Persona,
      input: { body?: unknown; idempotencyKey?: string } = {},
    ): Promise<NativePublishedLogCall> => {
      const bodyText = input.body === undefined ? null : JSON.stringify(input.body);
      const headers = new Headers();
      if (bodyText !== null) headers.set('content-type', 'application/json');
      if (input.idempotencyKey !== undefined) headers.set('idempotency-key', input.idempotencyKey);
      const response = await fixture.stack.kernel(
        path,
        {
          method,
          headers,
          ...(bodyText === null ? {} : { body: bodyText }),
        },
        persona === 'anonymous' ? undefined : persona,
      );
      const actualUrl = new URL(response.url);
      const actualPath = `${actualUrl.pathname}${actualUrl.search}`;
      if (actualPath !== path)
        throw new Error(`Native ${method} response URL ${actualPath} did not preserve request path ${path}`);
      const rawBodyText = await response.text();
      const responseHeaders: Record<string, string> = {};
      for (const name of nativePublishedLogResponseHeaderAllowlist) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      const sequence = calls.length;
      const command: NativePublishedLogCommand = {
        sequence,
        method,
        path,
        persona,
        input: {
          ...(bodyText === null ? {} : { body: JSON.parse(bodyText) as unknown }),
          bodyText,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      };
      const responseFact: NativePublishedLogResponse = {
        method,
        path,
        persona,
        status: response.status,
        body: parseResponseBody(rawBodyText),
        bodyText: rawBodyText,
        headers: responseHeaders,
      };
      const call = { sequence, command, response: responseFact } satisfies NativePublishedLogCall;
      calls.push(call);
      return call;
    };

    const keys: Record<string, string> = {};
    const revisions: Record<string, number> = {};
    const { accountId: aliceAccountId } = await fixture.stack.authPersona('alice');
    const { accountId: bobAccountId } = await fixture.stack.authPersona('bob');
    const subjectId = fixture.book.id;

    const initialHistory = await perform('GET', historyPath(aliceAccountId), 'alice');
    requireStatus(initialHistory, 200, 'Alice history before publication');
    recordScenario('ownerHistoryBeforePublication', initialHistory);

    const otherEmptyHistory = await perform('GET', historyPath(bobAccountId), 'bob');
    requireStatus(otherEmptyHistory, 200, 'Bob empty owner history');
    recordScenario('otherHistoryEmpty', otherEmptyHistory);

    keys.createSourceSession = idempotencyKey();
    const createSource = await perform('POST', '/v1/progressSessions', 'alice', {
      body: { subjectId, mode: 'scalar_amount', unit: 'page', total: '300' },
      idempotencyKey: keys.createSourceSession,
    });
    requireStatus(createSource, 201, 'Private source session creation');
    const sourceSessionId = requiredString(
      bodyValue(createSource, 'progressSession', 'id', 'Private source session creation'),
      'Private source session id',
    );
    revisions.sourceCreated = requiredInteger(
      nestedRecord(createSource.response.body, 'progressSession', 'Private source session creation').revision,
      'Private source initial revision',
    );

    keys.recordSourceProgress = idempotencyKey();
    const recordSource = await perform('POST', `/v1/progressSessions/${encodeURIComponent(sourceSessionId)}:record`, 'alice', {
      body: { revision: revisions.sourceCreated, amount: '125' },
      idempotencyKey: keys.recordSourceProgress,
    });
    requireStatus(recordSource, 200, 'Private source progress recording');
    revisions.sourceCurrent = requiredInteger(
      nestedRecord(recordSource.response.body, 'progressSession', 'Private source progress recording').revision,
      'Private source current revision',
    );

    keys.publish = idempotencyKey();
    const publication = await perform('POST', '/v1/publishedLogs', 'alice', {
      body: { sessionId: sourceSessionId, note: longNote },
      idempotencyKey: keys.publish,
    });
    requireStatus(publication, 201, 'Explicit published-log command');
    recordScenario('explicitPublicationResult', publication);
    const publishedLogId = requiredString(
      bodyValue(publication, 'publishedLog', 'id', 'Explicit published-log command'),
      'Published log id',
    );
    revisions.published = headerInteger(publication, 'library-published-log-revision');

    keys.advanceSourceAfterPublish = idempotencyKey();
    const advanceSource = await perform(
      'POST',
      `/v1/progressSessions/${encodeURIComponent(sourceSessionId)}:record`,
      'alice',
      {
        body: { revision: revisions.sourceCurrent, amount: '150' },
        idempotencyKey: keys.advanceSourceAfterPublish,
      },
    );
    requireStatus(advanceSource, 200, 'Private source advance after publication');
    revisions.sourceAfterPublish = requiredInteger(
      nestedRecord(advanceSource.response.body, 'progressSession', 'Private source advance after publication').revision,
      'Private source revision after publication',
    );

    const sourceDetailPath = `/v1/progressSessions/${encodeURIComponent(sourceSessionId)}?view=FULL`;

    const publicPath = `/v1/publishedLogs/${encodeURIComponent(publishedLogId)}`;
    for (const [persona, scenario] of [
      ['alice', 'publicOwnerBeforeDelete'],
      ['bob', 'publicOtherBeforeDelete'],
      ['anonymous', 'publicAnonymousBeforeDelete'],
    ] as const) {
      const call = await perform('GET', publicPath, persona);
      requireStatus(call, 200, `Public log before deletion for ${persona}`);
      recordScenario(scenario, call);
    }

    for (const [persona, scenario] of [
      ['alice', 'sourceOwnerBeforeDelete'],
      ['bob', 'sourceOtherBeforeDelete'],
      ['anonymous', 'sourceAnonymousBeforeDelete'],
    ] as const) {
      const call = await perform('GET', sourceDetailPath, persona);
      if (persona === 'alice') requireStatus(call, 200, 'Owner private source before delete');
      recordScenario(scenario, call);
    }

    const generatedLogIds: string[] = [];
    for (let index = 0; index < historyLimit; index += 1) {
      const createKey = idempotencyKey();
      const sessionCall = await perform('POST', '/v1/progressSessions', 'alice', {
        body: { subjectId, mode: 'scalar_amount', unit: 'page', total: null },
        idempotencyKey: createKey,
      });
      requireStatus(sessionCall, 201, `History source session ${index + 1}`);
      const sessionId = requiredString(
        bodyValue(sessionCall, 'progressSession', 'id', `History source session ${index + 1}`),
        `History source session ${index + 1} id`,
      );
      const publishKey = idempotencyKey();
      const logCall = await perform('POST', '/v1/publishedLogs', 'alice', {
        body: { sessionId, note: pageNote(index) },
        idempotencyKey: publishKey,
      });
      requireStatus(logCall, 201, `History publication ${index + 1}`);
      generatedLogIds.push(
        requiredString(
          bodyValue(logCall, 'publishedLog', 'id', `History publication ${index + 1}`),
          `History publication ${index + 1} id`,
        ),
      );
    }

    const historyBeforeFirst = await perform('GET', historyPath(aliceAccountId), 'alice');
    requireStatus(historyBeforeFirst, 200, 'Owner history first page before delete');
    recordScenario('ownerHistoryFirstBeforeDelete', historyBeforeFirst);
    const beforeCursor = nextCursor(historyBeforeFirst, 'Owner history first page before delete');
    const historyBeforeFinal = await perform('GET', historyPath(aliceAccountId, beforeCursor), 'alice');
    requireStatus(historyBeforeFinal, 200, 'Owner history final page before delete');
    recordScenario('ownerHistoryFinalBeforeDelete', historyBeforeFinal);
    if (responseBodyRecord(historyBeforeFinal.response, 'Owner history final page before delete').next !== null)
      throw new Error('Native owner history continuation was not final');

    keys.delete = idempotencyKey();
    const deletion = await perform('DELETE', `${publicPath}?revision=${revisions.published}`, 'alice', {
      idempotencyKey: keys.delete,
    });
    requireStatus(deletion, 200, 'Native published-log deletion');
    const deletionId = requiredHeader(deletion, 'library-published-log-deletion-id');
    revisions.deleted = headerInteger(deletion, 'library-published-log-deletion-revision');

    for (const [persona, scenario] of [
      ['alice', 'publicOwnerWhileHidden'],
      ['bob', 'publicOtherWhileHidden'],
      ['anonymous', 'publicAnonymousWhileHidden'],
    ] as const) {
      recordScenario(scenario, await perform('GET', publicPath, persona));
    }

    for (const [persona, scenario] of [
      ['alice', 'sourceOwnerWhileHidden'],
      ['bob', 'sourceOtherWhileHidden'],
      ['anonymous', 'sourceAnonymousWhileHidden'],
    ] as const) {
      recordScenario(scenario, await perform('GET', sourceDetailPath, persona));
    }

    const hiddenHistory = await perform('GET', historyPath(aliceAccountId), 'alice');
    requireStatus(hiddenHistory, 200, 'Owner history while published log is hidden');
    recordScenario('ownerHistoryWhileHidden', hiddenHistory);
    if (responseBodyRecord(hiddenHistory.response, 'Owner history while published log is hidden').next !== null)
      throw new Error('Native hidden owner history page was not final');

    const ordinaryRestoreBody = { deletionId, revision: revisions.deleted };
    keys.restore = idempotencyKey();
    const restore = await perform('POST', `${publicPath}:restore`, 'alice', {
      body: ordinaryRestoreBody,
      idempotencyKey: keys.restore,
    });
    requireStatus(restore, 200, 'Exact ordinary published-log restore');
    recordScenario('ordinaryRestoreResult', restore);
    revisions.restored = headerInteger(restore, 'library-published-log-revision');

    for (const [persona, scenario] of [
      ['alice', 'publicOwnerAfterRestore'],
      ['bob', 'publicOtherAfterRestore'],
      ['anonymous', 'publicAnonymousAfterRestore'],
    ] as const) {
      const call = await perform('GET', publicPath, persona);
      requireStatus(call, 200, `Public log after restore for ${persona}`);
      recordScenario(scenario, call);
    }

    for (const [persona, scenario] of [
      ['alice', 'sourceOwnerAfterRestore'],
      ['bob', 'sourceOtherAfterRestore'],
      ['anonymous', 'sourceAnonymousAfterRestore'],
    ] as const) {
      recordScenario(scenario, await perform('GET', sourceDetailPath, persona));
    }

    const historyAfterFirst = await perform('GET', historyPath(aliceAccountId), 'alice');
    requireStatus(historyAfterFirst, 200, 'Owner history first page after restore');
    recordScenario('ownerHistoryFirstAfterRestore', historyAfterFirst);
    const afterCursor = nextCursor(historyAfterFirst, 'Owner history first page after restore');
    const historyAfterFinal = await perform('GET', historyPath(aliceAccountId, afterCursor), 'alice');
    requireStatus(historyAfterFinal, 200, 'Owner history final page after restore');
    recordScenario('ownerHistoryFinalAfterRestore', historyAfterFinal);
    if (responseBodyRecord(historyAfterFinal.response, 'Owner history final page after restore').next !== null)
      throw new Error('Native restored owner history continuation was not final');

    keys.occupiedRestore = idempotencyKey();
    const occupiedRestore = await perform('POST', `${publicPath}:restore`, 'alice', {
      body: ordinaryRestoreBody,
      idempotencyKey: keys.occupiedRestore,
    });
    requireStatus(occupiedRestore, 409, 'Restore while the original published log is already visible');
    recordScenario('restoreOccupied', occupiedRestore);

    keys.deleteAgain = idempotencyKey();
    const secondDeletion = await perform('DELETE', `${publicPath}?revision=${revisions.restored}`, 'alice', {
      idempotencyKey: keys.deleteAgain,
    });
    requireStatus(secondDeletion, 200, 'Second native published-log deletion for stale-receipt case');
    const secondDeletionId = requiredHeader(secondDeletion, 'library-published-log-deletion-id');
    revisions.deletedAgain = headerInteger(secondDeletion, 'library-published-log-deletion-revision');

    keys.staleRestore = idempotencyKey();
    const staleRestore = await perform('POST', `${publicPath}:restore`, 'alice', {
      body: ordinaryRestoreBody,
      idempotencyKey: keys.staleRestore,
    });
    requireStatus(staleRestore, 409, 'Restore using the earlier deletion receipt after a newer deletion');
    recordScenario('restoreStale', staleRestore);

    keys.finalRestore = idempotencyKey();
    const finalRestore = await perform('POST', `${publicPath}:restore`, 'alice', {
      body: { deletionId: secondDeletionId, revision: revisions.deletedAgain },
      idempotencyKey: keys.finalRestore,
    });
    requireStatus(finalRestore, 200, 'Restore using the current second deletion receipt');
    revisions.finalRestore = headerInteger(finalRestore, 'library-published-log-revision');

    scenarioResults.restoreExpired = {
      availability: 'unavailable',
      binding: nativePublishedLogResponseScenarioManifest.restoreExpired.binding!,
    };
    scenarioResults.restoreHistorical = {
      availability: 'unavailable',
      binding: nativePublishedLogResponseScenarioManifest.restoreHistorical.binding!,
    };

    for (const [name, descriptor] of Object.entries(nativePublishedLogResponseScenarioManifest)) {
      const scenario = name as NativePublishedLogResponseScenario;
      if (!scenarioResults[scenario])
        throw new Error(`Native published-log response scenario ${scenario} was not bound to a command`);
      if (descriptor.availability !== scenarioResults[scenario].availability)
        throw new Error(`Native scenario ${scenario} did not match its declared availability`);
    }

    return {
      manifest: {
        identity,
        ids: {
          subjectId,
          aliceAccountId,
          bobAccountId,
          sourceSessionId,
          publishedLogId,
          generatedLogIds,
        },
        commandKeys: keys,
        observedRevisions: revisions,
        calls,
        scenarios: scenarioResults,
      },
      close: () => fixture.close(),
    };
  } catch (error) {
    await fixture.close().catch(() => {});
    throw error;
  }
}
