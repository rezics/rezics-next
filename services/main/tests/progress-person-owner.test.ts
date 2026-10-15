import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { migrateTracked } from '../../../scripts/ops/migrate.ts';
import { grantFixtureAuthority, provisionFixturePerson, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { prepareProgressPeople } from '../../content/src/progress-people.ts';
import { ReaderLibraryStatusStore } from '../src/modules/library/status.ts';
import { StaleStructureProgress, StructureProgressStore } from '../src/modules/progress/store.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster;
let pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 8 });
  await migrateContent(pool);
}, 120_000);
afterAll(async () => { await pool?.end(); cluster?.remove(); });

test('two principals share a Person’s occurrence state, versions, shelves and yearly totals; Persons keep separate states', async () => {
  const progress = new StructureProgressStore(pool), library = new ReaderLibraryStatusStore(pool);
  const agent = id(), other = id(), structure = id(), occurrence = id(), revision = id();
  const first = { issuer: 'https://first.example', subject: 'reader' };
  const second = { issuer: 'https://second.example', subject: 'reader' };
  const command = { agent, principal: first, structure, occurrence, completed: true, position: 'paragraph:4',
    order: { revision, key: 'a\u0002a' }, expectedVersion: 0, idempotencyKey: randomUUID() };
  expect(await progress.write(command)).toMatchObject({ version: 1, completed: true });
  expect(await progress.read(agent, structure, occurrence)).toMatchObject({ version: 1, position: 'paragraph:4' });
  await expect(progress.write({ ...command, principal: second, idempotencyKey: randomUUID() }))
    .rejects.toBeInstanceOf(StaleStructureProgress);
  await progress.write({ ...command, principal: second, expectedVersion: 1, completed: false,
    position: 'paragraph:8', idempotencyKey: randomUUID() });
  expect(await progress.read(agent, structure, occurrence)).toMatchObject({ version: 2, position: 'paragraph:8' });
  expect((await library.progress(agent, [structure])).get(structure)).toMatchObject({ version: 2, position: 'paragraph:8' });
  expect(await progress.read(other, structure, occurrence)).toMatchObject({ version: 0, position: null });
  expect((await library.progress(other, [structure])).size).toBe(0);
  expect((await progress.completedPage(other, structure)).items).toEqual([]);
  expect((await progress.resumeCandidates(other, structure, revision)).items).toEqual([]);
  expect(await progress.readerVersion(other)).toBe('0');
  expect(await library.readingYear(agent, second, new Date().getUTCFullYear())).toMatchObject({ chapters: 1 });
  expect(await library.readingYear(other, first, new Date().getUTCFullYear())).toMatchObject({ chapters: 0 });
  // One controller may act as several Persons: even a reused receipt key stays private.
  expect(await progress.write({ ...command, agent: other })).toMatchObject({ version: 1, replayed: false });
  expect(await progress.write(command)).toMatchObject({ version: 1, replayed: true });
  expect(await progress.read(agent, structure, occurrence)).toMatchObject({ version: 2, position: 'paragraph:8' });
});

