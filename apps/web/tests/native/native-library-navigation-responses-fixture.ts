import { expect } from 'bun:test';
import { resolve } from 'node:path';
import type { AuthJourney, NativeAuthStack } from './auth-stack.ts';
import { createLibraryEntry, createLibraryNavigationFixture } from './library-navigation-fixture.ts';
import type { NativeWebStack } from './stack.ts';

export const nativeLibraryNavigationResponseScenarioManifest = [
  {
    id: 'collections.alice.owner',
    routeState: 'my-collections',
    persona: 'alice',
    owner: 'alice',
    pathTemplate: '/v1/collections?curatorAccountId={alice.accountId}&limit=100',
  },
  {
    id: 'collections.alice.viewer',
    routeState: 'my-collections',
    persona: 'bob',
    owner: 'alice',
    pathTemplate: '/v1/collections?curatorAccountId={alice.accountId}&limit=100',
  },
  {
    id: 'collections.bob.owner',
    routeState: 'my-collections',
    persona: 'bob',
    owner: 'bob',
    pathTemplate: '/v1/collections?curatorAccountId={bob.accountId}&limit=100',
  },
  {
    id: 'collections.bob.viewer',
    routeState: 'my-collections',
    persona: 'alice',
    owner: 'bob',
    pathTemplate: '/v1/collections?curatorAccountId={bob.accountId}&limit=100',
  },
  {
    id: 'pins.alice.owner',
    routeState: 'library-pins',
    persona: 'alice',
    owner: 'alice',
    pathTemplate: '/v1/libraryPins?limit=100',
  },
  {
    id: 'pins.bob.owner',
    routeState: 'library-pins',
    persona: 'bob',
    owner: 'bob',
    pathTemplate: '/v1/libraryPins?limit=100',
  },
  {
    id: 'entry.alice.owner',
    routeState: 'private-library-entry',
    persona: 'alice',
    owner: 'alice',
    pathTemplate: '/v1/libraryEntries/{alice.subjectId}',
  },
  {
    id: 'entry.alice.viewer',
    routeState: 'private-library-entry',
    persona: 'bob',
    owner: 'alice',
    pathTemplate: '/v1/libraryEntries/{alice.subjectId}',
  },
  {
    id: 'members.everything.bob',
    routeState: 'everything-first-page',
    persona: 'bob',
    owner: 'bob',
    pathTemplate: '/v1/collections/{everything.id}/members?limit=20',
  },
  {
    id: 'page.library.alice',
    routeState: 'library-page',
    persona: 'alice',
    path: '/en/library',
  },
  {
    id: 'page.library.bob',
    routeState: 'library-page',
    persona: 'bob',
    path: '/en/library',
  },
  {
    id: 'page.my-collections.alice',
    routeState: 'my-collections-page',
    persona: 'alice',
    path: '/en/library/collections',
  },
  {
    id: 'page.my-collections.bob',
    routeState: 'my-collections-page',
    persona: 'bob',
    path: '/en/library/collections',
  },
] as const;

export type NativeLibraryNavigationScenarioId =
  (typeof nativeLibraryNavigationResponseScenarioManifest)[number]['id'];
export type NativeLibraryNavigationPersona = 'alice' | 'bob';
export type NativeLibraryNavigationScenarioState =
  | 'available'
  | 'preparing'
  | 'denied'
  | 'unavailable'
  | 'dependency_unavailable';

const responseHeaderAllowlist = [
  'cache-control',
  'content-type',
  'etag',
  'link',
  'location',
  'retry-after',
  'vary',
] as const;

export type NativeLibraryNavigationRawResponse = {
  id: string;
  commandId: string;
  method: string;
  path: string;
  persona: string;
  status: number;
  body: unknown;
  bodyText: string;
  headers: Partial<Record<(typeof responseHeaderAllowlist)[number], string>>;
};

export type NativeLibraryNavigationCommandInput = {
  id: string;
  sequence: number;
  method: string;
  path: string;
  persona: string;
  headers: { 'content-type'?: string; 'idempotency-key'?: string };
  bodyText?: string;
};

export type NativeLibraryNavigationObservedRevision = {
  commandId: string;
  responseId: string;
  field: 'body.revision';
  value: number;
};

export type NativeLibraryNavigationDestination = {
  id: string;
  persona: NativeLibraryNavigationPersona;
  pagePath: string;
  href: string;
  text: string;
};

export type NativeLibraryNavigationScenarioExport = {
  scenarioId: NativeLibraryNavigationScenarioId;
  state: NativeLibraryNavigationScenarioState;
  responseIds: string[];
  destinationIds: string[];
};

