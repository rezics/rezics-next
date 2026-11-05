import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { WEBSITE_CLIENT_ID, type PublicJwks } from '../src/index.ts';
import { createNativeWorkflowProofPorts } from '../src/native-workflow-proofs.ts';
import { nativeErasurePage } from '../src/erasure-native.ts';
import { failNativeQueries, issuer, nativeFixture, password, scopes } from './support/erasure-native.ts';

// Native boundary evidence for the specification slice. Proposed personal-write
// interfaces are deliberately not manufactured by a fixture. Historical SQL below
// supplies unknown payload, never role coverage, consumer proof or terminal truth.
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

async function eventually(probe: () => Promise<boolean>) {
  const until = Date.now() + 60_000;
  while (!(await probe())) {
    if (Date.now() >= until) throw new Error('Native metadata boundary did not reach its held stage');
    await Bun.sleep(100);
  }
}

async function website(kid: string) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return {
    publicJwks: {
      keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: 'ES256', use: 'sig' }],
    } as PublicJwks,
    redirectUris: [`${issuer}/website/callback`],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes: ['openid', 'offline_access', 'media:complete'],
  };
}

async function obligation(accountId: string) {
  const row = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [accountId])).rows[0];
  expect(row).toBeDefined();
  expect(row.barrier).toBeGreaterThanOrEqual(0);
  return row;
}

