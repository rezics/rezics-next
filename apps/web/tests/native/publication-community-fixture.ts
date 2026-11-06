import { fromPlainText } from '@rezics/document';
import { threadHref } from '../../src/threads/thread-href.ts';
import type { PublicationFixture } from '../../../../specs/web-publication-driver';

const globalContext = '00000000-0000-8000-8000-000000000000';

type Kernel = (path: string, init?: RequestInit, persona?: string) => Promise<Response>;
type Locales = readonly string[];
type SitemapKind = keyof PublicationFixture['sitemap'];
type Inventory = PublicationFixture['sitemap'][SitemapKind];

export type CommunityPublicationInventory = {
  sitemap: Pick<PublicationFixture['sitemap'], 'collection' | 'realm' | 'space' | 'board' | 'thread'>;
  nativeIds: Record<'collection' | 'realm' | 'space' | 'board' | 'thread', string[]>;
  verifiedSubjectUrl: string;
  verifiedProfileUrl: string;
};

function jsonHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json');
  return headers;
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${operation} returned ${response.status}: ${body}`);
  return (body ? JSON.parse(body) : undefined) as T;
}

async function writeJson<T>(
  kernel: Kernel,
  path: string,
  persona: string,
  body: unknown,
  extraHeaders?: HeadersInit,
): Promise<T> {
  const headers = jsonHeaders(extraHeaders);
  if (!headers.has('idempotency-key')) headers.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
  return readJson<T>(
    await kernel(path, { method: 'POST', headers, body: JSON.stringify(body) }, persona),
    `POST ${path}`,
  );
}

async function putJson<T>(
  kernel: Kernel,
  path: string,
  persona: string,
  body: unknown,
  extraHeaders?: HeadersInit,
): Promise<T> {
  const headers = jsonHeaders(extraHeaders);
  headers.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
  return readJson<T>(
    await kernel(path, { method: 'PUT', headers, body: JSON.stringify(body) }, persona),
    `PUT ${path}`,
  );
}

function localeUrls(origin: string, path: string, locales: Locales): Inventory['eligible'] {
  return locales.map((locale) => ({
    url: new URL(`/${encodeURIComponent(locale)}${path}`, origin).href,
    lastmod: null,
  }));
}

function localePaths(origin: string, path: string, locales: Locales): string[] {
  return locales.map((locale) => new URL(`/${encodeURIComponent(locale)}${path}`, origin).href);
}

function numbered(kind: string, index: number): string {
  return `${kind}${String(index).padStart(2, '0')}`;
}

function routeOf(id: string): number {
  const route = Number.parseInt(id.slice(24, 28), 16);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(route)) throw new Error(`Invalid native route id: ${id}`);
  return route;
}

async function openExposure(kernel: Kernel, family: string): Promise<void> {
  const response = await kernel(
    `/v1/platform/exposure/${family}:open`,
    { method: 'POST', headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) } },
    'governor',
  );
  if (!response.ok && response.status !== 409)
    throw new Error(`Could not open ${family} exposure: ${response.status} ${await response.text()}`);
  await response.body?.cancel();
}

async function createSpace(kernel: Kernel, title: string): Promise<{ spaceId: string; headRevisionId: string }> {
  const created = await writeJson<{ space: { spaceId: string; headRevisionId: string } }>(
    kernel,
    '/v1/spaces',
    'governor',
    { title, summary: `${title} host.` },
  );
  if (!created.space?.spaceId || !created.space.headRevisionId)
    throw new Error(`Space create omitted identity for ${title}`);
  return created.space;
}

async function claimAddress(
  kernel: Kernel,
  space: { spaceId: string; headRevisionId: string },
  address: string,
): Promise<{ spaceId: string; headRevisionId: string }> {
  const claimed = await putJson<{ space: { spaceId: string; headRevisionId: string } }>(
    kernel,
    `/v1/spaces/${space.spaceId}/address`,
    'governor',
    { address },
    { 'if-match': JSON.stringify(space.headRevisionId) },
  );
  if (!claimed.space?.headRevisionId) throw new Error(`Space ${space.spaceId} address claim omitted its head`);
  return claimed.space;
}

async function createRealm(
  kernel: Kernel,
  spaceId: string,
  title: string,
  visibility: 'public' | 'protected',
): Promise<{ realmId: string; headRevisionId: string }> {
  const created = await writeJson<{ realm: { realmId: string; headRevisionId: string } }>(
    kernel,
    '/v1/realms',
    'governor',
    { spaceId, title, summary: `${title} discussion.`, visibility, contextId: globalContext },
  );
  if (!created.realm?.realmId || !created.realm.headRevisionId)
    throw new Error(`Realm create omitted identity for ${title}`);
  return created.realm;
}

async function setBoardScheme(
  kernel: Kernel,
  realm: { realmId: string; headRevisionId: string },
  schemeId: string,
): Promise<string> {
  const updated = await putJson<{ realm?: { headRevisionId?: string } }>(
    kernel,
    `/v1/realms/${realm.realmId}/boardScheme`,
    'governor',
    { schemeId },
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  return updated.realm?.headRevisionId ?? realm.headRevisionId;
}

async function createBoard(
  kernel: Kernel,
  realmId: string,
  conceptId: string,
  title: string,
  visibility: 'published' | 'protected',
): Promise<string> {
  const created = await writeJson<{ board: { id: string } }>(kernel, `/v1/realms/${realmId}/boards`, 'governor', {
    conceptId,
    title,
    visibility,
  });
  if (!created.board?.id) throw new Error(`Board create omitted identity for ${title}`);
  return created.board.id;
}

async function createThread(
  kernel: Kernel,
  boardId: string,
  title: string,
  visibility: 'published' | 'draft' | 'protected',
): Promise<{ id: string; title: string | null }> {
  const created = await writeJson<{ thread: { id: string; title?: string | null } }>(
    kernel,
    '/v1/threads',
    'governor',
    {
      boardId,
      title,
      body: fromPlainText(`${title} opening post`),
      licence: 'MIT',
      subjectIds: [],
      visibility,
    },
  );
  if (!created.thread?.id) throw new Error(`Thread create omitted identity for ${title}`);
  return { id: created.thread.id, title: created.thread.title ?? title };
}

async function removeContainer(kernel: Kernel, kind: 'space' | 'realm', id: string, headRevisionId: string) {
  const lifecycle = await readJson<{ container: { version: string; headRevisionId: string } }>(
    await kernel(`/v1/${kind}s/${id}/lifecycle`, undefined, 'governor'),
    `GET /v1/${kind}s/${id}/lifecycle`,
  );
  const response = await kernel(
    `/v1/${kind}s/${id}/removal`,
    {
      method: 'POST',
      headers: jsonHeaders({
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        'if-match': JSON.stringify(headRevisionId || lifecycle.container.headRevisionId),
      }),
      body: JSON.stringify({ expectedVersion: lifecycle.container.version, reason: 'Publication fixture exclusion' }),
    },
    'governor',
  );
  if (!response.ok) throw new Error(`Could not remove ${kind} ${id}: ${response.status} ${await response.text()}`);
  await response.body?.cancel();
}

async function takeDown(kernel: Kernel, kind: 'board' | 'thread', id: string) {
  await writeJson(kernel, `/v1/${kind}s/${id}:takeDown`, 'governor', { reason: 'Publication fixture exclusion' });
}

async function grantThreadCreate(kernel: Kernel, boardId: string, accountId: string) {
  const response = await kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: jsonHeaders({ 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      body: JSON.stringify({
        resource: { route: routeOf(boardId), id: boardId },
        subject: { kind: 'account', id: accountId },
        actions: ['thread:create'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  if (!response.ok && response.status !== 409)
    throw new Error(`Could not grant thread:create on ${boardId}: ${response.status} ${await response.text()}`);
  await response.body?.cancel();
}

async function createCollection(
  kernel: Kernel,
  title: string,
  visibility: 'public' | 'unlisted' | 'private',
): Promise<{ id: string; revision: number }> {
  const created = await writeJson<{ collection: { id: string; revision: number } }>(
    kernel,
    '/v1/collections',
    'governor',
    { title, visibility },
  );
  if (!created.collection?.id || !created.collection.revision)
    throw new Error(`Collection create omitted identity for ${title}`);
  return created.collection;
}

async function deleteCollection(kernel: Kernel, collection: { id: string; revision: number }) {
  const response = await kernel(
    `/v1/collections/${collection.id}?revision=${collection.revision}`,
    {
      method: 'DELETE',
      headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
    },
    'governor',
  );
  if (!response.ok && response.status !== 204)
    throw new Error(`Could not delete collection ${collection.id}: ${response.status} ${await response.text()}`);
  await response.body?.cancel();
}

async function bindVerifiedHandle(
  kernel: Kernel,
  credentials: (persona: string) => Promise<{ authorization: string }>,
  accountIdFromAuthorization: (authorization: string) => string,
  origin: string,
  handleHint: string,
  subjectPath: (id: string, label: string, locale?: string) => string,
): Promise<{ subjectUrl: string; profileUrl: string }> {
  const persona = handleHint;
  const credentialsFor = await credentials(persona);
  const accountId = accountIdFromAuthorization(credentialsFor.authorization);
  const grant = await kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: jsonHeaders({ 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      body: JSON.stringify({
        resource: { route: 0, id: globalContext },
        subject: { kind: 'account', id: accountId },
        actions: ['subject:create'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  if (!grant.ok && grant.status !== 409)
    throw new Error(`Could not grant subject:create to ${accountId}: ${grant.status} ${await grant.text()}`);
  await grant.body?.cancel();
  const created = await writeJson<{ subject: { id: string } }>(kernel, '/v1/subjects', persona, {
    type: 'schema:Person',
    labels: { en: 'Lantern Verified' },
    descriptions: { en: 'Verified catalogue person for publication.' },
  });
  if (!created.subject?.id) throw new Error('Verified person subject create omitted its identity');
  const requested = await writeJson<{ verificationRequest: { id: string } }>(
    kernel,
    `/v1/accounts/${accountId}:requestVerification`,
    persona,
    {
      subject: created.subject.id,
      statement: 'This catalogue identity belongs to this agent.',
      links: [{ label: 'Evidence', url: 'https://example.test/lantern-verified' }],
    },
  );
  await writeJson(kernel, `/v1/verification-requests/${requested.verificationRequest.id}:approve`, 'governor', {});
  const deadline = Date.now() + 30_000;
  let handle: string | null = null;
  while (Date.now() < deadline) {
    const listed = await readJson<{ accounts: { id: string; handle: string | null; verified?: boolean }[] }>(
      await kernel(`/v1/accounts?ids=${encodeURIComponent(accountId)}`),
      'GET /v1/accounts',
    );
    const account = listed.accounts.find((entry) => entry.id === accountId);
    if (account?.verified === true && account.handle) {
      handle = account.handle;
      break;
    }
    await Bun.sleep(250);
  }
  if (!handle) throw new Error(`Verified publication account ${accountId} did not publish a current handle`);
  return {
    subjectUrl: new URL(subjectPath(created.subject.id, 'Lantern Verified'), origin).href,
    profileUrl: new URL(`/en/@${encodeURIComponent(handle)}`, origin).href,
  };
}

export async function provisionCommunityPublication(input: {
  kernel: Kernel;
  credentials: (persona: string) => Promise<{ authorization: string }>;
  accountIdFromAuthorization: (authorization: string) => string;
  publicOrigin: string;
  locales: Locales;
  eligiblePerKind: number;
  verifiedHandle: string;
  subjectPath: (id: string, label: string, locale?: string) => string;
}): Promise<CommunityPublicationInventory> {
  const { kernel, publicOrigin, locales, eligiblePerKind } = input;
  const governorId = input.accountIdFromAuthorization((await input.credentials('governor')).authorization);
  await openExposure(kernel, 'collections');
  await openExposure(kernel, 'agent_verification');

  const scheme = await writeJson<{ subject: { id: string } }>(kernel, '/v1/subjects', 'governor', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Publication board scheme' },
  });
  const concept = await writeJson<{ subject: { id: string } }>(kernel, '/v1/subjects', 'governor', {
    type: 'skos:Concept',
    labels: { en: 'Publication discussion' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
    },
  });

  const collectionIds: string[] = [];
  const collectionEligible: Inventory['eligible'] = [];
  const collectionExcluded: string[] = [];
  for (let index = 1; index <= eligiblePerKind; index++) {
    const collection = await createCollection(kernel, `Public lantern collection ${index}`, 'public');
    collectionIds.push(collection.id);
    collectionEligible.push(...localeUrls(publicOrigin, `/collections/${encodeURIComponent(collection.id)}`, locales));
  }
  const unlisted = await createCollection(kernel, 'Unlisted lantern collection', 'unlisted');
  const privateCollection = await createCollection(kernel, 'Private lantern collection', 'private');
  const takenCollection = await createCollection(kernel, 'Taken-down lantern collection', 'public');
  collectionExcluded.push(
    ...localePaths(publicOrigin, `/collections/${encodeURIComponent(unlisted.id)}`, locales),
    ...localePaths(publicOrigin, `/collections/${encodeURIComponent(privateCollection.id)}`, locales),
    ...localePaths(publicOrigin, `/collections/${encodeURIComponent(takenCollection.id)}`, locales),
  );
  await deleteCollection(kernel, takenCollection);

  const publicHost = await createSpace(kernel, 'Public lantern board host');
  const publicRealm = await createRealm(kernel, publicHost.spaceId, 'Public lantern board realm', 'public');
  await setBoardScheme(kernel, publicRealm, scheme.subject.id);

  const realmIds = [publicRealm.realmId];
  const realmEligible = localeUrls(publicOrigin, `/realms/${encodeURIComponent(publicRealm.realmId)}`, locales);
  for (let index = 2; index <= eligiblePerKind; index++) {
    const host = await createSpace(kernel, `Public lantern realm host ${index}`);
    const realm = await createRealm(kernel, host.spaceId, `Public lantern realm ${index}`, 'public');
    realmIds.push(realm.realmId);
    realmEligible.push(...localeUrls(publicOrigin, `/realms/${encodeURIComponent(realm.realmId)}`, locales));
  }
  const protectedHost = await createSpace(kernel, 'Protected lantern realm host');
  const protectedRealm = await createRealm(kernel, protectedHost.spaceId, 'Protected lantern realm', 'protected');
  await setBoardScheme(kernel, protectedRealm, scheme.subject.id);
  const removedRealmHost = await createSpace(kernel, 'Removed lantern realm host');
  const removedRealm = await createRealm(kernel, removedRealmHost.spaceId, 'Taken-down lantern realm', 'public');
  const realmExcluded = [
    ...localePaths(publicOrigin, `/realms/${encodeURIComponent(protectedRealm.realmId)}`, locales),
    ...localePaths(publicOrigin, `/realms/${encodeURIComponent(removedRealm.realmId)}`, locales),
  ];
  await removeContainer(kernel, 'realm', removedRealm.realmId, removedRealm.headRevisionId);

  const spaceIds: string[] = [];
  const spaceEligible: Inventory['eligible'] = [];
  for (let index = 1; index <= eligiblePerKind; index++) {
    const space = await createSpace(kernel, `Standalone lantern space ${index}`);
    const addressed = await claimAddress(kernel, space, numbered('pubspace', index));
    spaceIds.push(addressed.spaceId);
    spaceEligible.push(
      ...localeUrls(publicOrigin, `/spaces/${encodeURIComponent(numbered('pubspace', index))}`, locales),
    );
  }
  const unreadable = await createSpace(kernel, 'Unreadable lantern space');
  const unreadableAddress = 'unreadspace';
  const unreadableAddressed = await claimAddress(kernel, unreadable, unreadableAddress);
  await createRealm(kernel, unreadableAddressed.spaceId, 'Unreadable lantern realm', 'protected');
  const removedSpace = await createSpace(kernel, 'Taken-down lantern space');
  const removedAddress = 'removedspace';
  const removedAddressed = await claimAddress(kernel, removedSpace, removedAddress);
  const spaceExcluded = [
    ...localePaths(publicOrigin, `/spaces/${encodeURIComponent(unreadableAddress)}`, locales),
    ...localePaths(publicOrigin, `/spaces/${encodeURIComponent(removedAddress)}`, locales),
  ];
  await removeContainer(kernel, 'space', removedAddressed.spaceId, removedAddressed.headRevisionId);

  const boardIds: string[] = [];
  const threadIds: string[] = [];
  const boardEligible: Inventory['eligible'] = [];
  const threadEligible: Inventory['eligible'] = [];
  for (let index = 1; index <= eligiblePerKind; index++) {
    const boardId = await createBoard(
      kernel,
      publicRealm.realmId,
      concept.subject.id,
      `Public lantern board ${index}`,
      'published',
    );
    await grantThreadCreate(kernel, boardId, governorId);
    const thread = await createThread(kernel, boardId, `Public lantern thread ${index}`, 'published');
    boardIds.push(boardId);
    threadIds.push(thread.id);
    boardEligible.push(...localeUrls(publicOrigin, `/boards/${encodeURIComponent(boardId)}`, locales));
    threadEligible.push(...localeUrls(publicOrigin, threadHref({ id: thread.id, title: thread.title }), locales));
  }
  const protectedBoardId = await createBoard(
    kernel,
    protectedRealm.realmId,
    concept.subject.id,
    'Protected lantern board',
    'protected',
  );
  await grantThreadCreate(kernel, protectedBoardId, governorId);
  const protectedThread = await createThread(kernel, protectedBoardId, 'Protected lantern thread', 'published');
  const draftThread = await createThread(kernel, boardIds[0]!, 'Draft lantern thread', 'draft');
  const takenBoardId = await createBoard(
    kernel,
    publicRealm.realmId,
    concept.subject.id,
    'Taken-down lantern board',
    'published',
  );
  await grantThreadCreate(kernel, takenBoardId, governorId);
  await createThread(kernel, takenBoardId, 'Thread on taken-down board', 'published');
  const takenThread = await createThread(kernel, boardIds[0]!, 'Taken-down lantern thread', 'published');
  const boardExcluded = [
    ...localePaths(publicOrigin, `/boards/${encodeURIComponent(protectedBoardId)}`, locales),
    ...localePaths(publicOrigin, `/boards/${encodeURIComponent(takenBoardId)}`, locales),
  ];
  const threadExcluded = [
    ...localePaths(publicOrigin, threadHref({ id: draftThread.id, title: draftThread.title }), locales),
    ...localePaths(publicOrigin, threadHref({ id: protectedThread.id, title: protectedThread.title }), locales),
    ...localePaths(publicOrigin, threadHref({ id: takenThread.id, title: takenThread.title }), locales),
  ];
  await takeDown(kernel, 'board', takenBoardId);
  await takeDown(kernel, 'thread', takenThread.id);

  const verified = await bindVerifiedHandle(
    kernel,
    input.credentials,
    input.accountIdFromAuthorization,
    publicOrigin,
    input.verifiedHandle,
    input.subjectPath,
  );

  return {
    sitemap: {
      collection: { eligible: collectionEligible, excluded: collectionExcluded },
      realm: { eligible: realmEligible, excluded: realmExcluded },
      space: { eligible: spaceEligible, excluded: spaceExcluded },
      board: { eligible: boardEligible, excluded: boardExcluded },
      thread: { eligible: threadEligible, excluded: threadExcluded },
    },
    nativeIds: {
      collection: collectionIds,
      realm: realmIds,
      space: spaceIds,
      board: boardIds,
      thread: threadIds,
    },
    verifiedSubjectUrl: verified.subjectUrl,
    verifiedProfileUrl: verified.profileUrl,
  };
}
