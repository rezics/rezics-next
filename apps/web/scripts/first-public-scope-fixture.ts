import { join } from 'node:path';
import { fromPlainText } from '@rezics/document';
import { decodeJwt } from 'jose';
import { developmentKeys, firstPublicWebOwnerActions } from '../../../services/auth/scripts/dev-stack.ts';
import { createAccountTokenProvider } from '../../../services/importer/src/credentials.ts';
import type { CrossMediaSeedReport } from '../../../services/importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT, grantOrdinaryOwnerActions } from '../../../services/importer/src/ordinary-owner-grants.ts';
import { parseEnv, readOrdinaryAuthSession, resolveFollowTarget, signup, websiteToken } from './accounts-goal-walk.ts';
import {
  createStaticZone,
  createSubject,
  readSubject,
  publishZone,
  readZonePage,
  requireId,
  saveZoneConfiguration,
  type Json,
  type KernelCall,
  type WalkStackOrigins,
} from './semantic-first-public-native.ts';

export type CommunityFixture = {
  owner: { accountId: string; handle: string; email: string };
  outsider: { accountId: string; handle: string; email: string };
  conceptId: string;
  boardId: string;
  threadId: string;
  openingPostId: string;
  openingRevisionId: string;
  spaceId: string;
  spaceAddress: string | null;
  realmId: string;
};

export type WebFixture = CommunityFixture & {
  owner: CommunityFixture['owner'] & { subjectId: string };
  workId: string;
  releaseId: string;
  collectionId: string;
  collectionMembers: { id: string; subjectId: string }[];
  zone: { id: string; route: string; text: string };
  closed: { operation: string; anonymous: number; owner: number; outsider: number }[];
};

const communityOwnerActions = [
  'board:create',
  'space:create',
  'realm:create',
] as const satisfies readonly (typeof firstPublicWebOwnerActions)[number][];

function expectStatus(result: { status: number; body: Json }, expected: number, operation: string): Json {
  if (result.status !== expected)
    throw new Error(`${operation} HTTP ${result.status}, expected ${expected} (${result.body.code ?? 'no-code'})`);
  return result.body;
}

export async function readFirstPublicCatalogueReport(root: string) {
  const report = (await Bun.file(join(root, '.temp/cross-media-seed/result.json')).json()) as CrossMediaSeedReport;
  if (report.showcase?.status !== 'published' || report.personMerge || report.persona)
    throw new Error('The current seed did not supply a complete catalogue-only publication');
  return report;
}

async function proveClosedScope(
  call: KernelCall,
  ownerBearer: string,
  outsider: { accountId: string; bearer: string },
  workId: string,
) {
  // Use reads and a read-only Search query so a misconfigured gate cannot create anything.
  const probes = [
    ['subject offers', 'GET', `/v1/subjects/${workId}/offers`],
    ['seller offers', 'GET', '/v1/offers'],
    ['personal VNDB list', 'GET', `/v1/libraryImports/vndb/${workId}`],
    ['personal Bangumi list', 'GET', `/v1/libraryImports/bangumi/${workId}`],
    ['personal MyAnimeList list', 'GET', `/v1/libraryImports/mal/${workId}`],
    ['personal AniList list', 'GET', `/v1/libraryImports/anilist/${workId}`],
    ['mixed Search', 'POST', '/v1/subjects:search'],
    ['advanced Search', 'POST', '/v1/subjects:facets'],
    ['Subject identity operation', 'GET', `/v1/subjectIdentityOperations/${workId}`],
    ['agent verification', 'GET', `/v1/accounts/${outsider.accountId}/verification`],
  ] as const;
  const bodies: Record<string, unknown> = {
    'mixed Search': { limit: 1 },
    'advanced Search': { facets: [{ property: 'schema:genre', size: 1 }] },
  };
  const evidence: WebFixture['closed'] = [];
  for (const [operation, method, path] of probes) {
    const body = bodies[operation];
    const anonymous = await call(method, path, { body });
    const owner = await call(method, path, { body, bearer: ownerBearer });
    const ordinary = await call(method, path, { body, bearer: outsider.bearer });
    for (const [audience, response] of [
      ['anonymous', anonymous],
      ['owner', owner],
      ['outsider', ordinary],
    ] as const) {
      if (response.status !== 403 || response.body.code !== 'platform_closed')
        throw new Error(`${operation} for ${audience} HTTP ${response.status} (${response.body.code ?? 'no-code'})`);
    }
    evidence.push({ operation, anonymous: anonymous.status, owner: owner.status, outsider: ordinary.status });
  }
  return evidence;
}

