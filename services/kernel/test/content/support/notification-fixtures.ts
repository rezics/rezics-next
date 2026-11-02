import { randomUUID } from 'node:crypto';
import type { AccountActor } from '../../../src/request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  createNativeContentSystemWithWriteRateOverrides,
  registerNativeContentAccount,
  type NativeContentSystem,
} from './native-system.ts';
import type { ApiResult, Fixture, NoticeKind, Persona } from '../../../../../specs/content-notification-driver.ts';

const AUDIENCE = 'https://content.test';
const WRITE_RATE_OVERRIDES = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});
const READ_SCOPES = ['account:read', 'board:read', 'post:read', 'realm:read', 'thread:read'] as const;

function personaScopes(...actions: string[]): string[] {
  return [...new Set([...READ_SCOPES, 'account:update', ...actions])].sort();
}

export type NotificationFixture = {
  system: NativeContentSystem;
  appDatabaseUrl: string;
  workClock: () => Date;
  fixture: Fixture;
  protectedRealmId: string;
  /** Accounts whose route partitions are already occupied by fixture identities. */
  accountPartitions: Set<number>;
  /** Source partitions discovered from real fixture API responses. */
  contentPartitions: Set<number>;
  close(): Promise<void>;
  remember(id: string): void;
  grantModerationTarget(id: string, threadId?: string): Promise<void>;
  grantPostTarget(threadId: string, accountId: string): Promise<void>;
  grantReportTarget(id: string, reporterId: string): Promise<void>;
  realmMember(account: Persona, member: boolean): Promise<void>;
  setPreference(account: Persona, kind: NoticeKind, allowed: boolean): Promise<void>;
  setAccountState(account: Persona, state: 'active' | 'deleted'): Promise<void>;
  setNow(instant: string): Promise<void>;
};

type Credential = { bearer: string; actor: AccountActor };
type BoardResult = { id: string; realmId: string; sourceIds: string[] };

function accountPersona(credential: Credential): Persona {
  return { id: credential.actor.accountId, bearer: credential.bearer };
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Fixture received an unrouted identity');
  return value;
}

function separateContentPartitions(
  system: NativeContentSystem,
  authorId: string,
  accountPartitions: Set<number>,
): void {
  for (let attempt = 0; attempt < 256; attempt++) {
    const candidate = crypto.getRandomValues(new Uint8Array(32));
    let separated = true;
    for (let index = 1; index <= 64; index++) {
      const target = threadTarget(candidate, authorId, `notification-${index}`);
      if (accountPartitions.has(partitionOf(target.route))) {
        separated = false;
        break;
      }
    }
    if (separated) {
      system.routeKey.set(candidate);
      return;
    }
  }
  throw new Error('Could not separate content and notification account partitions');
}

async function api<T>(
  system: NativeContentSystem,
  actor: Persona,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
  key?: string,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const response = await system.kernel.handle(
    new Request(`${AUDIENCE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${actor.bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  let value: T | null = null;
  if (response.ok && response.status !== 204) value = (await response.clone().json()) as T;
  return { response, value };
}

async function expectStatus(response: Response, status: number, detail: string): Promise<void> {
  if (response.status !== status) {
    throw new Error(`${detail} failed (${response.status}): ${await response.clone().text()}`);
  }
}

async function registerPersona(
  system: NativeContentSystem,
  label: string,
  scopes: readonly string[],
): Promise<Credential> {
  const name = `notification-${label}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const password = `${randomUUID()}${randomUUID()}`;
  const registered = await registerNativeContentAccount(system, {
    key: name,
    handle: name,
    email: `${name}@content.test`,
    password,
  });
  const issuer = system.nativeAuth.verifier.issuer;
  const signedIn = await system.nativeAuth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: registered.accountId,
        password,
        client_id: system.auth.ordinaryClient.id,
        scope: scopes,
      }),
    }),
  );
  if (!signedIn.ok) throw new Error(`Fixture Auth /signin failed (${signedIn.status}): ${await signedIn.text()}`);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await system.nativeAuth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    }),
  );
  if (!issued.ok) throw new Error(`Fixture Auth /token failed (${issued.status}): ${await issued.text()}`);
  const { access_token: bearer } = (await issued.json()) as { access_token: string };
  const actor = await system.access.authenticate(bearer, {
    pool: system.database.pool,
    deadline: Date.now() + 10_000,
  });
  if (actor.kind !== 'account') throw new Error('Fixture Auth returned a non-account actor');
  return { bearer, actor };
}