export type NativeLibraryNavigationResponseFixture = {
  binding: {
    sourceCommit: string | null;
    sourceTreeClean: boolean | null;
    sourceIdentity: 'known' | 'unknown';
    currentDevRecording: boolean;
    runtime: {
      producer: 'startNativeWebStack + startAuthStack';
      webOrigin: string;
      authOrigin: string;
      mode: 'worktree-dev';
    };
  };
  manifest: typeof nativeLibraryNavigationResponseScenarioManifest;
  commands: NativeLibraryNavigationCommandInput[];
  observedRevisions: NativeLibraryNavigationObservedRevision[];
  responses: NativeLibraryNavigationRawResponse[];
  scenarios: NativeLibraryNavigationScenarioExport[];
  destinations: NativeLibraryNavigationDestination[];
  identities: {
    persona: NativeLibraryNavigationPersona;
    ownerAccountId: string;
    descriptorId: string;
    builtinKind?: string;
    title?: string | null;
  }[];
  fixtureFacts: {
    publicCollectionId: string;
    privateCollectionId: string;
    aliceSubjectId: string;
    bobSubjectId: string;
  };
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function statusState(status: number): NativeLibraryNavigationScenarioState {
  if (status === 200 || status === 201) return 'available';
  if (status === 202) return 'preparing';
  if (status === 403 || status === 404) return 'denied';
  return 'unavailable';
}

function getResponseHeaders(headers: Headers): NativeLibraryNavigationRawResponse['headers'] {
  const selected: NativeLibraryNavigationRawResponse['headers'] = {};
  for (const name of responseHeaderAllowlist) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

function revisionOf(body: unknown): number | undefined {
  return isRecord(body) && typeof body.revision === 'number' ? body.revision : undefined;
}

function listRows(body: unknown, key: string): JsonRecord[] {
  if (!isRecord(body) || !Array.isArray(body[key])) return [];
  return body[key].filter(isRecord);
}

function scenario(
  scenarioId: NativeLibraryNavigationScenarioId,
  state: NativeLibraryNavigationScenarioState,
  responseIds: string[] = [],
  destinationIds: string[] = [],
): NativeLibraryNavigationScenarioExport {
  return { scenarioId, state, responseIds, destinationIds };
}

function repositoryRoot(): string {
  return resolve(import.meta.dir, '../../../..');
}

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: repositoryRoot(), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0)
    throw new Error(`Could not read native fixture source identity: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function sourceBinding(stack: NativeWebStack, auth: NativeAuthStack): NativeLibraryNavigationResponseFixture['binding'] {
  let sourceCommit: string | null = null;
  let sourceTreeClean: boolean | null = null;
  let sourceIdentity: 'known' | 'unknown' = 'unknown';
  try {
    const sourceRoot = gitOutput(['rev-parse', '--show-toplevel']);
    if (resolve(sourceRoot) === repositoryRoot()) {
      sourceCommit = gitOutput(['rev-parse', 'HEAD']);
      sourceTreeClean = gitOutput(['status', '--porcelain', '--untracked-files=all']) === '';
      sourceIdentity = 'known';
    }
  } catch {
    // Frozen check workspaces may not carry the candidate's Git metadata.
  }
  return {
    sourceCommit,
    sourceTreeClean,
    sourceIdentity,
    currentDevRecording:
      sourceIdentity === 'known' &&
      sourceTreeClean === true &&
      sourceCommit !== null &&
      /^[0-9a-f]{40}$/u.test(sourceCommit),
    runtime: {
      producer: 'startNativeWebStack + startAuthStack',
      webOrigin: stack.web,
      authOrigin: auth.origin,
      mode: 'worktree-dev',
    },
  };
}

function recordingStack(
  stack: NativeWebStack,
  commands: NativeLibraryNavigationCommandInput[],
  responses: NativeLibraryNavigationRawResponse[],
  observedRevisions: NativeLibraryNavigationObservedRevision[],
): NativeWebStack {
  return new Proxy(stack, {
    get(target, property, receiver) {
      if (property !== 'kernel') return Reflect.get(target, property, receiver) as unknown;
      return async (path: string, init: RequestInit = {}, persona = 'system'): Promise<Response> => {
        const sequence = commands.length;
        const id = `command-${sequence}`;
        const headers = new Headers(init.headers);
        const method = init.method ?? 'GET';
        const command: NativeLibraryNavigationCommandInput = {
          id,
          sequence,
          method,
          path,
          persona,
          headers: {
            ...(headers.get('content-type') === null ? {} : { 'content-type': headers.get('content-type')! }),
            ...(headers.get('idempotency-key') === null
              ? {}
              : { 'idempotency-key': headers.get('idempotency-key')! }),
          },
          ...(typeof init.body === 'string' ? { bodyText: init.body } : {}),
        };
        commands.push(command);
        const response = await target.kernel(path, init, persona);
        if (/^\/v1\/(?:collections(?:[/?]|$)|libraryPins(?:[/?]|$)|libraryEntries(?:[/?]|$))/u.test(path)) {
          const bodyText = await response.clone().text();
          const body = parseBody(bodyText);
          const responseId = `response-${sequence}`;
          responses.push({
            id: responseId,
            commandId: id,
            method,
            path,
            persona,
            status: response.status,
            body,
            bodyText,
            headers: getResponseHeaders(response.headers),
          });
          const revision = revisionOf(body);
          if (revision !== undefined)
            observedRevisions.push({ commandId: id, responseId, field: 'body.revision', value: revision });
        }
        return response;
      };
    },
  });
}

function responseFor(
  responses: NativeLibraryNavigationRawResponse[],
  method: string,
  path: string,
  persona: string,
): NativeLibraryNavigationRawResponse {
  const response = responses
    .filter((item) => item.method === method && item.path === path && item.persona === persona)
    .at(-1);
  if (!response) throw new Error(`Native response was not captured for ${persona} ${method} ${path}`);
  return response;
}

async function pageDestinations(
  journey: AuthJourney,
  stack: NativeWebStack,
  persona: NativeLibraryNavigationPersona,
  pagePath: string,
  idPrefix: string,
  destinations: NativeLibraryNavigationDestination[],
): Promise<string[]> {
  const page = journey.context.pages().at(-1)!;
  await page.goto(`${stack.web}${pagePath}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  const links = await page.locator('a[href]').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      text: anchor.textContent ?? '',
    })),
  );
  const ids: string[] = [];
  for (const [index, link] of links.entries()) {
    if (!link.href.startsWith('/')) continue;
    const id = `${idPrefix}.destination-${index}`;
    destinations.push({ id, persona, pagePath, href: link.href, text: link.text });
    ids.push(id);
  }
  return ids;
}

