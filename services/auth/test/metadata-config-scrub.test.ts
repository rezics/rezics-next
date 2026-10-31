import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, WEBSITE_CLIENT_ID, type AuthService, type PublicJwks } from '../src/index.ts';
import {
  METADATA_CONFIGURATION_BATCH,
  metadataConfigurationStores,
  scrubMetadataConfigurationPage,
  type MetadataConfigurationStore,
  type MetadataScrubPending,
} from '../src/metadata-scrub.ts';
import { failNativeQueries } from './support/erasure-native.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://scrub.auth.test';
const audience = 'https://scrub.api.test';
const websiteScopes = ['openid', 'offline_access', 'media:complete'];
const opaque = { foreignAccount: 'not-a-role', arbitrary: ['unknown@example.test', { nested: 'whole-field' }] };
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let service: AuthService;
let publicJwks: PublicJwks;

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.privateKey)), kid: 'scrub-signing' };
  publicJwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'website', alg: 'ES256', use: 'sig' }],
  } as PublicJwks;

  // Exercise deployment from the supported previous schema using this migration's
  // own down/up pair. No existing erasure/role/immutable guard is disabled, and
  // no fixture-created role, custody, readiness or terminal proof is installed.
  const migration = readFileSync(
    new URL('../db/migrations/20261030235646_metadata_config_scrub.sql', import.meta.url),
    'utf8',
  );
  const [up, down] = migration.split('-- migrate:down');
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(down!);
    await connection.query(
      `INSERT INTO auth_client (client_id,first_party,scopes,contacts,metadata,name,uri,icon,tos,policy,
        "softwareId","softwareVersion","softwareStatement",display_name)
       VALUES ('a-legacy',true,ARRAY['read'],$1,$2,'unproven person','https://private.test/path',
        'private-icon','private-terms','private-policy','private-software','private-version','opaque-statement','Legacy person')`,
      [JSON.stringify(['unknown@example.test']), JSON.stringify(opaque)],
    );
    await connection.query(
      `INSERT INTO auth_client (client_id,first_party,scopes,metadata,jwks,"redirectUris","tokenEndpointAuthMethod")
       VALUES ($1,true,$2,$3,$4,$5,'private_key_jwt')`,
      [
        WEBSITE_CLIENT_ID,
        websiteScopes,
        JSON.stringify(opaque),
        JSON.stringify(publicJwks),
        JSON.stringify([`${issuer}/callback`]),
      ],
    );
    await connection.query(
      `INSERT INTO auth_client (client_id,first_party,scopes,"referenceId") VALUES ('b-reference',false,ARRAY['read'],'unknown-reference')`,
    );
    await connection.query(
      `INSERT INTO "oauthResource" (id,identifier,name,metadata,"customClaims","allowedScopes","accessTokenTtl")
       VALUES ('a-resource',$1,'Unknown private resource',$2,$2,$3,300),
              ('b-shared','https://shared.api.test','Unknown shared label',$2,NULL,'["read"]',300),
              ('c-pending','https://other.api.test','Other unknown label',$2,$2,'["read"]',300)`,
      [audience, JSON.stringify(opaque), JSON.stringify(websiteScopes)],
    );
    await connection.query(
      `INSERT INTO "oauthClientResource" (id,"clientId","resourceId",metadata)
       VALUES ('a-link','a-legacy','https://shared.api.test',$1),
              ('b-link',$2,'https://shared.api.test',$1),('c-link',$2,$3,$1)`,
      [JSON.stringify(opaque), WEBSITE_CLIENT_ID, audience],
    );
    await connection.query(up!);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  service = await createAuthService({
    database,
    issuer,
    audience,
    secret: 'metadata-scrub-fixture-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      readAccount: async () => null,
      readFencedAccount: async () => null,
      authorizeProvisioning: async () => {
        throw new Error('Configuration scrub must not provision');
      },
    }),
  });
}, 120_000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

