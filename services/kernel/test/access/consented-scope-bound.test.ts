import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { WEBSITE_CLIENT_ID, type PublicJwks } from '@rezics/auth';
import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { accessActionCatalogue, INTERNAL_ACTIONS, captureDurableInitiator } from '../../src/access/index.ts';
import { createAuthConsentReader } from '../../src/access/auth-consent.ts';
import { DurableInitiatorUnavailableError } from '../../src/access/durable-initiator.ts';
import { createWorkflowApprovals, WorkflowApprovalDeniedError } from '../../src/access/workflow-approvals.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { beginAuthorErasure } from '../../src/content/operations.ts';
import { enqueueRealmJoin } from '../../src/community/join.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { capture, measure } from '../support/growth.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../content/support/native-system.ts';
import { captureFixture, captureAttempt } from './durable-initiator-capture.test.ts';
import { createProductionAccess } from '../community/membership-fixture.ts';
import { nativeModule } from './durable-initiator.test.ts';

const maximum = Array.from({ length: MAX_CONSENTED_SCOPES }, (_, i) => `scope-${i}:`.padEnd(128, 'a'));
let h: Awaited<ReturnType<typeof nativeModule>>;
let site: NativeContentSystem;
let client: WorkClient;

beforeAll(async () => {
  site = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  h = await nativeModule(maximum[0]!);
  client = await createWorkClient(site.database.pool.options.connectionString!);
}, 120_000);
afterAll(async () => {
  await client?.close();
  await site?.close();
  await h?.close();
});