export async function createNativeLibraryNavigationResponsesFixture(
  stack: NativeWebStack,
  auth: NativeAuthStack,
): Promise<NativeLibraryNavigationResponseFixture> {
  const binding = sourceBinding(stack, auth);
  const commands: NativeLibraryNavigationCommandInput[] = [];
  const responses: NativeLibraryNavigationRawResponse[] = [];
  const observedRevisions: NativeLibraryNavigationObservedRevision[] = [];
  const native = recordingStack(stack, commands, responses, observedRevisions);

  const fixture = await createLibraryNavigationFixture(native);
  const aliceSubject = await createLibraryEntry(native, 'alice', fixture.owner.authorization);
  const privateKey = crypto.randomUUID();
  const privateCollectionResponse = await native.kernel(
    '/v1/collections',
    {
      method: 'POST',
      headers: {
        authorization: fixture.owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': privateKey,
      },
      body: JSON.stringify({ title: 'Native private navigation list', visibility: 'private' }),
    },
    'alice',
  );
  expect(privateCollectionResponse.status, 'Alice creates a private list through the native Collection API').toBe(201);
  const privateCollectionBody = (await privateCollectionResponse.json()) as { collection: { id: string } };
  const privateCollectionId = privateCollectionBody.collection.id;

  const collectionPath = (accountId: string) =>
    `/v1/collections?curatorAccountId=${encodeURIComponent(accountId)}&limit=100`;
  const aliceCollectionsPath = collectionPath(fixture.owner.accountId);
  const bobCollectionsPath = collectionPath(fixture.reader.accountId);
  const pinsPath = '/v1/libraryPins?limit=100';
  const aliceEntryPath = `/v1/libraryEntries/${encodeURIComponent(aliceSubject.id)}`;

  const getAs = async (path: string, persona: 'alice' | 'bob', authorization: string) =>
    native.kernel(path, { headers: { authorization } }, persona);

  const collectionReads = await Promise.all([
    getAs(aliceCollectionsPath, 'alice', fixture.owner.authorization),
    getAs(aliceCollectionsPath, 'bob', fixture.reader.authorization),
    getAs(bobCollectionsPath, 'bob', fixture.reader.authorization),
    getAs(bobCollectionsPath, 'alice', fixture.owner.authorization),
  ]);
  expect(collectionReads[0]!.status).toBe(200);
  expect(collectionReads[2]!.status).toBe(200);

  const pinReads = await Promise.all([
    getAs(pinsPath, 'alice', fixture.owner.authorization),
    getAs(pinsPath, 'bob', fixture.reader.authorization),
  ]);
  expect(pinReads[0]!.status).toBe(200);
  expect(pinReads[1]!.status).toBe(200);

  const entryReads = await Promise.all([
    getAs(aliceEntryPath, 'alice', fixture.owner.authorization),
    getAs(aliceEntryPath, 'bob', fixture.reader.authorization),
  ]);
  expect(entryReads[0]!.status).toBe(200);

  const bobCollectionsBody = responses.find(
    (item) => item.method === 'GET' && item.path === bobCollectionsPath && item.persona === 'bob',
  )?.body;
  const everything = listRows(bobCollectionsBody, 'collections').find((row) => row.builtinKind === 'everything');
  let memberResponse: NativeLibraryNavigationRawResponse | undefined;
  if (typeof everything?.id === 'string') {
    const memberPath = `/v1/collections/${encodeURIComponent(everything.id)}/members?limit=20`;
    await native.kernel(memberPath, { headers: { authorization: fixture.reader.authorization } }, 'bob');
    memberResponse = responseFor(responses, 'GET', memberPath, 'bob');
  }

  const aliceJourney = await auth.signIn('alice');
  const bobJourney = await auth.signIn('bob');
  const destinations: NativeLibraryNavigationDestination[] = [];
  const scenarios: NativeLibraryNavigationScenarioExport[] = [];
  const pageScenarios = [
    { id: 'page.library.alice', persona: 'alice', journey: aliceJourney, path: '/en/library' },
    { id: 'page.library.bob', persona: 'bob', journey: bobJourney, path: '/en/library' },
    { id: 'page.my-collections.alice', persona: 'alice', journey: aliceJourney, path: '/en/library/collections' },
    { id: 'page.my-collections.bob', persona: 'bob', journey: bobJourney, path: '/en/library/collections' },
  ] as const;
  for (const item of pageScenarios) {
    const destinationIds = await pageDestinations(
      item.journey,
      stack,
      item.persona,
      item.path,
      item.id,
      destinations,
    );
    scenarios.push(scenario(item.id, 'available', [], destinationIds));
  }

  const routeScenarios = [
    ['collections.alice.owner', 'GET', aliceCollectionsPath, 'alice'],
    ['collections.alice.viewer', 'GET', aliceCollectionsPath, 'bob'],
    ['collections.bob.owner', 'GET', bobCollectionsPath, 'bob'],
    ['collections.bob.viewer', 'GET', bobCollectionsPath, 'alice'],
    ['pins.alice.owner', 'GET', pinsPath, 'alice'],
    ['pins.bob.owner', 'GET', pinsPath, 'bob'],
    ['entry.alice.owner', 'GET', aliceEntryPath, 'alice'],
    ['entry.alice.viewer', 'GET', aliceEntryPath, 'bob'],
  ] as const;
  for (const [id, method, path, persona] of routeScenarios) {
    const response = responseFor(responses, method, path, persona);
    scenarios.push(scenario(id, statusState(response.status), [response.id]));
  }
  scenarios.push(
    memberResponse
      ? scenario(
          'members.everything.bob',
          memberResponse.status === 404 ? 'unavailable' : statusState(memberResponse.status),
          [memberResponse.id],
        )
      : scenario('members.everything.bob', 'dependency_unavailable'),
  );

  const identities = [
    { persona: 'alice', ownerAccountId: fixture.owner.accountId, body: responseFor(responses, 'GET', aliceCollectionsPath, 'alice').body },
    { persona: 'bob', ownerAccountId: fixture.reader.accountId, body: bobCollectionsBody },
  ].flatMap(({ persona, ownerAccountId, body }) =>
    listRows(body, 'collections').flatMap((row) =>
      typeof row.id === 'string'
        ? [
            {
              persona: persona as NativeLibraryNavigationPersona,
              ownerAccountId,
              descriptorId: row.id,
              ...(typeof row.builtinKind === 'string' ? { builtinKind: row.builtinKind } : {}),
              ...(typeof row.title === 'string' || row.title === null ? { title: row.title } : {}),
            },
          ]
        : [],
    ),
  );

  const expectedIds = new Set(nativeLibraryNavigationResponseScenarioManifest.map(({ id }) => id));
  const actualIds = new Set(scenarios.map(({ scenarioId }) => scenarioId));
  if (expectedIds.size !== actualIds.size || [...expectedIds].some((id) => !actualIds.has(id)))
    throw new Error('Native Library response export does not match its closed scenario manifest');

  return {
    binding,
    manifest: nativeLibraryNavigationResponseScenarioManifest,
    commands,
    observedRevisions,
    responses,
    scenarios,
    destinations,
    identities,
    fixtureFacts: {
      publicCollectionId: fixture.collection.id,
      privateCollectionId,
      aliceSubjectId: aliceSubject.id,
      bobSubjectId: fixture.memberSubject.id,
    },
  };
}
