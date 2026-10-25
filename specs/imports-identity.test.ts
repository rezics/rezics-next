import { expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AccessTokenClaims, PublicJwks } from '@rezics/auth';
import {
  BULK_ACTION,
  COMMON_ACTIONS,
  GLOBAL,
  IMPORT_ACTIONS,
  MISSING_IMPORT_IDENTITY,
} from './imports-identity-driver.ts';
import type { ImportIdentityDriver, Stage } from './imports-identity-driver.ts';
import type { ImportCredential, ImportIdentity } from '../services/kernel/test/imports/identity-fixture.ts';
import type { Resource } from '../services/kernel/src/request/access.ts';

setDefaultTimeout(120_000);
async function scenario(run: (driver: ImportIdentityDriver) => Promise<void>) {
  const location = process.env.IMPORT_IDENTITY_DRIVER;
  if (!location) throw new Error(MISSING_IMPORT_IDENTITY);
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_IDENTITY_DRIVER must be an absolute file path/URL');
  const binding = await import(url.href);
  const driver: ImportIdentityDriver = await binding.createImportIdentityDriver();
  try {
    await run(driver);
  } finally {
    await driver.close();
  }
}
const clock = () => new Date();
async function fixture(driver: ImportIdentityDriver, run: (identity: ImportIdentity) => Promise<void>) {
  const identity = await driver.open({ clock });
  try {
    await run(identity);
  } finally {
    try {
      await identity.close();
    } finally {
      await driver.release(identity);
    }
  }
}
async function permits(f: ImportIdentity, credential: ImportCredential, action: string, resource = GLOBAL) {
  // Use production authentication, evidence preparation and final formula, never an adapter evaluator.
  const { accessCheck } = await import('../services/kernel/src/request/access.ts');
  const { withConnection } = await import('../services/kernel/src/database/pool.ts');
  const context = { pool: f.database.pool, deadline: Date.now() + 10_000 };
  const actor = await f.access.authenticate(credential.bearer, context);
  const check = await accessCheck(f.access, actor, action, resource, context);
  return withConnection(f.database.pool, (client) => check(client));
}
async function authority(f: ImportIdentity, credential: ImportCredential, bulk: boolean, restricted = bulk) {
  for (const action of COMMON_ACTIONS) expect(await permits(f, credential, action)).toBe(true);
  for (const action of IMPORT_ACTIONS)
    expect(await permits(f, credential, action)).toBe(action === BULK_ACTION ? bulk : restricted);
  expect(await permits(f, credential, 'media:complete')).toBe(false);
}

