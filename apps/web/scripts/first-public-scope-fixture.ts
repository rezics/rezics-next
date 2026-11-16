import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { developmentKeys, firstPublicWebOwnerActions } from '../../../services/auth/scripts/dev-stack.ts';
import { createAccountTokenProvider } from '../../../services/importer/src/credentials.ts';
import type { CrossMediaSeedReport } from '../../../services/importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT, grantOrdinaryOwnerActions } from '../../../services/importer/src/ordinary-owner-grants.ts';
import { ShowcaseJournal } from '../../../services/importer/src/showcase-publication.ts';
import {
  createDevelopmentShowcaseClient,
  seedDevelopmentCommunity,
} from '../../../scripts/datasets/showcase-community.ts';
import { parseEnv, readOrdinaryAuthSession, resolveFollowTarget, signup, websiteToken } from './accounts-goal-walk.ts';
import {
  createStaticZone,
  publishZone,
  readZonePage,
  requireId,
  saveZoneConfiguration,
  type Json,
  type KernelCall,
  type WalkStackOrigins,
} from './semantic-first-public-native.ts';

export type WebFixture = {
  owner: { accountId: string; handle: string; subjectId: string };
  outsider: { accountId: string; handle: string };
  workId: string;
  releaseId: string;
  boardId: string;
  threadId: string;
  openingPostId: string;
  openingRevisionId: string;
  collectionId: string;
  collectionMembers: { id: string; subjectId: string }[];
  spaceId: string;
  spaceAddress: string | null;
  realmId: string;
  zone: { id: string; route: string; text: string };
  closed: { operation: string; anonymous: number; owner: number; outsider: number }[];
};

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

async function proveClosedScope(call: KernelCall, outsider: { accountId: string; bearer: string }, workId: string) {
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

export async function seedFirstPublicWeb(
  root: string,
  stack: WalkStackOrigins,
  call: KernelCall,
  catalogue: CrossMediaSeedReport,
): Promise<WebFixture> {
  const published = catalogue.showcase?.published ?? [];
  const work = published.find((row) => row.provider === 'vndb' && row.sourceKey === 'v2002');
  const workId = requireId(work?.subjectId, 'published VNDB v2002 work');
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

  const subjectId = await resolveFollowTarget(stack, owner, 'public Web fixture owner');
  const grantor = await createAccountTokenProvider({
    accountKeyPath: seedEnv.REZICS_DEV_PERSONA_ACCOUNT_KEY!,
    account: requireId(seedEnv.REZICS_DEV_PERSONA_ACCOUNT, 'catalogue fixture account'),
    client: seedEnv.REZICS_DEV_PERSONA_CLIENT!,
    authOrigin: stack.native,
    issuerOrigin: stack.issuer,
    scopes: ['access:grant', ...firstPublicWebOwnerActions],
  });
  const grantBearer = await grantor();
  await grantOrdinaryOwnerActions({
    accountId: owner.accountId,
    actions: firstPublicWebOwnerActions,
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

  const bearer = ownerAuth.bearer;
  const closed = await proveClosedScope(
    call,
    bearer,
    { accountId: outsider.accountId, bearer: outsiderAuth.bearer },
    workId,
  );
  const journal = new ShowcaseJournal(join(root, '.temp/cross-media-seed/showcase.sqlite'));
  const actor = { accountId: owner.accountId, clientId: bindings.WEBSITE_CLIENT_ID ?? 'rezics-website' };
  const community = await (async () => {
    try {
      return await seedDevelopmentCommunity({
        result: catalogue,
        actor,
        client: createDevelopmentShowcaseClient({
          origin: stack.kernel,
          actor,
          credential: { sessionId },
          tokenProvider: async () => bearer,
          journal,
        }),
      });
    } finally {
      journal.close();
    }
  })();
  if (community.state !== 'published')
    throw new Error(`Community fixture ${community.operation}: ${community.state} (${community.code ?? 'no-code'})`);
  if (community.source.subjectId !== workId) throw new Error('Board fixture selected a different imported work');

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
  expectStatus(await call('GET', path, { bearer: outsiderAuth.bearer }), 404, 'private Collection outsider read');
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
  for (const viewer of [bearer, outsiderAuth.bearer, undefined]) {
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

  const route = 'about';
  const text = '關於網站的公開指南';
  const zone = await createStaticZone(call, bearer, 'First-public Web Zone', 'Welcome to the public Zone.', text);
  const revision = await saveZoneConfiguration(call, bearer, zone.id, zone.revision, zone.configuration);
  await publishZone(call, bearer, zone.id, revision);
  expectStatus(await readZonePage(call, zone.id, route), 200, 'read configured public Zone address');

  return {
    owner: { accountId: owner.accountId, handle: owner.handle, subjectId },
    outsider: { accountId: outsider.accountId, handle: outsider.handle },
    workId,
    releaseId,
    boardId: community.board.id,
    threadId: community.thread.threadId,
    openingPostId: community.thread.postId,
    openingRevisionId: community.thread.revisionId,
    collectionId,
    collectionMembers,
    spaceId,
    spaceAddress,
    realmId,
    zone: { id: zone.id, route, text },
    closed,
  };
}