async function createBoard(
  system: NativeContentSystem,
  creator: Persona,
  label: string,
  realmVisibility: 'public' | 'protected',
): Promise<BoardResult> {
  const spaceResult = await api<{ space: { spaceId: string } }>(
    system,
    creator,
    'POST',
    '/v1/spaces',
    {
      title: `${label} notification space`,
      summary: `${label} notification fixture`,
    },
    `${label}-space`,
  );
  await expectStatus(spaceResult.response, 201, 'Notification space creation');
  const spaceId = spaceResult.value?.space.spaceId;
  if (!spaceId) throw new Error('Notification space response is missing its id');

  const realmResult = await api<{ realm: { realmId: string; headRevisionId: string } }>(
    system,
    creator,
    'POST',
    '/v1/realms',
    {
      spaceId,
      title: `${label} notification Realm`,
      summary: `${label} notification fixture`,
      // Create as public, then use the production update path when a protected
      // Realm is needed. That path installs the native member group grant.
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
    `${label}-realm`,
  );
  await expectStatus(realmResult.response, 201, 'Notification Realm creation');
  const realm = realmResult.value?.realm;
  if (!realm) throw new Error('Notification Realm response is missing its identity');
  await installGrant(system, realm.realmId, creator.id, ['realm:read', 'realm:manage', 'board:create']);
  let realmHeadRevisionId = realm.headRevisionId;
  if (realmVisibility === 'protected') {
    const protectedResult = await api<{ realm: { headRevisionId: string } }>(
      system,
      creator,
      'PATCH',
      `/v1/realms/${realm.realmId}`,
      { visibility: 'protected' },
      `${label}-protect-realm`,
      { 'if-match': JSON.stringify(realmHeadRevisionId) },
    );
    await expectStatus(protectedResult.response, 200, 'Notification Realm protection');
    realmHeadRevisionId = protectedResult.value?.realm.headRevisionId ?? '';
    if (!realmHeadRevisionId) throw new Error('Protected notification Realm response is missing its head');
  }

  const schemeResult = await api<{ subject: { id: string } }>(
    system,
    creator,
    'POST',
    '/v1/subjects',
    {
      type: 'skos:ConceptScheme',
      labels: { en: `${label} notification scheme` },
    },
    `${label}-scheme`,
  );
  await expectStatus(schemeResult.response, 201, 'Notification subject scheme creation');
  const schemeId = schemeResult.value?.subject.id;
  if (!schemeId) throw new Error('Notification scheme response is missing its id');
  await installGrant(system, schemeId, creator.id, ['subject:read']);

  const conceptResult = await api<{ subject: { id: string } }>(
    system,
    creator,
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: `${label} notification concept` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    },
    `${label}-concept`,
  );
  await expectStatus(conceptResult.response, 201, 'Notification subject concept creation');
  const conceptId = conceptResult.value?.subject.id;
  if (!conceptId) throw new Error('Notification concept response is missing its id');
  await installGrant(system, conceptId, creator.id, ['subject:read']);

  const schemeUpdated = await api(
    system,
    creator,
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    {
      schemeId,
    },
    `${label}-board-scheme`,
    { 'if-match': JSON.stringify(realmHeadRevisionId) },
  );
  await expectStatus(schemeUpdated.response, 200, 'Notification Realm board scheme update');
  const boardResult = await api<{ board: { id: string } }>(
    system,
    creator,
    'POST',
    `/v1/realms/${realm.realmId}/boards`,
    { conceptId, title: `${label} notification board`, visibility: 'published' },
    `${label}-board`,
  );
  await expectStatus(boardResult.response, 201, 'Notification board creation');
  const boardId = boardResult.value?.board.id;
  if (!boardId) throw new Error('Notification board response is missing its id');
  return { id: boardId, realmId: realm.realmId, sourceIds: [spaceId, realm.realmId, schemeId, conceptId, boardId] };
}

async function installGrant(
  system: NativeContentSystem,
  resourceId: string,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  const resourceRoute = route(resourceId);
  await system.database.pool.query(
    `INSERT INTO access.resource_grant
       (route,resource_id,subject_id,subject_role,action,valid,transaction_id,subject_kind)
     SELECT $1,$2,$3,'',candidate.action,'(,)'::tstzrange,$4,'identity'
     FROM unnest($5::text[]) AS candidate(action)
     WHERE NOT EXISTS (
       SELECT 1 FROM access.resource_grant existing
       WHERE existing.route=$1 AND existing.resource_id=$2 AND existing.subject_id=$3
         AND existing.subject_role='' AND existing.action=candidate.action
         AND existing.subject_kind='identity' AND existing.valid @> $6::timestamptz
     )`,
    [resourceRoute, resourceId, accountId, randomUUID(), [...actions], new Date().toISOString()],
  );
}

