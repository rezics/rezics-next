import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { COMMON_ACTIONS, IMPORT_ACTIONS } from '../../../../specs/imports-identity-driver.ts';
import { createImportIdentityDriver } from './identity-driver.ts';
import { identitySupport } from './identity-fixture.ts';
import { observeKey } from './identity-observer.ts';

test('native operator add-key issues importer-scoped tokens, while session openings cannot install credentials', async () => {
  const driver = createImportIdentityDriver();
  try {
    const f = await driver.open({ clock: () => new Date() });
    const native = identitySupport(f);
    const claims = decodeJwt(f.bulk.bearer);
    expect(claims.sub).toBe(f.bulk.accountId);
    expect(claims.client_id).toBe(f.client.clientId);
    expect(String(claims.scope).split(' ').sort()).toEqual([...COMMON_ACTIONS, ...IMPORT_ACTIONS].sort());
    expect(await observeKey(f, f.bulk.accountId, native.credentialKid)).toBe(true);
    expect(
      (await f.access.authenticate(f.bulk.bearer, { pool: f.database.pool, deadline: Date.now() + 10000 })).accountId,
    ).toBe(f.bulk.accountId);
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    const stage = await f.auth.internal.stageCredentialEffect({
      key: 'session-cannot-add-key',
      subjectAccountId: f.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const sessionAuthorization = await native.approveOpening('session-purpose');
    await expect(
      f.auth.internal.applyCredentialEffect({
        key: stage.key,
        effectRef: stage.effectRef,
        subjectAccountId: f.bulk.accountId,
        headers: native.managementHeaders,
        authorization: sessionAuthorization,
      }),
    ).rejects.toThrow();
    expect(await observeKey(f, f.bulk.accountId, kid)).toBe(false);
    expect(await observeKey(f, f.bulk.accountId, native.credentialKid)).toBe(true);
  } finally {
    await driver.close();
  }
}, 120000);