async function readCatalogueSubjects(call: KernelCall, catalogue: CrossMediaSeedReport) {
  const published = catalogue.showcase?.published ?? [];
  const work = published.find((row) => row.provider === 'vndb' && row.sourceKey === 'v2002');
  const workId = requireId(work?.subjectId, 'published VNDB v2002 work');
  const reading = catalogue.readings.find(
    (entry) => entry.source === 'vndb' && entry.externalId === 'v2002' && entry.selection === 'selected',
  );
  const readWork = (reading?.subject as { subject?: { id?: unknown } } | undefined)?.subject?.id;
  const handoff = catalogue.workLinks.find(
    (entry) => entry.source.provider === 'vndb' && entry.source.externalId === 'v2002',
  )?.source;
  if (
    readWork !== workId ||
    typeof reading?.route !== 'string' ||
    (handoff && (handoff.subject?.subjectId !== workId || handoff.subject.route !== reading.route))
  )
    throw new Error('Published VNDB v2002 did not match the imported work readback');
  const secondWorkId = requireId(
    published.find((row) => row.provider === 'vndb' && row.sourceKey === 'v4')?.subjectId,
    'published VNDB v4 work',
  );

  const links = expectStatus(
    await call('GET', `/v1/subjects/${workId}/links`, { query: { property: 'schema:exampleOfWork', limit: '20' } }),
    200,
    'current editions for VNDB v2002',
  );
  const releaseIds = new Set(
    catalogue.showcase?.manifest.records
      .filter((row) => row.provider === 'vndb' && row.kind === 'release')
      .map((row) => row.subjectId),
  );
  const publishedReleaseIds = new Set(published.map((row) => row.subjectId).filter((id) => releaseIds.has(id)));
  const release = (links.links as Json[] | undefined)?.find((row) => {
    const summary = row.summary as Json | undefined;
    return (
      summary?.id === row.subject &&
      typeof row.subject === 'string' &&
      row.subject !== workId &&
      publishedReleaseIds.has(row.subject)
    );
  });
  const releaseId = requireId(release?.subject, 'currently disclosed imported release');
  return { workId, secondWorkId, releaseId };
}

