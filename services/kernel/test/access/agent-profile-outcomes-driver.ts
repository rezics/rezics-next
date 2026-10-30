import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import sharp from 'sharp';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import type {
  Account,
  AgentProfileDriver,
  AgentProfileFixture,
  Principal,
} from '../../../../specs/agent-profile-driver.ts';
import { createPool } from '../../src/database/pool.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import {
  completeAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
} from '../../src/access/agent-verification.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { projectBatch } from '../../src/events/log.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createPersonas } from '../support/personas.ts';
import { registerTestClient, testKernel } from '../support/test-kernel.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';

const write = (method: string, body: unknown, key = crypto.randomUUID()): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) },
  body: JSON.stringify(body),
});
async function checked(response: Response, operation: string) {
  if (!response.ok) throw new Error(`${operation}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function json(response: Response, operation: string) {
  return (await checked(response, operation)).json();
}

/** Own only transport, fixture inputs and native observations; Access owns every decision. */
export async function createAgentProfileDriver(): Promise<AgentProfileDriver> {
  const source = new URL(process.env.DATABASE_URL!);
  const template = source.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(template)) throw new Error('Unsafe kernel template database name');
  const name = `agent_profile_${crypto.randomUUID().replaceAll('-', '')}`;
  const maintenance = new URL(source);
  maintenance.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenance.href, max: 1 });
  let created = false;
  let pool: ReturnType<typeof createPool> | undefined;
  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await auth?.close();
      } finally {
        try {
          await pool?.end();
        } finally {
          try {
            if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          } finally {
            await admin.end();
          }
        }
      }
    })());
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    created = true;
    source.pathname = `/${name}`;
    const database = createPool(source.href);
    pool = database;
    const native = await nativeFixture(database);
    auth = native;
    const service = native.host.service;
    const kernel = testKernel({
      pool: database,
      requestDeadlineMs: 120_000,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({
        secret: 'agent-profile-native-write-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 86400 }, upload: { maximum: 10000, seconds: 86400 } },
        }),
      }),
    });
    const request: AgentProfileDriver['request'] = (credential, path, init) => {
      const headers = new Headers(init?.headers);
      if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
      return kernel.handle(new Request(`https://kernel.test${path}`, { ...init, headers }));
    };
    const command = (credential: string, path: string, body: unknown, method = 'POST') =>
      request(credential, path, write(method, body));
    await bootstrapRelease(database, bundledRelease);
    const people = await createPersonas(kernel, { version: 1, pool: database, auth: native });
    const staff = people.staff.bearer;
    for (const group of ['collections', 'agent_verification']) {
      await checked(await command(staff, `/v1/platform/exposure/${group}:open`, {}), `Open ${group}`);
    }
    for (const [person, manager, displayName] of [
      [people.alice, people.alice, 'Alice'],
      [people.bob, people.bob, 'Bob'],
      [people.organization, people.orgOwner, 'Organization'],
      [people.software, people.operator, 'Software agent'],
      [people.operator, people.operator, 'Operator'],
    ] as const) {
      await checked(
        await command(manager.bearer, `/v1/accounts/${person.accountId}`, { displayName }, 'PATCH'),
        'Initialize profile name',
      );
    }
    const scopes = [...new Set([...actionCatalogue(kernel).keys(), 'account:manage'])]
      .filter((scope) => scope !== 'media:complete')
      .sort();
    const clientId = `profile_${crypto.randomUUID()}`;
    await registerTestClient(service, { clientId, firstParty: true, scopes });
    async function signIn(accountId: string, selected = scopes, selectedClient = clientId) {
      const login = await checked(
        await native.request('/signin', {
          account_id: accountId,
          password,
          client_id: selectedClient,
          scope: selected,
        }),
        'Profile sign-in',
      );
      const headers = cookies(login);
      const token = await json(await native.request('/token', {}, headers), 'Profile token');
      return { credential: token.access_token as string, headers };
    }
    async function account(person: { accountId: string }): Promise<Account> {
      const row = await database.query(
        'SELECT handle, display_name FROM access.account WHERE route=$1 AND account_id=$2',
        [routeOf(person.accountId), person.accountId],
      );
      return {
        accountId: person.accountId,
        handle: row.rows[0].handle,
        displayName: row.rows[0].display_name,
        subjectId: accountAgentId(person.accountId),
      };
    }
    async function principal(person: { accountId: string; bearer: string }): Promise<Principal> {
      return { ...(await account(person)), credential: person.bearer };
    }
    const alice = await principal(people.alice);
    const bob = await principal(people.bob);
    const organization = await account(people.organization);
    const operator = await principal(people.operator);
    const software = { ...(await principal(people.software)), operator };
    // Retain the native persona's stale credential; never issue a suspended bearer.
    const suspended = await principal(people.suspended);
    for (const [person, kind] of [
      [alice, 'person'],
      [bob, 'person'],
      [organization, 'organization'],
      [software, 'software'],
      [operator, 'person'],
    ] as const) {
      await ensureAccountAgent(database, { account: person.accountId, kind, name: person.displayName, language: 'en' });
    }
    const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
    const document = {
      root: { props: {} },
      content: [
        node('SubjectHeader', 'header'),
        node('AccountIdentity', 'identity'),
        node('AccountPosts', 'posts', { limit: 20 }),
        node('AccountCollections', 'collections', { limit: 24 }),
      ],
    };
    const profile: PresentationProfile = {
      format: PROFILE_FORMAT,
      generic: document,
      bases: [],
      routes: [],
      types: ['schema:Organization', 'schema:Person', 'schema:SoftwareApplication'].map((type) => ({
        type,
        views: { overview: document },
      })),
    };
    await bootstrapProfile(database, profile);
    // Prove that the revoked Alice session previously had working profile authority.
    const revokedClient = `revoked_profile_${crypto.randomUUID()}`;
    await registerTestClient(service, { clientId: revokedClient, firstParty: false, scopes });
    const consentSession = await signIn(alice.accountId);
    await checked(
      await native.request('/consent', { client_id: revokedClient, scope: scopes }, consentSession.headers),
      'Grant profile client consent',
    );
    const oldAlice = await signIn(alice.accountId, scopes, revokedClient);
    await checked(
      await command(
        oldAlice.credential,
        `/v1/accounts/${alice.accountId}`,
        { biography: 'Initial public biography' },
        'PATCH',
      ),
      'Pre-revocation profile edit',
    );
    // Consent revocation advances the native floor without the recovery fence of an account-wide revocation.
    await checked(
      await native.request('/consent', { client_id: revokedClient, scope: [] }, oldAlice.headers),
      'Revoke profile client consent',
    );
    const revoked = { ...alice, credential: oldAlice.credential };
    alice.credential = (await signIn(alice.accountId)).credential;

    // Ordinary commands create one public reply and one public Collection for Alice.
    await checked(
      await command(staff, '/v1/grants', {
        resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
        subject: { kind: 'account', id: alice.accountId },
        actions: ['space:create', 'realm:create', 'subject:create'],
        valid: '(,)',
      }),
      'Grant parent creation',
    );
    const space = (
      await json(
        await command(alice.credential, '/v1/spaces', { title: 'Profile community', summary: '' }),
        'Create Space',
      )
    ).space;
    const realm = (
      await json(
        await command(alice.credential, '/v1/realms', {
          spaceId: space.spaceId,
          title: 'Profile community',
          summary: '',
          visibility: 'public',
          contextId: '00000000-0000-8000-8000-000000000000',
        }),
        'Create Realm',
      )
    ).realm;
    const scheme = (
      await json(
        await command(alice.credential, '/v1/subjects', {
          type: 'skos:ConceptScheme',
          labels: { en: 'Profile boards' },
        }),
        'Create scheme',
      )
    ).subject;
    const concept = (
      await json(
        await command(alice.credential, '/v1/subjects', {
          type: 'skos:Concept',
          labels: { en: 'Profile discussion' },
          statements: {
            'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
          },
        }),
        'Create concept',
      )
    ).subject;
    const schemeInit = write('PUT', { schemeId: scheme.id });
    schemeInit.headers = { ...schemeInit.headers, 'if-match': JSON.stringify(realm.headRevisionId) };
    await checked(
      await request(alice.credential, `/v1/realms/${realm.realmId}/boardScheme`, schemeInit),
      'Set board scheme',
    );
    const board = (
      await json(
        await command(alice.credential, `/v1/realms/${realm.realmId}/boards`, {
          conceptId: concept.id,
          title: 'Profile board',
          visibility: 'published',
        }),
        'Create board',
      )
    ).board;
    const thread = (
      await json(
        await command(alice.credential, '/v1/threads', {
          boardId: board.id,
          title: 'Public discussion',
          body: fromPlainText('Opening discussion'),
          licence: 'MIT',
          subjectIds: [],
          visibility: 'published',
        }),
        'Create thread',
      )
    ).thread;
    const post = (
      await json(
        await command(alice.credential, `/v1/threads/${thread.id}/posts`, {
          body: fromPlainText('Public reply'),
          licence: 'MIT',
        }),
        'Create reply',
      )
    ).post;
    const collection = (
      await json(
        await command(alice.credential, '/v1/collections', { title: 'Public reading list', visibility: 'public' }),
        'Create Collection',
      )
    ).collection;
    const authorEffect = createAuthorItemEffect(database);
    const projection = linkProjection(database);
    async function drain() {
      const partitions = (
        await database.query<{ partition_no: number }>('SELECT partition_no FROM core.partition WHERE position > 0')
      ).rows;
      for (const { partition_no: partition } of partitions) {
        for (let round = 0; round < 100; round++) {
          const result = await projectBatch(database, {
            consumer: 'agent_profile_authors',
            partition,
            envelopes: 64,
            async apply(envelopes) {
              for (const envelope of envelopes)
                for (const event of envelope.events)
                  if (authorEffect.types.includes(event.type)) await authorEffect.run(event);
            },
          });
          if (result.status !== 'read') throw new Error(`Author projection ${result.status}`);
          if (result.envelopes === 0) break;
          if (round === 99) throw new Error('Author projection did not drain');
        }
      }
      for (let round = 0; round < 100; round++) {
        let progressed = false;
        for (const { partition_no: partition } of partitions) {
          const result = await projection.run(partition);
          if (result.status !== 'read') throw new Error(`Link projection ${result.status}`);
          progressed ||= result.envelopes > 0;
        }
        if (!progressed) return;
      }
      throw new Error('Link projection did not drain');
    }
    await drain();
    const privateRows = await native.authPool.query('SELECT email FROM "user" WHERE email IS NOT NULL');
    const credentials = await native.authPool.query('SELECT password FROM account WHERE password IS NOT NULL');
    const privateValues = [
      ...new Set([
        password,
        ...privateRows.rows.map((row) => row.email as string),
        ...credentials.rows.map((row) => row.password as string),
        alice.credential,
        bob.credential,
        software.credential,
        operator.credential,
        revoked.credential,
        people.revoked.bearer,
      ]),
    ];
    const fixture: AgentProfileFixture = {
      alice,
      bob,
      organization,
      software,
      suspended,
      revoked,
      anonymous: null,
      privateValues,
      publicPostId: post.id,
      publicCollectionId: collection.id,
    };

    // Only avatar completion needs Auth's confidential website client.
    const pair = await generateKeyPair('ES256');
    const publicKey = await exportJWK(pair.publicKey);
    const redirect = `${issuer}/profile/callback`;
    const websiteScopes = ['openid', 'offline_access', 'media:create', 'media:complete', 'media:read_reservation'];
    await service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [
          {
            kty: 'EC',
            crv: 'P-256',
            x: publicKey.x!,
            y: publicKey.y!,
            kid: 'profile-website',
            alg: 'ES256',
            use: 'sig',
          },
        ],
      },
      redirectUris: [redirect],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: websiteScopes,
    });
    async function websiteBearer(person: Principal) {
      const login = await signIn(person.accountId);
      const verifier = randomBytes(48).toString('base64url');
      const state = crypto.randomUUID();
      const query = new URLSearchParams({
        client_id: 'rezics-website',
        redirect_uri: redirect,
        response_type: 'code',
        scope: websiteScopes.join(' '),
        state,
        nonce: state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://ordinary.api.test',
      });
      const authorization = await service.handler(
        new Request(`${issuer}/authorize?${query}`, { headers: login.headers }),
      );
      if (![302, 303].includes(authorization.status))
        throw new Error(`Website authorization: ${authorization.status} ${await authorization.text()}`);
      const location = new URL(authorization.headers.get('location')!);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'profile-website' })
        .setIssuer('rezics-website')
        .setSubject('rezics-website')
        .setAudience(issuer)
        .setIssuedAt()
        .setExpirationTime('2m')
        .setJti(crypto.randomUUID())
        .sign(pair.privateKey);
      const token = await json(
        await service.handler(
          new Request(`${issuer}/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: 'rezics-website',
              client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
              client_assertion: assertion,
              resource: 'https://ordinary.api.test',
              grant_type: 'authorization_code',
              code: location.searchParams.get('code')!,
              redirect_uri: redirect,
              code_verifier: verifier,
            }),
          }),
        ),
        'Website token',
      );
      return token.access_token as string;
    }
    return {
      fixture: async () => fixture,
      request,
      async unscoped(action) {
        return (
          await signIn(
            alice.accountId,
            scopes.filter((scope) => scope !== action),
          )
        ).credential;
      },
      async suspend(person) {
        await checked(
          await command(staff, `/v1/accounts/${person.accountId}:suspend`, {
            reason: 'Private profile suspension witness',
          }),
          'Suspend account',
        );
      },
      async verifyPerson(person) {
        const subject = (
          await json(
            await command(person.credential, '/v1/subjects', {
              type: 'schema:Person',
              labels: { en: 'Catalogue person' },
            }),
            'Create Person',
          )
        ).subject;
        const submission = await command(person.credential, `/v1/accounts/${person.accountId}:requestVerification`, {
          subject: subject.id,
          statement: 'Private verification witness',
          links: [{ label: 'Evidence', url: 'https://example.test/private-profile-proof' }],
        });
        const submitted = await json(submission.clone(), 'Request verification');
        const approval = await command(
          staff,
          `/v1/verification-requests/${submitted.verificationRequest.id}:approve`,
          {},
        );
        await checked(approval.clone(), 'Approve verification');
        const decision = (await readAgentVerificationWorkflowRequest(database, submitted.verificationRequest.id))!;
        const workflow = { ...decision, receiptId: decision.decisionReceiptId! };
        await recordPendingAgentVerification(database, workflow, () => new Date());
        await mergeVerifiedAgent(database, workflow);
        await writeAgentVerificationPage(database, workflow);
        await completeAgentVerification(database, workflow, () => new Date());
        await finishAgentVerification(database, workflow, () => new Date());
        await drain();
        return { subjectId: subject.id, request: submission, approval };
      },
      async uploadAvatar(uploader, state) {
        const bearer = await websiteBearer(uploader);
        const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
          .png()
          .toBuffer();
        const reservationKey = crypto.randomUUID();
        const reservation = await json(
          await request(
            bearer,
            '/v1/media',
            write(
              'POST',
              {
                containerId: uploader.accountId,
                purpose: 'avatar',
                mediaType: 'image/png',
                byteCount: bytes.byteLength,
              },
              reservationKey,
            ),
          ),
          'Reserve avatar',
        );
        const mediaId = reservation.media.id as string;
        if (state === 'completed') {
          const objects = new Map<string, Uint8Array>([[`m/${mediaId}/original`, bytes]]);
          const storage: MediaStorage = {
            async get(key) {
              return objects.get(key) ?? null;
            },
            async put(key, value) {
              objects.set(key, value);
            },
            async deletePrefix(prefix) {
              for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
            },
          };
          await checked(
            await command(bearer, `/v1/media/${mediaId}:complete`, {
              containerId: uploader.accountId,
              reservationRequestId: reservationKey,
              byteCount: bytes.byteLength,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }),
            'Complete avatar',
          );
          const processed = await createImageJob(database, storage).process(mediaId);
          if (processed.state !== 'available') throw new Error(`Avatar processing: ${processed.state}`);
        }
        return { mediaId };
      },
      async inspect(person) {
        const values = [routeOf(person.accountId), person.accountId];
        const profileRows = await database.query(
          'SELECT * FROM access.account WHERE route=$1 AND account_id=$2',
          values,
        );
        const preferences = await database.query(
          'SELECT * FROM access.account_preferences WHERE route=$1 AND account_id=$2',
          values,
        );
        const verification = await database.query(
          'SELECT * FROM access.agent_verification_request WHERE route=0 AND account_id=$1 ORDER BY request_id',
          [person.accountId],
        );
        const receipts = await database.query(
          "SELECT transaction_id::text AS id, to_jsonb(r) AS value FROM core.receipt r WHERE command_kind='access.account-updated' AND response->>'accountId'=$1 ORDER BY transaction_id",
          [person.accountId],
        );
        const events = await database.query(
          "SELECT id::text AS id, to_jsonb(o) AS data FROM core.outbox o WHERE type='com.rezics.access.account-updated.v1' AND subject=$1 AND (partition_no,epoch,position) IN (SELECT partition_no,epoch,position FROM core.receipt WHERE transaction_id=ANY($2::uuid[])) ORDER BY id",
          [person.accountId, receipts.rows.map((row) => row.id)],
        );
        return {
          profile: profileRows.rows,
          preferences: preferences.rows,
          verification: verification.rows,
          receipts: receipts.rows,
          events: events.rows,
        };
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Agent profile setup and cleanup failed');
    }
    throw error;
  }
}