export async function createNotificationFixture(): Promise<NotificationFixture> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for native notification outcomes');
  const namespace = `notify_${randomUUID().replaceAll('-', '')}`;
  const system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl, namespace },
    WRITE_RATE_OVERRIDES,
  );
  try {
    let replier = accountPersona(system.actors.other);
    let author = accountPersona(system.actors.author);
    let moderator = accountPersona(system.actors.moderator);
    const [mentionedCredential, nonMemberCredential, secondModeratorCredential, reporterCredential] = await Promise.all(
      [
        registerPersona(system, 'mentioned', personaScopes('post:create', 'realm:participate', 'report:create')),
        registerPersona(system, 'nonmember', personaScopes()),
        registerPersona(system, 'secondmoderator', personaScopes('moderation:read_reports', 'moderation:takedown')),
        registerPersona(system, 'reporter', personaScopes('report:create')),
      ],
    );
    const realmOwnerCredential = await registerPersona(
      system,
      'realmowner',
      personaScopes(
        'space:create',
        'space:manage',
        'realm:create',
        'realm:manage',
        'realm:participate',
        'board:create',
        'subject:create',
      ),
    );
    const readerCredentials = await Promise.all(
      Array.from({ length: 11 }, (_, index) => registerPersona(system, `reader${index}`, personaScopes())),
    );
    const mentioned = accountPersona(mentionedCredential);
    const nonMember = accountPersona(nonMemberCredential);
    const secondModerator = accountPersona(secondModeratorCredential);
    const reporter = accountPersona(reporterCredential);
    const realmOwner = accountPersona(realmOwnerCredential);
    const readers = readerCredentials.map(accountPersona);
    const accountPartitions = new Set(
      [author, replier, mentioned, nonMember, moderator, secondModerator, reporter, realmOwner, ...readers].map(
        (item) => partitionOf(route(item.id)),
      ),
    );
    separateContentPartitions(system, author.id, accountPartitions);
    const fixture: Fixture = {
      author,
      replier,
      mentioned,
      nonMember,
      moderator,
      secondModerator,
      reporter,
      readers,
      publicBoardId: '',
      protectedBoardId: '',
      now: new Date(Date.now() + 1_000).toISOString(),
    };
    let currentNow = fixture.now;
    const contentPartitions = new Set<number>();
    await system.clock.setCommandTime(fixture.now);
    await system.clock.setCursorVerificationTime(fixture.now);
    await bootstrapRelease(system.database.pool, bundledRelease, () => new Date(fixture.now));
    await installGrant(system, GLOBAL_CONTEXT, author.id, ['subject:read']);
    await installGrant(system, GLOBAL_CONTEXT, realmOwner.id, ['space:create', 'realm:create', 'subject:create']);

    const [publicBoard, protectedBoard] = await Promise.all([
      createBoard(system, author, 'public', 'public'),
      createBoard(system, realmOwner, 'protected', 'protected'),
    ]);
    fixture.publicBoardId = publicBoard.id;
    fixture.protectedBoardId = protectedBoard.id;
    for (const id of [...publicBoard.sourceIds, ...protectedBoard.sourceIds])
      contentPartitions.add(partitionOf(route(id)));

    const realmMembers = [author, replier, mentioned, moderator, secondModerator, reporter];
    await Promise.all(
      realmMembers.map(async (account) => {
        await Promise.all([
          setMemberRecord(system, protectedBoard.realmId, account, fixture.now, true),
          installGrant(system, protectedBoard.id, account.id, ['board:read']),
        ]);
      }),
    );
    await installGrant(system, protectedBoard.id, author.id, ['thread:create']);
    // Public Realm content is readable without membership, but creating a post
    // still requires the actual Realm participation scope and member evidence.
    // Install that evidence only for the fixture personas that author posts.
    await Promise.all(
      [author, replier, mentioned].map((account) =>
        setMemberRecord(system, publicBoard.realmId, account, fixture.now, true),
      ),
    );
    await Promise.all(
      [replier, mentioned].map((account) => installGrant(system, publicBoard.id, account.id, ['board:read'])),
    );
    await installGrant(system, protectedBoard.realmId, moderator.id, [
      'moderation:takedown',
      'moderation:read_reports',
    ]);
    await installGrant(system, protectedBoard.realmId, secondModerator.id, [
      'moderation:takedown',
      'moderation:read_reports',
    ]);
    for (const boardId of [publicBoard.id, protectedBoard.id]) {
      await installGrant(system, boardId, moderator.id, ['moderation:takedown', 'moderation:read_reports']);
      await installGrant(system, boardId, secondModerator.id, ['moderation:takedown', 'moderation:read_reports']);
    }
    const [authorCredential, replierCredential, moderatorCredential] = await Promise.all([
      system.auth.issue({
        accountId: author.id,
        clientId: system.auth.ordinaryClient.id,
        scopes: personaScopes('post:create', 'post:revise', 'realm:participate', 'thread:create'),
      }),
      system.auth.issue({
        accountId: replier.id,
        clientId: system.auth.ordinaryClient.id,
        scopes: personaScopes('post:create', 'post:revise', 'realm:participate'),
      }),
      system.auth.issue({
        accountId: moderator.id,
        clientId: system.auth.ordinaryClient.id,
        scopes: personaScopes('moderation:read_reports', 'moderation:takedown'),
      }),
    ]);
    author = accountPersona(authorCredential);
    replier = accountPersona(replierCredential);
    moderator = accountPersona(moderatorCredential);
    fixture.author = author;
    fixture.replier = replier;
    fixture.moderator = moderator;
    return {
      system,
      appDatabaseUrl: (() => {
        const url = new URL(databaseUrl);
        url.pathname = `/${namespace}_app`;
        return url.href;
      })(),
      workClock: () => new Date(currentNow),
      fixture,
      protectedRealmId: protectedBoard.realmId,
      accountPartitions,
      contentPartitions,
      async close() {
        await system.close();
      },
      remember(id) {
        contentPartitions.add(partitionOf(route(id)));
      },
      async grantModerationTarget(id, threadId) {
        for (const targetId of new Set([id, ...(threadId === undefined ? [] : [threadId])])) {
          await installGrant(system, targetId, moderator.id, ['moderation:takedown', 'moderation:read_reports']);
          await installGrant(system, targetId, secondModerator.id, ['moderation:takedown', 'moderation:read_reports']);
        }
      },
      async grantPostTarget(threadId, accountId) {
        await installGrant(system, threadId, accountId, ['post:create']);
      },
      async grantReportTarget(id, reporterId) {
        await installGrant(system, id, reporterId, ['report:create']);
      },
      async realmMember(account, member) {
        await setMemberRecord(system, protectedBoard.realmId, account, currentNow, member);
      },
      async setPreference(account, kind, allowed) {
        const path = `/v1/accounts/${account.id}/preferences`;
        const current = await api<{ version: number }>(system, account, 'GET', path);
        await expectStatus(current.response, 200, 'Notification preference read');
        if (!current.value) throw new Error('Notification preferences response is missing its version');
        const changed = await api(
          system,
          account,
          'PATCH',
          path,
          { expectedVersion: current.value.version, notifications: { [kind]: allowed } },
          randomUUID(),
        );
        // Accounts rejects attempts to disable mandatory outcomes. Exercise that
        // contract rather than storing a preference the public API cannot write.
        await expectStatus(
          changed.response,
          kind === 'moderation_decision' ? 400 : 200,
          'Notification preference write',
        );
      },
      async setAccountState(account, state) {
        await system.database.pool.query('UPDATE access.account SET state=$2 WHERE route=$1 AND account_id=$3', [
          route(account.id),
          state,
          account.id,
        ]);
      },
      async setNow(instant) {
        await system.clock.setCommandTime(instant);
        await system.clock.setCursorVerificationTime(instant);
        currentNow = instant;
      },
    };
  } catch (error) {
    await system.close();
    throw error;
  }
}