test('Auth-issued credentials verify exact subjects client scopes and current account state', () =>
  scenario((d) =>
    fixture(d, async (f) => {
      const jwks = await f.auth.handler(new Request(f.auth.verifier.jwksUrl));
      expect(jwks.status).toBe(200);
      const keys: PublicJwks = await jwks.json();
      expect(f.client.firstParty).toBe(false);
      expect(new Set([f.governance.accountId, f.bulk.accountId, f.ordinary.accountId]).size).toBe(3);
      for (const credential of [f.governance, f.bulk, f.ordinary]) {
        // Decoding is only observation; production Access below verifies the token.
        const [header, body] = credential.bearer.split('.');
        const payload: AccessTokenClaims = JSON.parse(Buffer.from(body!, 'base64url').toString());
        const metadata = JSON.parse(Buffer.from(header!, 'base64url').toString());
        expect(metadata.alg).toBe('ES256');
        expect(keys.keys.some((key) => key.kid === metadata.kid)).toBe(true);
        expect(payload.iss).toBe(f.auth.verifier.issuer);
        expect(payload.aud).toBe(f.auth.verifier.audience);
        expect(payload.sub).toBe(credential.accountId);
        expect(payload.client_id).toBe(f.client.clientId);
        const actor = await f.access.authenticate(credential.bearer, {
          pool: f.database.pool,
          deadline: Date.now() + 10_000,
        });
        expect(actor.accountId).toBe(payload.sub);
        expect(actor.clientId).toBe(payload.client_id);
        expect([...actor.scopes].sort()).toEqual(String(payload.scope).split(' ').sort());
        expect(actor.requestedBy).toBeNull();
        if (credential === f.ordinary)
          for (const action of IMPORT_ACTIONS) expect(actor.scopes.includes(action)).toBe(false);
        const account = await d.account(f, credential.accountId);
        expect(account?.kind).toBe('actor');
        expect(account?.state).toBe('active');
        expect(account?.fenced).toBe(false);
        expect(BigInt(actor.authnEpoch)).toBeGreaterThanOrEqual(account!.minimumAuthnEpoch);
        const authAccount = await d.authAccount(f, credential.accountId);
        expect(authAccount?.accountId).toBe(credential.accountId);
        expect(authAccount?.state).toBe('active');
        expect(authAccount?.automated).toBe(credential === f.bulk);
        expect(account?.operatorAccountId).toBe(credential === f.bulk ? f.governance.accountId : null);
      }
      expect(f.routeKey.byteLength).toBeGreaterThanOrEqual(32);
      expect(f.tokenKeys.keys.has(f.tokenKeys.current)).toBe(true);
      expect(f.accessConfig.auth?.issuer).toBe(f.auth.verifier.issuer);
      expect(f.accessConfig.auth?.audience).toBe(f.auth.verifier.audience);
      expect(f.accessConfig.auth?.jwksUrl).toBe(f.auth.verifier.jwksUrl);
      const { capture } = await import('../services/kernel/test/support/growth.ts');
      const observed = await capture(f.database, () =>
        f.access.authenticate(f.bulk.bearer, {
          pool: f.database.pool,
          deadline: Date.now() + 10_000,
        }),
      );
      expect(observed.value.accountId).toBe(f.bulk.accountId);
      expect(observed.capture.statements.length).toBeGreaterThan(0);
      expect(observed.capture.plans.length).toBeGreaterThan(0);
    }),
  ));

test('explicit active human bootstrap persists only a data-defined governance role marker and audit on Global', () =>
  scenario((d) =>
    fixture(d, async (f) => {
      const evidence = await d.bootstrapEvidence(f);
      expect(evidence.marker.resource).toEqual(GLOBAL);
      expect(evidence.marker.partition).toBe(0);
      expect(evidence.marker.accountId).toBe(f.governance.accountId);
      expect(evidence.marker.transactionId).toBeTruthy();
      expect(evidence.roles).toHaveLength(1);
      const role = evidence.roles[0]!;
      expect(role.resource).toEqual(GLOBAL);
      expect(role.accountId).toBe(f.governance.accountId);
      expect(f.accessConfig.resourceRoles?.roles[role.role]?.length).toBeGreaterThan(0);
      expect(evidence.audit).toHaveLength(1);
      const audit = evidence.audit[0]!;
      expect(audit.envelope.partition).toBe(evidence.marker.partition);
      expect(audit.envelope.events).toHaveLength(1);
      expect(audit.envelope.events[0]!.id).toBeTruthy();
      expect(audit.accountId).toBe(f.governance.accountId);
      expect(audit.resource).toEqual(GLOBAL);
      expect(audit.transactionId).toBe(evidence.marker.transactionId);
    }),
  ));

test('bootstrap is a durable same-account no-op and refuses a different active human', () =>
  scenario((d) =>
    fixture(d, async (f) => {
      const before = await d.bootstrapEvidence(f);
      expect((await d.bootstrap(f, f.governance.accountId)).exitCode).toBe(0);
      expect(await d.bootstrapEvidence(f)).toEqual(before);
      expect((await d.bootstrap(f, f.ordinary.accountId)).exitCode).not.toBe(0);
      expect(await d.bootstrapEvidence(f)).toEqual(before);
    }),
  ));