describe('actual client contacts resource metadata and private creation records have complete native party scope and a bounded owner erasure lifecycle without arbitrary JSON inference', () => {
  test('mechanical registration preserves exact party and scope sets, rolls back before copy commit, and leaves the dedicated Auth client at two scopes', async () => {
    const clientId = randomUUID();
    const restore = failNativeQueries(f.pool, (sql) => sql.includes('INSERT INTO auth_client_coverage'));
    try {
      await expect(
        f.host.service.internal.registerClient({ clientId, firstParty: true, scopes, displayName: 'Native client' }),
      ).rejects.toThrow('Injected native consumer interruption');
    } finally {
      restore();
    }
    expect((await f.pool.query('SELECT 1 FROM auth_client WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM auth_client_coverage WHERE client_id=$1', [clientId])).rowCount).toBe(0);

    // Extra fields from an untyped caller cannot turn this actual mechanical
    // producer into an owner/contact approval or install attribution context.
    const untrusted = {
      clientId,
      firstParty: true,
      scopes,
      displayName: 'Native client',
      contacts: ['foreign@example.test'],
      metadata: { actorAccountId: 'caller-invented', principalAccountId: 'caller-invented' },
      ownerAccountId: 'caller-invented',
    };
    await f.host.service.internal.registerClient(untrusted);
    const original = (await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', [clientId])).rows[0]!;
    expect(original).toMatchObject({ contacts: null, metadata: null, userId: null, display_name: 'Native client' });
    await f.host.service.internal.registerClient({
      clientId,
      firstParty: true,
      scopes: [...scopes].reverse(),
      displayName: 'Must not replace',
      mode: 'create-or-match',
    });
    expect((await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', [clientId])).rows[0]).toEqual(original);
    for (const mismatch of [
      { firstParty: false, scopes },
      { firstParty: true, scopes: scopes.slice(1) },
      { firstParty: true, scopes: [...scopes, 'client:manage'] },
    ]) {
      await expect(
        f.host.service.internal.registerClient({ clientId, ...mismatch, mode: 'create-or-match' }),
      ).rejects.toThrow();
      expect((await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', [clientId])).rows[0]).toEqual(
        original,
      );
    }
    const pageClient = (
      await f.pool.query('SELECT first_party,scopes,contacts,metadata FROM auth_client WHERE client_id=$1', [
        AUTH_PAGE_OPERATION_CLIENT_ID,
      ])
    ).rows[0]!;
    expect(pageClient.first_party).toBe(true);
    expect([...pageClient.scopes].sort()).toEqual(
      [...new Set(Object.values(AUTH_PAGE_OPERATION_SCOPES).flat())].sort(),
    );
    expect(pageClient.scopes).toHaveLength(2);
    expect(pageClient.contacts).toBeNull();
    expect(pageClient.metadata).toBeNull();
    await expect(
      f.host.service.internal.registerClient({
        clientId: 'forbidden-metadata-scope',
        firstParty: true,
        scopes: ['media:complete'],
      }),
    ).rejects.toThrow();
  });

  test('the real website resource/link producer rolls replacement back atomically, rotates configuration and creates no personal metadata authority', async () => {
    const initial = await website('metadata-initial');
    await f.host.service.internal.registerWebsiteClient(initial);
    const before = (await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', [WEBSITE_CLIENT_ID])).rows[0]!;
    const replacement = await website('metadata-replacement');
    const restore = failNativeQueries(f.pool, (sql) => sql.includes('INSERT INTO "oauthClientResource"'));
    try {
      await expect(f.host.service.internal.registerWebsiteClient(replacement)).rejects.toThrow();
    } finally {
      restore();
    }
    expect((await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', [WEBSITE_CLIENT_ID])).rows[0]).toEqual(
      before,
    );
    await f.host.service.internal.registerWebsiteClient(replacement);
    const client = (
      await f.pool.query('SELECT jwks,contacts,metadata,"userId" FROM auth_client WHERE client_id=$1', [
        WEBSITE_CLIENT_ID,
      ])
    ).rows[0]!;
    expect(JSON.parse(client.jwks)).toEqual(replacement.publicJwks);
    expect(client).toMatchObject({ contacts: null, metadata: null, userId: null });
    const link = (await f.pool.query('SELECT * FROM "oauthClientResource" WHERE "clientId"=$1', [WEBSITE_CLIENT_ID]))
      .rows;
    expect(link).toHaveLength(1);
    expect(link[0]!.metadata).toBeNull();
    const resource = (await f.pool.query('SELECT * FROM "oauthResource" WHERE identifier=$1', [link[0]!.resourceId]))
      .rows[0]!;
    expect(resource).toMatchObject({ name: 'REZICS API', accessTokenTtl: 300, metadata: null, customClaims: null });
    expect(resource.allowedScopes).toEqual(replacement.scopes);
    // A service audience is not a synthetic owner or a new contact principal.
    expect(link[0]!.resourceId).toBe('https://native-erasure.api.test');
  });

  test('rotated website issuer keys and caller-invented issuer identities cannot replay a native assertion into a new private copy', async () => {
    const old = await generateKeyPair('ES256', { extractable: true });
    const oldRegistration = await website('metadata-active');
    oldRegistration.publicJwks = {
      keys: [{ ...(await exportJWK(old.publicKey)), kid: 'metadata-old', alg: 'ES256', use: 'sig' }],
    } as PublicJwks;
    await f.host.service.internal.registerWebsiteClient(oldRegistration);
    await f.host.service.internal.registerWebsiteClient(await website('metadata-new'));
    const before = (
      await f.pool.query('SELECT count(*)::int AS n FROM "oauthClientAssertion" WHERE erasure_client_id=$1', [
        WEBSITE_CLIENT_ID,
      ])
    ).rows[0]!.n;
    const at = Math.floor(Date.now() / 1000);
    for (const assertedIssuer of [WEBSITE_CLIENT_ID, 'caller-invented-issuer']) {
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'metadata-old' })
        .setIssuer(assertedIssuer)
        .setSubject(WEBSITE_CLIENT_ID)
        .setAudience(issuer)
        .setIssuedAt(at)
        .setExpirationTime(at + 120)
        .setJti(randomUUID())
        .sign(old.privateKey);
      const request = () =>
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: WEBSITE_CLIENT_ID,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: assertion,
            grant_type: 'refresh_token',
            refresh_token: 'unissued-refresh-reference',
            resource: 'https://native-erasure.api.test',
          }),
        });
      expect((await f.host.handler(request())).status).not.toBe(200);
      expect((await f.host.handler(request())).status).not.toBe(200);
    }
    expect(
      (
        await f.pool.query('SELECT count(*)::int AS n FROM "oauthClientAssertion" WHERE erasure_client_id=$1', [
          WEBSITE_CLIENT_ID,
        ])
      ).rows[0]!.n,
    ).toBe(before);
  });

  test('a historical opaque creation descriptor cannot name a foreign person into native creator or operator roles; its actual subject erasure still drains the stage', async () => {
    const subject = await f.person('metadata-legacy-stage-subject');
    const foreign = await f.person('metadata-legacy-stage-foreign');
    const stage = (
      await f.pool.query('SELECT registration_id FROM auth_registration_stage WHERE account_id=$1', [subject.accountId])
    ).rows[0]!;
    // Reconstruct an old unknown descriptor on an actual completed producer row.
    // No source proof, role column or terminal consumer result is synthesized.
    await f.pool.query('UPDATE auth_registration_stage SET creation_binding=$2 WHERE registration_id=$1', [
      stage.registration_id,
      JSON.stringify({
        legacy: { creator: foreign.accountId, email: foreign.email },
        encrypted: 'opaque-unclassified-format',
      }),
    ]);
    const deletion = await f.delete(foreign);
    expect(deletion.status).toBe(200);
    const roles = (
      await f.pool.query(
        'SELECT account_id,erasure_creator_id,erasure_operator_id FROM auth_registration_stage WHERE registration_id=$1',
        [stage.registration_id],
      )
    ).rows[0]!;
    expect(roles).toEqual({ account_id: subject.accountId, erasure_creator_id: null, erasure_operator_id: null });
    // Payload disposition is whole-field purge, never guessed party attribution;
    // do not require this unknown private descriptor to survive a future scrub.
    expect((await obligation(foreign.accountId)).applicable).toBe(true);
    expect((await f.delete(subject)).status).toBe(200);
    expect(
      (await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE registration_id=$1', [stage.registration_id]))
        .rowCount,
    ).toBe(0);
  }, 120_000);

  test('historical foreign contacts and resource metadata never infer account roles from strings, while deletion stays pending for unresolved custody', async () => {
    const owner = await f.person('metadata-owner');
    const related = await f.person('metadata-related');
    const clientId = randomUUID();
    await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
    // Historical import: there was no native typed contact producer. Deliberate
    // account-looking strings are not source-approved related-party evidence.
    await f.pool.query('UPDATE auth_client SET "userId"=$2,contacts=$3,metadata=$4 WHERE client_id=$1', [
      clientId,
      owner.accountId,
      JSON.stringify([related.email]),
      JSON.stringify({ subject: related.accountId, principal: related.accountId, notes: related.email }),
    ]);
    await f.pool.query('UPDATE "oauthResource" SET metadata=$2 WHERE identifier=$1', [
      'https://native-erasure.api.test',
      JSON.stringify({ clientOwner: owner.accountId, contact: related.email }),
    ]);
    const response = await f.delete(related);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { accountId: related.accountId },
    });
    // Do not freeze retention of unknown payload: the adopted legacy scrub may
    // purge it wholesale. The living owner's client must not be reassigned or
    // destroyed merely because the historical JSON contains another account ID.
    expect((await f.pool.query('SELECT "userId" FROM auth_client WHERE client_id=$1', [clientId])).rows[0]).toEqual({
      userId: owner.accountId,
    });
    expect(
      (await f.pool.query('SELECT 1 FROM "oauthResource" WHERE identifier=$1', ['https://native-erasure.api.test']))
        .rowCount,
    ).toBe(1);
    const row = await obligation(related.accountId);
    expect(row.applicable).toBe(true);
    expect(row.consent_completed_at).toBeNull();
    expect(row.consent_due_at.getTime() - row.user_deleted_at.getTime()).toBeGreaterThan(309_000);
    expect(row.consent_due_at.getTime() - row.user_deleted_at.getTime()).toBeLessThan(311_000);
    const replay = await f.host.service.internal.startAccountErasure(related.accountId);
    expect(replay).toBe(row.id);
    expect((await obligation(related.accountId)).consent_due_at).toEqual(row.consent_due_at);
  }, 120_000);

  test('an erased client owner cannot apply or replay a living subject encrypted credential stage or revoke that subject independent credentials', async () => {
    const owner = await f.person('metadata-client-owner');
    const subject = await f.person('metadata-living-subject');
    const clientId = randomUUID();
    await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
    await f.pool.query('UPDATE auth_client SET "userId"=$2,contacts=$3 WHERE client_id=$1', [
      clientId,
      owner.accountId,
      JSON.stringify([subject.email]),
    ]);
    const session = await f.login(subject, clientId);
    const staged = await f.host.service.internal.stageCredentialEffect({
      key: randomUUID(),
      subjectAccountId: subject.accountId,
      headers: new Headers({ cookie: session.cookie }),
      credential: { kind: 'password', password: 'must never become the living password' },
    });
    const apply = { ...staged, subjectAccountId: subject.accountId, headers: new Headers({ cookie: session.cookie }) };
    const approval = await f.host.service.internal.approveCredentialEffect(apply);
    const receipt = (
      await f.pool.query('SELECT * FROM auth_effect_receipt WHERE effect_reference=$1', [staged.effectRef])
    ).rows[0]!;
    expect(receipt.account_id).toBe(subject.accountId);
    expect(receipt.client_id).toBe(clientId);
    expect(receipt.stage_ciphertext).not.toBeNull();
    const response = await f.delete(owner);
    expect(response.status).toBe(200);
    const proof = (
      await f.pool.query('SELECT outcome FROM auth_native_credential_terminal WHERE receipt_id=$1', [
        receipt.receipt_id,
      ])
    ).rows[0];
    expect(proof).toEqual({ outcome: 'fenced-refusal' });
    expect((await f.pool.query('SELECT 1 FROM auth_client WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    expect(
      (await f.pool.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=$1', [receipt.receipt_id])).rowCount,
    ).toBe(0);
    await expect(
      f.host.service.internal.applyCredentialEffect({ ...apply, authorization: approval.reference }),
    ).rejects.toThrow();
    await expect(f.host.service.internal.registerClient({ clientId, firstParty: true, scopes })).rejects.toThrow();
    const independent = await f.login(subject);
    expect(independent.accountId).toBe(subject.accountId);
    expect((await f.bindings.workflowPorts.readAccount(subject.accountId))!.state).toBe('active');
    expect((await obligation(owner.accountId)).applicable).toBe(true);
  }, 120_000);

  test('distinct native creator and organization operator keep real encrypted creation and release bindings after a source interruption; changed replay cannot replace them', async () => {
    let governor = await f.person('metadata-governor');
    await f.bootstrapGovernance(governor.accountId);
    const governScopes = [...scopes, 'access:grant', 'organization:create'];
    const governanceClient = randomUUID();
    await f.host.service.internal.registerClient({
      clientId: governanceClient,
      firstParty: true,
      scopes: governScopes,
    });
    governor = await f.login(governor, governanceClient, governScopes);
    const organizationKey = randomUUID();
    const organizationOperation = {
      kind: 'organization' as const,
      handle: `op_${organizationKey.replaceAll('-', '')}`,
      authorization: 'approval-request',
    };
    const organizationApproval = await f.approvals.approve(
      governor.bearer,
      { operationKey: organizationKey, operation: organizationOperation },
      f.context(),
    );
    const operator = await f.host.workflows.createOrganization({
      key: organizationKey,
      handle: organizationOperation.handle,
      authorization: organizationApproval.reference,
    });
    if (!('accountId' in operator)) throw new Error('Native operator organization was not created');
    const creator = await f.person('metadata-native-creator');
    const actor = await f.access.authenticate(governor.bearer, f.context());
    await f.bindings.grants.create(
      { ...f.context(), actor },
      {
        resource: { route: f.routeOf(operator.accountId)!, id: operator.accountId },
        subjectId: creator.accountId,
        subjectRole: '',
        actions: ['account:manage'],
        valid: '(,)',
        key: randomUUID(),
      },
    );
    const key = randomUUID();
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operatorAccountId: operator.accountId,
      handle: `auto_${key.replaceAll('-', '')}`,
      operationKey: key,
      authorization: 'approval-request',
    };
    const approval = await f.approvals.approve(creator.bearer, { operationKey: key, operation }, f.context());
    const input = {
      key,
      handle: operation.handle,
      operatorAccountId: operator.accountId,
      authorization: approval.reference,
      credential: { email: `${key}@metadata.test`, password },
    };
    // Fail before a real source call. This provides no invented success/result
    // and leaves actual native pending/handle/operator reservations intact.
    const provisioning = f.bindings.workflowPorts.provisioningReference;
    f.bindings.workflowPorts.provisioningReference = async () => {
      throw new Error('Source interruption before provisioning');
    };
    try {
      await expect(f.host.workflows.createAutomated(input)).rejects.toThrow();
    } finally {
      f.bindings.workflowPorts.provisioningReference = provisioning;
    }
    const stage = (
      await f.pool.query(
        'SELECT * FROM auth_registration_stage WHERE erasure_creator_id=$1 AND erasure_operator_id=$2',
        [creator.accountId, operator.accountId],
      )
    ).rows[0]!;
    expect(stage).toBeDefined();
    expect(stage.account_id).not.toBe(creator.accountId);
    expect(stage.account_id).not.toBe(operator.accountId);
    expect(stage.ciphertext).toBeInstanceOf(Buffer);
    expect(stage.ciphertext.includes(Buffer.from(input.credential.email))).toBe(false);
    expect(stage.creation_binding.authorization).toBeUndefined();
    expect(stage.operator_reservation_id).toBeString();
    const proofs = createNativeWorkflowProofPorts({ database: f.pool });
    expect(
      await proofs.creationBinding!({
        registrationId: stage.registration_id,
        operationKey: key,
        accountId: stage.account_id,
        reservationId: stage.reservation_id,
      }),
    ).toEqual(stage.creation_binding);
    expect(
      await proofs.creationBinding!({ registrationId: stage.registration_id, operationKey: randomUUID() }),
    ).toBeNull();
    expect(
      await proofs.creationBinding!({
        registrationId: stage.registration_id,
        operationKey: key,
        accountId: operator.accountId,
      }),
    ).toBeNull();
    await expect(
      f.host.workflows.createAutomated({ ...input, handle: `changed_${key.replaceAll('-', '')}` }),
    ).rejects.toThrow();
    expect(
      (
        await f.pool.query('SELECT creation_binding FROM auth_registration_stage WHERE registration_id=$1', [
          stage.registration_id,
        ])
      ).rows[0]!.creation_binding,
    ).toEqual(stage.creation_binding);

    void f.delete(creator).catch(() => {});
    await eventually(
      async () =>
        (
          await f.pool.query('SELECT ciphertext FROM auth_registration_stage WHERE registration_id=$1', [
            stage.registration_id,
          ])
        ).rows[0]?.ciphertext === null,
    );
    const held = (
      await f.pool.query('SELECT * FROM auth_registration_stage WHERE registration_id=$1', [stage.registration_id])
    ).rows[0]!;
    expect(held.credential_digest).toBeNull();
    expect(held.operator_reservation_id).toBe(stage.operator_reservation_id);
    expect(held.reservation_id).toBe(stage.reservation_id);
    expect(held.expires_at).toEqual(stage.expires_at);
    expect((await f.bindings.workflowPorts.readAccount(operator.accountId))!.state).toBe('active');
    expect((await f.bindings.workflowPorts.readAccount(stage.account_id))!.state).toBe('pending');
    expect(
      (
        await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='registration' AND key=$1", [
          stage.registration_id,
        ])
      ).rowCount,
    ).toBe(0);
    const pending = await obligation(creator.accountId);
    expect(await nativeErasurePage(f.pool, pending.id)).toMatchObject({
      id: pending.id,
      state: 'pending',
      code: 'native-stage',
    });
  }, 180_000);
});