// Use the real confidential website flow, requesting the entire composition,
// including native actions that have no HTTP route.
async function websiteSession() {
  const auth = site.nativeAuth;
  const issuer = auth.verifier.issuer;
  const audience = auth.verifier.audience;
  const callback = `${issuer}/scope-bound/callback`;
  const pair = await generateKeyPair('ES256', { extractable: true });
  const kid = 'scope-bound-website';
  const scopes = [...new Set(['openid', 'offline_access', ...accessActionCatalogue(site.actions).keys()])].sort();
  await auth.internal.registerWebsiteClient({
    publicJwks: { keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' }] } as PublicJwks,
    redirectUris: [callback],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes,
  });
  const handler = auth.handler.bind(auth);
  let cookie = '';
  auth.handler = async (request) => {
    const response = await handler(request);
    if (new URL(request.url).pathname === '/signin' && response.ok)
      cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
    return response;
  };
  try {
    await site.auth.issue({
      accountId: site.actors.author.actor.accountId,
      clientId: site.auth.ordinaryClient.id,
      scopes: site.actors.author.actor.scopes,
    });
  } finally {
    auth.handler = handler;
  }
  expect(cookie).not.toBe('');
  const verifier = randomBytes(48).toString('base64url');
  const state = crypto.randomUUID();
  const authorize = new URL(`${issuer}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    redirect_uri: callback,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    nonce: state,
    resource: audience,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  const authorized = await handler(new Request(authorize, { headers: { cookie } }));
  expect(authorized.status, await authorized.clone().text()).toBe(302);
  const location = new URL(authorized.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe(state);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(WEBSITE_CLIENT_ID)
    .setSubject(WEBSITE_CLIENT_ID)
    .setAudience(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(crypto.randomUUID())
    .sign(pair.privateKey);
  const issued = await handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        grant_type: 'authorization_code',
        code: location.searchParams.get('code')!,
        redirect_uri: callback,
        code_verifier: verifier,
      }),
    }),
  );
  expect(issued.status, await issued.clone().text()).toBe(200);
  const bearer = ((await issued.json()) as { access_token: string }).access_token;
  const actor = await site.access.authenticate(bearer, { pool: site.database.pool, deadline: Date.now() + 10000 });
  expect([...actor.scopes].sort()).toEqual(scopes);
  return { actor, bearer };
}

test('the full default website catalogue commits membership and content actor snapshots and bounded approvals', async () => {
  const { actor, bearer } = await websiteSession();
  const catalogue = accessActionCatalogue(actionCatalogue(site.kernel));
  console.log(`Default kernel catalogue: ${catalogue.size} actions (${actor.scopes.length} website scopes)`);
  expect(catalogue.size).toBeLessThanOrEqual(MAX_CONSENTED_SCOPES);
  for (const action of catalogue.keys()) expect(actor.scopes).toContain(action);
  const pool = site.database.pool;
  const route = 0x7391;
  const realm = newId(route),
    space = newId(route),
    thread = newId(route);
  const spaceRevision = newId(route);
  const spaceConnection = await pool.connect();
  try {
    await spaceConnection.query('BEGIN');
    await spaceConnection.query(
      `INSERT INTO community.space
       (route,space_id,state,head_revision_id,created_at,creator)
       VALUES ($1,$2,'active',$3,statement_timestamp(),$4)`,
      [route, space, spaceRevision, actor.accountId],
    );
    await spaceConnection.query(
      `INSERT INTO community.space_revision
       (route,space_id,revision_id,predecessor,title,summary,created_at,author)
       VALUES ($1,$2,$3,NULL,'Scope bound','',statement_timestamp(),$4)`,
      [route, space, spaceRevision, actor.accountId],
    );
    await spaceConnection.query('COMMIT');
  } catch (error) {
    await spaceConnection.query('ROLLBACK');
    throw error;
  } finally {
    spaceConnection.release();
  }
  const realmConnection = await pool.connect();
  const realmRevision = newId(route);
  const contextId = newId(route);
  try {
    await realmConnection.query('BEGIN');
    await realmConnection.query(
      `INSERT INTO community.realm
    (route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
    VALUES ($1,$2,$3,'active','public',$4,$5,statement_timestamp(),$6)`,
      [route, realm, space, contextId, realmRevision, actor.accountId],
    );
    await realmConnection.query(
      `INSERT INTO community.realm_revision
       (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
       VALUES ($1,$2,$3,NULL,'Scope bound','', 'public',$4,statement_timestamp(),$5)`,
      [route, realm, realmRevision, contextId, actor.accountId],
    );
    await realmConnection.query('COMMIT');
  } catch (error) {
    await realmConnection.query('ROLLBACK');
    throw error;
  } finally {
    realmConnection.release();
  }
  const board = newId(route),
    post = newId(route),
    postRevision = newId(route),
    transaction = newId(route);
  const contentConnection = await pool.connect();
  try {
    await contentConnection.query('BEGIN');
    await contentConnection.query(
      `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
       VALUES ($1,$2,$3,$4,'scope bound','published',1,$5,$6)`,
      [route, thread, actor.accountId, board, transaction, post],
    );
    await contentConnection.query(
      `INSERT INTO content.post
       (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'published',1,$6)`,
      [route, thread, post, actor.accountId, postRevision, transaction],
    );
    await contentConnection.query(
      `INSERT INTO content.revision
       (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,convert_to('scope bound','UTF8'),sha256(convert_to('scope bound','UTF8')),
         'scope bound','CC0-1.0','{}',$5,'available',$6)`,
      [route, thread, post, postRevision, board, transaction],
    );
    await contentConnection.query('COMMIT');
  } catch (error) {
    await contentConnection.query('ROLLBACK');
    throw error;
  } finally {
    contentConnection.release();
  }
  for (const [resource, action] of [
    [realm, 'realm:join'],
    [post, 'post:erase'],
    [PLATFORM_RESOURCE.id, 'client:manage'],
  ])
    await pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'(,)',$3)`,
      [routeOf(resource!), resource, actor.accountId, action],
    );
  await enqueueRealmJoin(
    { pool, access: site.access, tokens: site.tokenKeys, client },
    {
      actor,
      realmId: realm,
      spaceId: space,
      memberAccountId: actor.accountId,
      idempotencyKey: crypto.randomUUID(),
      deadline: Date.now() + 10000,
    },
  );
  await beginAuthorErasure(
    {
      pool,
      access: site.access,
      clock: () => new Date(),
      workflows: {
        enqueue: async () => {
          throw new Error('Operation must use its durable outbox');
        },
        status: async () => null,
      },
    },
    actor,
    { threadId: thread, authorId: actor.accountId },
    {
      idempotencyKey: crypto.randomUUID(),
      requestId: newId(route),
      deadline: Date.now() + 10000,
    },
  );
  for (const table of ['community.realm_membership_operation', 'content.operation']) {
    const { rows } = await pool.query(`SELECT actor_scopes FROM ${table} WHERE initiator_account_id=$1`, [
      actor.accountId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_scopes).toEqual(actor.scopes);
  }
  const approvals = createWorkflowApprovals({
    pool,
    access: site.access,
    actions: catalogue,
    referenceKeys: site.tokenKeys,
  });
  const operation = {
    kind: 'client-reduction' as const,
    clientId: 'bounded-client',
    firstParty: false,
    scopes: maximum,
    authorization: 'bound',
  };
  const approved = await approvals.approve(
    bearer,
    { operationKey: crypto.randomUUID(), operation },
    { pool, deadline: Date.now() + 10000 },
  );
  expect(approved.reference).not.toBe('');
  await expect(
    approvals.approve(
      bearer,
      { operationKey: crypto.randomUUID(), operation: { ...operation, scopes: [...maximum, 'extra'] } },
      { pool, deadline: Date.now() + 10000 },
    ),
  ).rejects.toBeInstanceOf(WorkflowApprovalDeniedError);

  // Exercise every actual CHECK against a maximal snapshot, preserving the
  // remaining columns from a native committed row. Triggers are not copied.
  const connection = await pool.connect();
  try {
    for (const [index, table] of [
      'community.realm_membership_operation',
      'content.operation',
      'access.workflow_approval',
    ].entries()) {
      const temporary = `scope_bound_${index}`;
      await connection.query(`CREATE TEMP TABLE ${temporary} (LIKE ${table} INCLUDING CONSTRAINTS)`);
      await connection.query(`INSERT INTO ${temporary} SELECT * FROM ${table} LIMIT 1`);
      const column = index === 2 ? 'scopes' : 'actor_scopes';
      await connection.query(`UPDATE ${temporary} SET ${column}=$1`, [maximum]);
      await expect(
        connection.query(`UPDATE ${temporary} SET ${column}=$1`, [[...maximum, 'extra']]),
      ).rejects.toMatchObject({ code: '23514' });
      if (index === 0) {
        await connection.query(`ALTER TABLE ${temporary} ALTER COLUMN actor_scopes DROP NOT NULL`);
        await connection.query(`UPDATE ${temporary} SET actor_scopes=NULL`);
      }
      await connection.query(`DROP TABLE ${temporary}`);
    }
  } finally {
    connection.release();
  }
}, 120_000);

test('512 unique scopes of 128 bytes cross Auth, JWKS, consent transport, capture, restoration and SQL', async () => {
  expect(maximum.join(' ').length).toBe(MAX_CONSENTED_SCOPE_OCTETS);
  const f = await h.fixture(false, maximum);
  const input = { actorAccountId: f.id, clientId: f.clientId };
  const consent = await createCurrentConsentReader({ database: h.authPool }).readCurrentConsent(input);
  expect(consent?.scopes).toEqual([...maximum].sort());
  const read = createAuthConsentReader({
    url: 'https://auth.test/internal/v1/consents:read',
    serviceTokenId: 'worker',
    serviceTokenSecret: 'secret',
    fetch: async () => Response.json(consent),
  });
  expect((await read({ ...input, deadline: Date.now() + 10000 }))?.scopes).toEqual(consent!.scopes);
  expect(
    (
      await h.step(f, {
        onActor: async (actor) => {
          expect(actor.scopes).toHaveLength(MAX_CONSENTED_SCOPES);
        },
      })
    ).effects,
  ).toBe(1);
  const captured = await captureFixture(h.db, false, maximum);
  const stop = new Error('Stop before target write');
  await expect(
    captureAttempt(captured, async (context) => {
      await captureDurableInitiator(context, captured.actor);
      throw stop;
    }),
  ).rejects.toBe(stop);
  const { rows } = await h.db.pool.query('SELECT content.operation_scopes_valid($1::text[]) AS valid', [maximum]);
  expect(rows[0].valid).toBe(true);
}, 60000);

test('513-scope tokens and snapshots fail with typed refusals before writes or PostgreSQL CHECK failures', async () => {
  const oversized = [...maximum, 'extra'];
  const f = await h.fixture(false, maximum);
  const verifier = await createProductionAccess({ actions: [maximum[0]!] });
  const bearer = await verifier.mint(
    f.id,
    Array.from({ length: MAX_CONSENTED_SCOPES + 1 }, (_, i) => `scope:${i}`),
  );
  const token = await measure(h.db, async () => {
    await expect(verifier.access.authenticate(bearer, h.context())).rejects.toMatchObject({ status: 401 });
  });
  expect(token.cost.statements).toBe(0);
  expect(token.cost.failedStatements?.['23514'] ?? 0).toBe(0);
  const snapshot = await capture(h.db, async () => {
    await expect(
      h.step(f, {
        reader: async (...args) => {
          const record = (await h.readOperation(...args))!;
          return { ...record, actor: { ...record.actor, scopes: oversized } };
        },
      }),
    ).rejects.toBeInstanceOf(DurableInitiatorUnavailableError);
  });
  expect(snapshot.capture.statements.some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  expect(snapshot.capture.statementErrors ?? []).not.toContain('23514');
});

test('composition one action over the bound fails before Access is resolved and names both numbers', () => {
  const internal = INTERNAL_ACTIONS as Map<string, { anonymous: boolean }>;
  const original = new Map(internal);
  const mounted = actionCatalogue(site.kernel);
  const count = accessActionCatalogue(mounted).size;
  try {
    for (let i = count; i <= MAX_CONSENTED_SCOPES; i++) internal.set(`scope-bound:${i}`, { anonymous: false });
    expect(() => createKernel({ pool: site.database.pool, routeKey: site.routeKey })).toThrow(
      `Kernel action catalogue has ${MAX_CONSENTED_SCOPES + 1} actions; consented scope bound is ${MAX_CONSENTED_SCOPES}`,
    );
  } finally {
    internal.clear();
    for (const [name, metadata] of original) internal.set(name, metadata);
  }
});