async function pass(store: MetadataConfigurationStore) {
  const pending: MetadataScrubPending[] = [];
  for (let page = 0; page < 20; page++) {
    // A new invocation resumes only from the native store's committed raw key.
    const result = await scrubMetadataConfigurationPage(database, store);
    expect(result.examined).toBeLessThanOrEqual(METADATA_CONFIGURATION_BATCH);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    for (const item of result.pending) {
      if (item.key !== null) expect(Buffer.byteLength(item.key)).toBeLessThanOrEqual(1024);
    }
    pending.push(...result.pending);
    if (!result.examined || result.pending.some((item) => item.code === 'locator-too-large')) return pending;
  }
  throw new Error('Finite configuration fixture did not finish one raw-key pass');
}

describe('Adopted whole-field historical Auth configuration scrub', () => {
  test('historical payload and checkpoint roll back together; the original key retries without a fabricated proof', async () => {
    const original = (
      await database.query('SELECT contacts,metadata,display_name FROM auth_client WHERE client_id=$1', ['a-legacy'])
    ).rows[0];
    const restore = failNativeQueries(database, (sql) => sql.startsWith('UPDATE auth_metadata_scrub'));
    try {
      await expect(scrubMetadataConfigurationPage(database, 'auth_client')).rejects.toThrow(
        'Injected native consumer interruption',
      );
    } finally {
      restore();
    }
    expect(
      (await database.query('SELECT contacts,metadata,display_name FROM auth_client WHERE client_id=$1', ['a-legacy']))
        .rows[0],
    ).toEqual(original);
    expect((await database.query('SELECT 1 FROM auth_metadata_scrub WHERE store=$1', ['auth_client'])).rowCount).toBe(
      0,
    );
    const result = await scrubMetadataConfigurationPage(database, 'auth_client');
    expect(result.changed).toBe(1);
    expect(result.examined).toBe(METADATA_CONFIGURATION_BATCH);
    expect(
      (await database.query('SELECT after_key FROM auth_metadata_scrub WHERE store=$1', ['auth_client'])).rows[0]
        .after_key,
    ).toBe('b-reference');
    expect(
      (await database.query('SELECT contacts,metadata,display_name FROM auth_client WHERE client_id=$1', ['a-legacy']))
        .rows[0],
    ).toEqual({ contacts: null, metadata: null, display_name: null });
    await pass('auth_client');
  });

  test('independent raw client/resource/link pages purge whole free fields and preserve living shared configuration', async () => {
    const pending = new Map<MetadataConfigurationStore, MetadataScrubPending[]>();
    for (const store of metadataConfigurationStores) pending.set(store, await pass(store));
    expect(pending.get('auth_client')).toEqual(
      expect.arrayContaining([
        { key: WEBSITE_CLIENT_ID, code: 'website-authorization-metadata' },
        { key: 'b-reference', code: 'provider-reference' },
      ]),
    );
    expect(pending.get('oauthResource')).toEqual(
      expect.arrayContaining([
        { key: 'a-resource', code: 'resource-claims' },
        { key: 'c-pending', code: 'resource-claims' },
      ]),
    );
    const row = (await database.query('SELECT * FROM auth_client WHERE client_id=$1', ['a-legacy'])).rows[0]!;
    for (const field of [
      'contacts',
      'metadata',
      'name',
      'uri',
      'icon',
      'tos',
      'policy',
      'softwareId',
      'softwareVersion',
      'softwareStatement',
      'display_name',
      'userId',
    ]) {
      expect(row[field]).toBeNull();
    }
    expect(row).toMatchObject({ client_id: 'a-legacy', first_party: true, scopes: ['read'] });
    const resources = (
      await database.query(
        'SELECT id,identifier,name,metadata,"customClaims","allowedScopes" FROM "oauthResource" ORDER BY id',
      )
    ).rows;
    expect(resources).toHaveLength(3);
    expect(resources.every((resource) => resource.name === '' && resource.metadata === null)).toBe(true);
    expect(resources[0]).toMatchObject({
      id: 'a-resource',
      identifier: audience,
      customClaims: opaque,
      allowedScopes: websiteScopes,
    });
    expect(
      (await database.query('SELECT metadata FROM "oauthClientResource"')).rows.every((link) => link.metadata === null),
    ).toBe(true);
    expect(
      (
        await database.query('SELECT "resourceId" FROM "oauthClientResource" WHERE "resourceId"=$1', [
          'https://shared.api.test',
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (await database.query('SELECT store,writer_version,after_key FROM auth_metadata_scrub ORDER BY store')).rows,
    ).toEqual([...metadataConfigurationStores].sort().map((store) => ({ store, writer_version: 1, after_key: null })));
  });

  test('native guards close arbitrary SQL fields and label assertions while actual configured constants survive scrub and exact replay', async () => {
    await database.query(
      `INSERT INTO auth_client (client_id,first_party,scopes,display_name,display_name_writer,contacts,metadata,"referenceId")
       VALUES ('current-untrusted',true,ARRAY['read'],'Claimed safe',1,$1,$1,'invented')`,
      [JSON.stringify(opaque)],
    );
    expect(
      (
        await database.query(
          'SELECT contacts,metadata,display_name,display_name_writer,"referenceId" FROM auth_client WHERE client_id=$1',
          ['current-untrusted'],
        )
      ).rows[0],
    ).toEqual({ contacts: null, metadata: null, display_name: null, display_name_writer: null, referenceId: null });
    await service.internal.registerClient({
      clientId: 'current-trusted',
      firstParty: true,
      scopes: ['read'],
      displayName: 'Current application',
    });
    await pass('auth_client');
    const before = (await database.query('SELECT * FROM auth_client WHERE client_id=$1', ['current-trusted'])).rows[0];
    expect(before).toMatchObject({ display_name: 'Current application', display_name_writer: 1 });
    await service.internal.registerClient({
      clientId: 'current-trusted',
      firstParty: true,
      scopes: ['read'],
      displayName: 'Ignored replacement',
      mode: 'create-or-match',
    });
    expect((await database.query('SELECT * FROM auth_client WHERE client_id=$1', ['current-trusted'])).rows[0]).toEqual(
      before,
    );
    // Copying the exact label and provenance scalar is not a trusted producer.
    await database.query('UPDATE auth_client SET display_name=$2,display_name_writer=1 WHERE client_id=$1', [
      'current-untrusted',
      'Current application',
    ]);
    expect(
      (await database.query('SELECT display_name FROM auth_client WHERE client_id=$1', ['current-untrusted'])).rows[0]
        .display_name,
    ).toBeNull();
    await database.query(
      `INSERT INTO "oauthResource" (id,identifier,name,name_writer,metadata,"customClaims") VALUES ('d-untrusted','https://untrusted.api.test','REZICS API',1,$1,$1)`,
      [JSON.stringify(opaque)],
    );
    expect(
      (
        await database.query('SELECT name,name_writer,metadata,"customClaims" FROM "oauthResource" WHERE id=$1', [
          'd-untrusted',
        ])
      ).rows[0],
    ).toEqual({ name: '', name_writer: 0, metadata: null, customClaims: null });
    const restore = failNativeQueries(database, (sql) => sql.includes('INSERT INTO auth_client_coverage'));
    try {
      await expect(
        service.internal.registerClient({
          clientId: 'rollback-config',
          firstParty: true,
          scopes: ['read'],
          displayName: 'Rolled back constant',
        }),
      ).rejects.toThrow('Injected native consumer interruption');
    } finally {
      restore();
    }
    expect((await database.query('SELECT 1 FROM auth_client WHERE client_id=$1', ['rollback-config'])).rowCount).toBe(
      0,
    );
  });

  test('consumer-used metadata and claims stay pending until actual website source replacement; unknown resource claims remain independent', async () => {
    const clientBefore = (
      await database.query('SELECT scopes,jwks,"redirectUris",metadata FROM auth_client WHERE client_id=$1', [
        WEBSITE_CLIENT_ID,
      ])
    ).rows[0]!;
    expect(clientBefore.metadata).toEqual(opaque);
    await database.query('UPDATE auth_client SET metadata=$2 WHERE client_id=$1', [
      WEBSITE_CLIENT_ID,
      JSON.stringify({ replacement: 'not a configuration command' }),
    ]);
    expect(
      (await database.query('SELECT metadata FROM auth_client WHERE client_id=$1', [WEBSITE_CLIENT_ID])).rows[0]
        .metadata,
    ).toEqual(opaque);
    await expect(
      database.query('UPDATE auth_client SET metadata=NULL WHERE client_id=$1', [WEBSITE_CLIENT_ID]),
    ).rejects.toThrow('Auth website metadata requires configuration replacement');
    await database.query('UPDATE "oauthResource" SET "customClaims"=$2 WHERE id=$1', [
      'c-pending',
      JSON.stringify({ replacement: 'not a configuration command' }),
    ]);
    await expect(
      database.query('UPDATE "oauthResource" SET "customClaims"=NULL WHERE id=$1', ['c-pending']),
    ).rejects.toThrow('Auth resource claims require configuration replacement');
    expect((await service.handler(new Request(`${issuer}/.well-known/openid-configuration`))).status).not.toBe(200);
    const registration = {
      publicJwks,
      redirectUris: [`${issuer}/callback`],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: websiteScopes,
    };
    const restore = failNativeQueries(database, (sql) => sql.includes('INSERT INTO "oauthClientResource"'));
    try {
      await expect(service.internal.registerWebsiteClient(registration)).rejects.toThrow();
    } finally {
      restore();
    }
    expect(
      (
        await database.query('SELECT scopes,jwks,"redirectUris",metadata FROM auth_client WHERE client_id=$1', [
          WEBSITE_CLIENT_ID,
        ])
      ).rows[0],
    ).toEqual(clientBefore);
    expect(
      (await database.query('SELECT "customClaims" FROM "oauthResource" WHERE id=$1', ['a-resource'])).rows[0]
        .customClaims,
    ).toEqual(opaque);
    await service.internal.registerWebsiteClient(registration);
    expect(
      (
        await database.query('SELECT scopes,jwks,"redirectUris",metadata FROM auth_client WHERE client_id=$1', [
          WEBSITE_CLIENT_ID,
        ])
      ).rows[0],
    ).toEqual({ ...clientBefore, metadata: null });
    expect(
      (
        await database.query(
          'SELECT id,name,name_writer,"customClaims",metadata FROM "oauthResource" WHERE identifier=$1',
          [audience],
        )
      ).rows[0],
    ).toEqual({ id: 'a-resource', name: 'REZICS API', name_writer: 1, customClaims: null, metadata: null });
    await pass('oauthResource');
    expect((await database.query('SELECT name FROM "oauthResource" WHERE id=$1', ['a-resource'])).rows[0].name).toBe(
      'REZICS API',
    );
    expect(
      (await database.query('SELECT "customClaims" FROM "oauthResource" WHERE id=$1', ['c-pending'])).rows[0]
        .customClaims,
    ).toEqual(opaque);
    expect((await service.handler(new Request(`${issuer}/.well-known/openid-configuration`))).status).toBe(200);
  });

  test('an oversize raw locator stays precisely pending without returning its bytes or blocking other stores', async () => {
    const oversized = '\uffff'.repeat(400);
    await database.query("INSERT INTO auth_client (client_id,first_party,scopes) VALUES ($1,true,ARRAY['read'])", [
      oversized,
    ]);
    const pending = await pass('auth_client');
    expect(pending).toContainEqual({ key: null, code: 'locator-too-large' });
    expect(JSON.stringify(pending)).not.toContain(oversized);
    const cursor = (await database.query('SELECT after_key FROM auth_metadata_scrub WHERE store=$1', ['auth_client']))
      .rows[0].after_key;
    expect(cursor).not.toBe(oversized);
    expect((await scrubMetadataConfigurationPage(database, 'oauthResource')).store).toBe('oauthResource');
  });
});