async function seedOwner(root: string, stack: WalkStackOrigins, actions: readonly string[]) {
  const [bindings, { website }, seedEnv] = await Promise.all([
    parseEnv(join(root, 'apps/web/.dev.vars')),
    developmentKeys(),
    parseEnv(join(root, '.temp/local-stack/seed.env')),
  ]);
  const owner = await signup(stack, 'webowner');
  const outsider = await signup(stack, 'webreader');
  const ownerAuth = await websiteToken(stack, owner, bindings, website);
  const outsiderAuth = await websiteToken(stack, outsider, bindings, website);
  const ownerSessions = await readOrdinaryAuthSession(stack, owner, ownerAuth.session);
  await readOrdinaryAuthSession(stack, outsider, outsiderAuth.session);
  const sessionId = decodeJwt(ownerAuth.bearer).sid;
  if (
    owner.accountId === outsider.accountId ||
    typeof sessionId !== 'string' ||
    !(ownerSessions.sessions as Json[] | undefined)?.some((row) => row.id === sessionId && row.current === true)
  )
    throw new Error('The independently authenticated Web fixture identities did not match');

  const grantor = await createAccountTokenProvider({
    accountKeyPath: seedEnv.REZICS_DEV_PERSONA_ACCOUNT_KEY!,
    account: requireId(seedEnv.REZICS_DEV_PERSONA_ACCOUNT, 'development grantor account'),
    client: seedEnv.REZICS_DEV_PERSONA_CLIENT!,
    authOrigin: stack.native,
    issuerOrigin: stack.issuer,
    scopes: ['access:grant', ...actions],
  });
  const grantBearer = await grantor();
  await grantOrdinaryOwnerActions({
    accountId: owner.accountId,
    actions,
    post: async ({ path, body, idempotencyKey }) => {
      const response = await fetch(new URL(path, stack.kernel), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${grantBearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(idempotencyKey),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, text: '' };
    },
  });

  return { owner, outsider, bearer: ownerAuth.bearer, outsiderBearer: outsiderAuth.bearer };
}

export async function seedCommunityEntities(
  call: KernelCall,
  bearer: string,
  accountId: string,
  importedWorkId?: string,
): Promise<Omit<CommunityFixture, 'owner' | 'outsider'>> {
  const boardTitle = 'First-public Web Discussion';
  const concept = await createSubject(call, bearer, 'skos:Concept', boardTitle);
  const conceptId = concept.id;
  const topic = expectStatus(await readSubject(call, conceptId), 200, 'read exact public Board Concept').subject as
    | Json
    | undefined;
  if (topic?.id !== conceptId || topic.type !== 'skos:Concept' || (topic.labels as Json | undefined)?.en !== boardTitle)
    throw new Error('Public Board Concept did not match the ordinary authored Subject');

  const board = expectStatus(
    await call('POST', '/v1/boards', {
      bearer,
      body: { conceptId, title: boardTitle, purpose: 'discussion', visibility: 'published' },
    }),
    201,
    'owner creates public Global Board',
  ).board as Json | undefined;
  const boardId = requireId(board?.id, 'Board');
  const isPublicBoard = (row: Json) =>
    row.id === boardId &&
    row.realmId === null &&
    row.title === boardTitle &&
    row.purpose === 'discussion' &&
    row.visibility === 'published' &&
    row.availability === 'available';
  if (!board || !isPublicBoard(board)) throw new Error('Board creation did not acknowledge the exact public Board');

  const directory = expectStatus(
    await call('GET', '/v1/boards', { query: { purpose: 'discussion', limit: '100' } }),
    200,
    'read public Global Board directory',
  );
  if (!Array.isArray(directory.boards) || !(directory.boards as Json[]).some(isPublicBoard))
    throw new Error('The exact published Board was absent from the public Global Board directory');

  const discussionSubjectId = importedWorkId ?? conceptId;
  const licence = 'CC-BY-4.0';
  const thread = expectStatus(
    await call('POST', '/v1/threads', {
      bearer,
      body: {
        boardId,
        kind: 'discussion',
        title: 'A note for the first-public discussion',
        body: fromPlainText('This original note opens the first-public discussion.'),
        licence,
        subjectIds: [discussionSubjectId],
        visibility: 'published',
      },
    }),
    201,
    'owner authors public discussion opening',
  ).thread as Json | undefined;
  const opening = thread?.firstPost as Json | undefined;
  const threadId = requireId(thread?.id, 'Thread');
  const openingPostId = requireId(opening?.id, 'Opening post');
  const openingRevisionId = requireId(opening?.revisionId, 'Opening revision');
  if (
    thread?.boardId !== boardId ||
    thread.kind !== 'discussion' ||
    opening?.authorId !== accountId ||
    opening.licence !== licence ||
    typeof opening.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(opening.sha256) ||
    !Array.isArray(opening.subjectIds) ||
    opening.subjectIds.length !== 1 ||
    opening.subjectIds[0] !== discussionSubjectId
  )
    throw new Error('Thread creation did not acknowledge the exact authored opening');

  const space = expectStatus(
    await call('POST', '/v1/spaces', {
      bearer,
      body: { title: 'First-public Web Space' },
    }),
    201,
    'owner creates Space',
  ).space as Json;
  const spaceId = requireId(space.spaceId, 'Space');
  const realm = expectStatus(
    await call('POST', '/v1/realms', {
      bearer,
      body: { spaceId, title: 'First-public Web Realm', visibility: 'public', contextId: GLOBAL_CONTEXT },
    }),
    201,
    'owner creates public Realm',
  ).realm as Json;
  const realmId = requireId(realm.realmId, 'Realm');
  if (realm.spaceId !== spaceId || realm.visibility !== 'public')
    throw new Error('Realm did not bind the exact public Space');

  const currentSpace = expectStatus(await call('GET', `/v1/spaces/${spaceId}`), 200, 'read exact public Space')
    .space as Json;
  if (currentSpace.spaceId !== spaceId || currentSpace.realmId !== realmId)
    throw new Error('Public Space did not disclose its exact Realm');
  const spaceAddress = typeof currentSpace.address === 'string' ? currentSpace.address : null;

  return { conceptId, boardId, threadId, openingPostId, openingRevisionId, spaceId, spaceAddress, realmId };
}

export async function seedCommunityWeb(
  root: string,
  stack: WalkStackOrigins,
  call: KernelCall,
): Promise<CommunityFixture> {
  const { owner, outsider, bearer } = await seedOwner(root, stack, communityOwnerActions);
  return { owner, outsider, ...(await seedCommunityEntities(call, bearer, owner.accountId)) };
}

export async function seedFirstPublicWeb(
  root: string,
  stack: WalkStackOrigins,
  call: KernelCall,
  catalogue: CrossMediaSeedReport,
): Promise<WebFixture> {
  const { workId, secondWorkId, releaseId } = await readCatalogueSubjects(call, catalogue);
  const { owner, outsider, bearer, outsiderBearer } = await seedOwner(root, stack, firstPublicWebOwnerActions);
  const subjectId = await resolveFollowTarget(stack, owner, 'public Web fixture owner');
  const closed = await proveClosedScope(
    call,
    bearer,
    { accountId: outsider.accountId, bearer: outsiderBearer },
    workId,
  );
  const community = await seedCommunityEntities(call, bearer, owner.accountId, workId);

  const created = expectStatus(
    await call('POST', '/v1/collections', {
      bearer,
      body: { title: 'First-public Web Collection', visibility: 'private' },
    }),
    201,
    'owner creates private Collection',
  ).collection as Json;
  const collectionId = requireId(created.id, 'Collection');
  const path = `/v1/collections/${collectionId}`;
  const collectionMembers = [];
  for (const subjectId of [workId, secondWorkId]) {
    const member = expectStatus(
      await call('POST', `${path}/members`, {
        bearer,
        body: { subjectId },
      }),
      201,
      'owner adds exact Collection member',
    ).member as Json;
    if (member.subjectId !== subjectId) throw new Error('Collection member resolved to a different Subject');
    collectionMembers.push({ id: requireId(member.id, 'Collection member'), subjectId });
  }
  expectStatus(await call('GET', path), 404, 'private Collection anonymous read');
  expectStatus(await call('GET', path, { bearer: outsiderBearer }), 404, 'private Collection outsider read');
  const privateRead = expectStatus(await call('GET', path, { bearer }), 200, 'private Collection owner read')
    .collection as Json;
  if (privateRead.curatorAccountId !== owner.accountId || privateRead.visibility !== 'private')
    throw new Error('Collection owner or private visibility did not match');
  expectStatus(
    await call('PATCH', path, {
      bearer,
      body: { revision: privateRead.revision, visibility: 'public' },
    }),
    200,
    'owner explicitly publishes Collection',
  );
  for (const viewer of [bearer, outsiderBearer, undefined]) {
    const current = expectStatus(await call('GET', path, { bearer: viewer }), 200, 'published Collection read')
      .collection as Json;
    const members = expectStatus(
      await call('GET', `${path}/members`, { bearer: viewer }),
      200,
      'published Collection members',
    );
    if (
      current.id !== collectionId ||
      current.curatorAccountId !== owner.accountId ||
      current.visibility !== 'public' ||
      members.next !== null ||
      !Array.isArray(members.members) ||
      members.members.length !== collectionMembers.length ||
      collectionMembers.some(({ id, subjectId }, index) => {
        const member = (members.members as Json[])[index];
        return member?.id !== id || member.subjectId !== subjectId;
      })
    )
      throw new Error('Published Collection owner, visibility or member readback did not match');
  }

  const route = 'about';
  const text = '關於網站的公開指南';
  const zone = await createStaticZone(call, bearer, 'First-public Web Zone', 'Welcome to the public Zone.', text);
  const revision = await saveZoneConfiguration(call, bearer, zone.id, zone.revision, zone.configuration);
  await publishZone(call, bearer, zone.id, revision);
  expectStatus(await readZonePage(call, zone.id, route), 200, 'read configured public Zone address');

  return {
    ...community,
    owner: { ...owner, subjectId },
    outsider,
    workId,
    releaseId,
    collectionId,
    collectionMembers,
    zone: { id: zone.id, route, text },
    closed,
  };
}
