import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readConsentTarget } from '../../src/semantic/candidate-consent-identity.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { deadline, identityFixture, resource } from './identity-fixture.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(process.env.DATABASE_URL);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});

test('Private consent identity independently requires current target subject-read permission', async () => {
  const f = await identityFixture(db.pool, db.admin);
  const source = await f.create(0x6e10, 'Private assertion subject');
  const target = await f.create(0x6e20, 'Independently protected target');
  const access = f.real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  const read = async (id: string) =>
    readConsentTarget(
      db.pool,
      {
        access,
        actor: await access.authenticate(f.real.bearer('reader'), { pool: db.pool, deadline: deadline() }),
        deadline: deadline(),
      },
      id,
    );
  await f.real.grant(resource(source), 'reader', 'subject:read');
  expect(await read(source)).toEqual({ id: source, labels: { en: 'Private assertion subject' } });
  expect(await read(target)).toBeNull();
  await f.real.grant(resource(target), 'reader', 'subject:read');
  expect(await read(target)).toEqual({ id: target, labels: { en: 'Independently protected target' } });
  await f.real.revoke(resource(target), 'reader', 'subject:read');
  expect(await read(target)).toBeNull();
  expect(await read(source)).not.toBeNull();
});

test('A consent target redirect exposes the survivor name only when both addressed subjects admit the reader', async () => {
  const f = await identityFixture(db.pool, db.admin);
  const original = await f.create(0x6e10, 'Original identity');
  const survivor = await f.create(0x6e20, 'Recognizable survivor');
  await f.merge(original, survivor);
  await f.finishMove(original, survivor);
  const access = f.real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  const read = async () =>
    readConsentTarget(
      db.pool,
      {
        access,
        actor: await access.authenticate(f.real.bearer('reader'), { pool: db.pool, deadline: deadline() }),
        deadline: deadline(),
      },
      original,
    );
  await f.real.grant(resource(original), 'reader', 'subject:read');
  expect(await read()).toBeNull();
  await f.real.grant(resource(survivor), 'reader', 'subject:read');
  expect(await read()).toEqual({ id: original, labels: { en: 'Recognizable survivor' }, redirect: survivor });
  await f.real.revoke(resource(original), 'reader', 'subject:read');
  expect(await read()).toBeNull();
});