test('both actors share subject create but only bulk has import grants on exact Global scope', () =>
  scenario((d) =>
    fixture(d, async (f) => {
      for (const [credential, bulk] of [
        [f.bulk, true],
        [f.ordinary, false],
      ] as const) {
        const rows = await d.grants(f, credential.accountId);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.resource).toEqual(GLOBAL);
        expect(rows.flatMap((row) => row.actions).sort()).toEqual(
          [...COMMON_ACTIONS, ...(bulk ? IMPORT_ACTIONS : [])].sort(),
        );
        await authority(f, credential, bulk);
        const decoys: Resource[] = [
          { route: 0, id: '00000000-0000-8000-8000-000000000001' },
          { route: 1, id: '00000000-0000-8000-8000-000100000000' },
        ];
        for (const resource of decoys)
          for (const action of [...COMMON_ACTIONS, ...IMPORT_ACTIONS])
            expect(await permits(f, credential, action, resource)).toBe(false);
      }
    }),
  ));

test('real reduced-scope Auth issuance cannot borrow a resource grant and tampered tokens fail verification', () =>
  scenario((d) =>
    fixture(d, async (f) => {
      const limited = await d.issue(f, f.bulk.accountId, [
        ...COMMON_ACTIONS,
        ...IMPORT_ACTIONS.filter((action) => action !== BULK_ACTION),
      ]);
      expect(limited.accountId).toBe(f.bulk.accountId);
      await authority(f, limited, false, true);
      const commonOnly = await d.issue(f, f.bulk.accountId, COMMON_ACTIONS);
      await authority(f, commonOnly, false);
      const parts = f.bulk.bearer.split('.');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.sub = f.governance.accountId;
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      await expect(
        f.access.authenticate(parts.join('.'), {
          pool: f.database.pool,
          deadline: Date.now() + 10_000,
        }),
      ).rejects.toThrow();
    }),
  ));

test('bulk revocation preserves the original bearer and all other authority for later receipt replay tests', () =>
  scenario((d) =>
    fixture(d, async (f) => {
      const original = { ...f.bulk };
      await authority(f, original, true);
      const ordinaryGrants = await d.grants(f, f.ordinary.accountId);
      await f.setBulkPermission(false);
      expect(f.bulk).toEqual(original);
      await authority(f, original, false, true);
      await authority(f, f.ordinary, false);
      expect(await d.grants(f, f.ordinary.accountId)).toEqual(ordinaryGrants);
      expect((await d.grants(f, original.accountId)).flatMap((row) => row.actions).sort()).toEqual(
        [...COMMON_ACTIONS, ...IMPORT_ACTIONS.filter((action) => action !== BULK_ACTION)].sort(),
      );
      await f.setBulkPermission(true);
      expect(f.bulk).toEqual(original);
      await authority(f, original, true);
    }),
  ));

test('fixtures isolate application Auth namespaces tokens and grants and close idempotently', () =>
  scenario(async (d) => {
    const baseline = await d.resources();
    await fixture(d, async (first) => {
      await fixture(d, async (second) => {
        expect(first.database.pool).not.toBe(second.database.pool);
        expect(first.database.url).not.toBe(second.database.url);
        expect(await d.account(second, first.bulk.accountId)).toBeNull();
        await expect(
          second.access.authenticate(first.bulk.bearer, {
            pool: second.database.pool,
            deadline: Date.now() + 10_000,
          }),
        ).rejects.toThrow();
        await first.setBulkPermission(false);
        await authority(second, second.bulk, true);
        await first.close();
        await first.close();
        await authority(second, second.bulk, true);
      });
    });
    expect(await d.resources()).toEqual(baseline);
  }));

test('partial opening failures clean every namespace host and pool before returning the original failure', () =>
  scenario(async (d) => {
    const baseline = await d.resources();
    for (const stage of ['auth-registration', 'bootstrap', 'grants'] satisfies Stage[]) {
      const failure = new Error(`Injected failure after ${stage}`);
      let reached = false;
      await expect(
        d.open({
          clock,
          afterStage: async (observed) => {
            if (observed === stage) {
              reached = true;
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);
      expect(reached).toBe(true);
      expect(await d.resources()).toEqual(baseline);
    }
    await fixture(d, async (f) => {
      await authority(f, f.bulk, true);
    });
    expect(await d.resources()).toEqual(baseline);
  }));