test('migration merges old principals into their Person, retains immutable receipts and aborts ambiguous bindings', async () => {
  const content = new Pool({ ...cluster.connection, max: 2 });
  const access = new Pool({ ...cluster.connection, max: 2 });
  const client = await content.connect();
  try {
    // A transaction-local legacy owner, independent of the already-migrated owner above.
    await client.query('BEGIN; DROP SCHEMA structure CASCADE; CREATE SCHEMA structure');
    const migrations = join(import.meta.dir, '../../content/migrations');
    for (const name of ['031_structure_progress.sql', '1490_progress_order_state.sql', '1493_progress_member_anchors.sql']) {
      await client.query(readFileSync(join(migrations, name), 'utf8'));
    }
    await client.query(`ALTER TABLE structure.progress_command ADD COLUMN content_operation text,
      ADD COLUMN first_read boolean NOT NULL DEFAULT false, ADD COLUMN first_finish boolean NOT NULL DEFAULT false;
      CREATE INDEX progress_command_first_finish_idx ON structure.progress_command
        (principal_issuer,principal_subject,structure,occurrence,result_completed)`);
    const accessUrl = `postgresql://${encodeURIComponent(cluster.user)}@127.0.0.1:${cluster.port}/${cluster.database}`;
    await migrateTracked(accessUrl, join(import.meta.dir, '../../..'), 'services/main/migrations/access');
    const agent = id(), other = id(), structure = id(), occurrence = id();
    const firstPrincipal = randomUUID(), secondPrincipal = randomUUID(), otherPrincipal = randomUUID();
    const fixture = await access.connect();
    const grantControl = (principalId: string, actor: string) => grantFixtureAuthority(fixture, {
      scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId, actor, action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor, action: 'agent.control', lifetime: 'infinity' },
    });
    try {
      await fixture.query('BEGIN');
      for (const [principalId, subject, actor] of [[firstPrincipal, 'one', agent],
        [secondPrincipal, 'two', id()], [otherPrincipal, 'other', other]] as const) {
        await registerFixtureIdentity(fixture, { principalId, issuer: 'issuer', subject, actor });
      }
      await provisionFixturePerson(fixture, { principalId: firstPrincipal, actor: agent, dataEpoch: randomUUID() });
      await provisionFixturePerson(fixture, { principalId: otherPrincipal, actor: other, dataEpoch: randomUUID() });
      await grantControl(secondPrincipal, agent);
      await fixture.query('COMMIT');
    } catch (error) { await fixture.query('ROLLBACK'); throw error; }
    finally { fixture.release(); }
    await client.query(`INSERT INTO structure.progress
      (principal_issuer,principal_subject,structure,occurrence,completed,position,version,updated_at)
      VALUES ('issuer','one',$1,$2,true,'old',9,'2026-01-01'),
        ('issuer','two',$1,$2,false,'new',2,'2026-02-01'),
        ('issuer','other',$1,$2,true,'private',3,'2026-01-01')`, [structure, occurrence]);
    await client.query(`INSERT INTO structure.progress_command
      (principal_issuer,principal_subject,idempotency_key,request_digest,structure,occurrence,selection_key,result_version,result_completed)
      VALUES ('issuer','one','same',$1,$2,$3,'',9,true),('issuer','two','same',$1,$2,$3,'',2,false)`,
    ['a'.repeat(64), structure, occurrence]);
    await prepareProgressPeople(client, accessUrl);
    await client.query(readFileSync(join(migrations, '2163_progress_person.sql'), 'utf8'));
    expect((await client.query('SELECT agent,completed,position,version::int FROM structure.progress ORDER BY position')).rows)
      .toEqual([{ agent, completed: false, position: 'new', version: 10 },
        { agent: other, completed: true, position: 'private', version: 3 }]);
    expect((await client.query('SELECT agent,principal_subject,idempotency_key FROM structure.progress_command ORDER BY principal_subject')).rows)
      .toEqual([{ agent, principal_subject: 'one', idempotency_key: 'same' },
        { agent, principal_subject: 'two', idempotency_key: 'same' }]);
    expect((await client.query('SELECT ready FROM structure.progress_scope')).rows.every(row => row.ready === false)).toBe(true);
    await client.query('SAVEPOINT immutable');
    await expect(client.query('DELETE FROM structure.progress_command')).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT immutable');
    await client.query('ROLLBACK');
    // An ambiguous mapping fails before touching any row. This is also the restore behavior.
    await client.query('BEGIN; DROP SCHEMA structure CASCADE; CREATE SCHEMA structure');
    await client.query(readFileSync(join(migrations, '031_structure_progress.sql'), 'utf8'));
    await client.query(`INSERT INTO structure.progress
      (principal_issuer,principal_subject,structure,occurrence,completed,version) VALUES ('issuer','one',$1,$2,true,1)`, [structure, occurrence]);
    const ambiguous = await access.connect();
    try {
      await ambiguous.query('BEGIN');
      await grantFixtureAuthority(ambiguous, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: firstPrincipal, actor: other, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: other, action: 'agent.control', lifetime: 'infinity' } });
      await ambiguous.query('COMMIT');
    } catch (error) { await ambiguous.query('ROLLBACK'); throw error; }
    finally { ambiguous.release(); }
    await expect(prepareProgressPeople(client, accessUrl)).rejects.toThrow('missing or ambiguous Person');
    expect((await client.query('SELECT principal_subject FROM structure.progress')).rows).toEqual([{ principal_subject: 'one' }]);
  } finally {
    await client.query('ROLLBACK'); client.release();
    await access.query('DROP SCHEMA IF EXISTS access CASCADE');
    await content.end(); await access.end();
  }
}, 30_000);