async function setMemberRecord(
  system: NativeContentSystem,
  realmId: string,
  account: Persona,
  instant: string,
  member: boolean,
): Promise<void> {
  const realmRoute = route(realmId);
  const accountRoute = route(account.id);
  const transactionId = randomUUID();
  if (member) {
    const reservationId = randomUUID();
    await system.database.pool.query(
      `INSERT INTO community.realm_member
         (route,realm_id,account_id,role,valid,reservation_id,transaction_id)
       SELECT $1,$2,$3,'member',tstzrange($4::timestamptz,NULL,'[)'),$5,$6
       WHERE NOT EXISTS (
         SELECT 1 FROM community.realm_member
         WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND valid @> $4::timestamptz
       )`,
      [realmRoute, realmId, account.id, instant, reservationId, transactionId],
    );
    await system.database.pool.query(
      `INSERT INTO access.membership_inverse
         (route,account_id,kind,group_id,reservation_id,transaction_id,source_transaction_id)
       VALUES ($1,$2,'realm',$3,$4,$5,$5)
       ON CONFLICT (route,account_id,kind,group_id) DO NOTHING`,
      [accountRoute, account.id, realmId, reservationId, transactionId],
    );
    return;
  }
  await system.database.pool.query(
    `UPDATE community.realm_member
       SET valid=tstzrange(lower(valid),$4::timestamptz,'[)'),transaction_id=$5
     WHERE route=$1 AND realm_id=$2 AND account_id=$3
       AND valid @> $4::timestamptz AND lower(valid)<$4::timestamptz`,
    [realmRoute, realmId, account.id, instant, transactionId],
  );
  await system.database.pool.query(
    `DELETE FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND account_id=$3
       AND valid @> $4::timestamptz AND lower(valid)>=$4::timestamptz`,
    [realmRoute, realmId, account.id, instant],
  );
}
