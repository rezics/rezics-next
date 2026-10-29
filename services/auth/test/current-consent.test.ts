import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createCurrentConsentReader } from '../src/current-consent.ts';

let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let read: ReturnType<typeof createCurrentConsentReader>['readCurrentConsent'];
const selected = { actorAccountId: 'selected-person', clientId: 'selected-client' };
beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  read = createCurrentConsentReader({ database }).readCurrentConsent;
  await database.query(`INSERT INTO auth_client VALUES ('selected-client',false,ARRAY['read','write']);
    INSERT INTO auth_client_coverage (client_id,ready) VALUES ('selected-client',true);
    INSERT INTO auth_consent (account_id,client_id,scopes) VALUES
      ('selected-person','selected-client',ARRAY['write','read','old']),
      ('other-person','selected-client',ARRAY['secret']);`);
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('exact current tuple intersects the real client ceiling and re-reads deletion/reduction', async () => {
  expect(await read(selected)).toEqual({ ...selected, scopes: ['read', 'write'] });
  expect(await read({ ...selected, actorAccountId: 'missing' })).toBeNull();
  await database.query(`UPDATE auth_consent SET scopes=ARRAY['read'] WHERE account_id='selected-person'`);
  expect(await read(selected)).toEqual({ ...selected, scopes: ['read'] });
  await database.query(`UPDATE auth_client SET scopes=ARRAY['write'] WHERE client_id='selected-client'`);
  expect(await read(selected)).toEqual({ ...selected, scopes: [] });
  await database.query(
    `INSERT INTO auth_client_reduction VALUES ('selected-client','reduction',ARRAY[]::text[],false)`,
  );
  expect(await read(selected)).toBeNull();
  await database.query(`DELETE FROM auth_client_reduction; UPDATE auth_client_coverage SET ready=false`);
  expect(await read(selected)).toBeNull();
  await database.query(
    `UPDATE auth_client_coverage SET ready=true; DELETE FROM auth_consent WHERE account_id='selected-person'`,
  );
  expect(await read(selected)).toBeNull();
  await database.query(`DELETE FROM auth_client_coverage; DELETE FROM auth_client WHERE client_id='selected-client'`);
  expect(await read({ ...selected, actorAccountId: 'other-person' })).toBeNull();
});

test('first-party standing consent requires an actual materialized row; reads never materialize', async () => {
  await database.query(`INSERT INTO auth_client VALUES ('first-party',true,ARRAY['read']);
    INSERT INTO auth_client_coverage (client_id,ready) VALUES ('first-party',true)`);
  const input = { ...selected, clientId: 'first-party' };
  expect(await read(input)).toBeNull();
  expect((await database.query(`SELECT * FROM auth_consent WHERE client_id='first-party'`)).rows).toEqual([]);
  await database.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ('selected-person','first-party',ARRAY['read'])`,
  );
  expect(await read(input)).toEqual({ ...input, scopes: ['read'] });
  await database.query(`UPDATE auth_consent SET scopes=ARRAY['bad scope'] WHERE client_id='first-party'`);
  expect(await read(input)).toBeNull();
});

test('invalid IDs and extra authority/bulk fields deny before SQL', async () => {
  let queries = 0;
  const reader = createCurrentConsentReader({
    database: {
      query() {
        queries++;
        throw new Error('unexpected');
      },
    } as unknown as Pool,
  });
  for (const input of [
    { ...selected, clientId: '' },
    { ...selected, actorAccountId: 'x'.repeat(1025) },
    { ...selected, actorAccountId: 'a\u0000' },
    { ...selected, firstParty: true },
    { ...selected, scopes: ['read'] },
  ])
    expect(await reader.readCurrentConsent(input)).toBeNull();
  expect(queries).toBe(0);
});

test('pending scope validation and intersection cannot add authority or treat an empty ceiling as absent', async () => {
  for (const [pending, scopes] of [
    [null, ['read', 'write']],
    [['read', 'old', 'new'], ['read']],
    [[], []],
    [['bad scope'], null],
    ['read', null],
  ] as const) {
    const reader = createCurrentConsentReader({
      database: {
        async query() {
          return { rows: [{ consent: ['write', 'old', 'read', 'read'], ceiling: ['read', 'write', 'new'], pending }] };
        },
      } as unknown as Pool,
    });
    expect(await reader.readCurrentConsent(selected)).toEqual(scopes === null ? null : { ...selected, scopes });
  }
});

test('current consent applies the shared bound independently to consent, client ceiling and pending scopes', async () => {
  const maximum = Array.from({ length: MAX_CONSENTED_SCOPES }, (_, i) => `scope:${i}:`.padEnd(128, 'a'));
  expect(maximum.join(' ').length).toBe(MAX_CONSENTED_SCOPE_OCTETS);
  for (const field of ['consent', 'ceiling', 'pending'] as const) {
    for (const extra of [false, true]) {
      const reader = createCurrentConsentReader({
        database: {
          async query() {
            return {
              rows: [
                {
                  consent: maximum,
                  ceiling: maximum,
                  pending: maximum,
                  [field]: extra ? [...maximum, 'extra'] : maximum,
                },
              ],
            };
          },
        } as unknown as Pool,
      });
      expect(await reader.readCurrentConsent(selected)).toEqual(
        extra ? null : { ...selected, scopes: [...maximum].sort() },
      );
    }
  }
});
