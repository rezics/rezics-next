import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../src/migrate.ts';
import { SourceIntakeStore } from '../../main/src/modules/source/intake.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const root = resolve(import.meta.dir, '../../..');
const repair = '2705_source_field_slot_bounds.sql';
let cluster: PostgresCluster, fresh: Pool, established: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  fresh = new Pool({ ...cluster.connection, max: 2 });
  await fresh.query('CREATE DATABASE source_field_slot_upgrade');
  established = new Pool({ ...cluster.connection, database: 'source_field_slot_upgrade', max: 2 });
}, 120_000);
afterAll(async () => { await established?.end(); await fresh?.end(); cluster?.remove(); });

interface Custody { principal: string; record: string }
async function custody(pool: Pool): Promise<Custody> {
  const principal = randomUUID();
  const { observation } = await new SourceIntakeStore(pool).submit(principal, randomUUID(), {
    provider: 'slot-constraint-fixture', namespace: 'slot', externalId: randomUUID(),
    sourceRevision: 'captured-shape-v1', mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: Buffer.from('{}').toString('base64'),
    coverage: { scope: 'captured-shape', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: 'Constraint fixture; no publication authority.' },
  });
  return { principal, record: observation.record.slice(-36) };
}
async function insertSlot(pool: Pool, source: Custody, slot: string) {
  return (await pool.query<{ id: string; slot: string }>(`INSERT INTO source.field_support
    (id,principal_id,target,slot,context,record_id) VALUES ($1,$2,$3,$4,'global',$5) RETURNING id::text,slot`,
  [randomUUID(),source.principal,`https://rezics.com/id/${randomUUID()}`,slot,source.record])).rows[0]!;
}
async function supportCount(pool: Pool): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM source.field_support')).rows[0]!.n;
}
async function assertSlotLanguage(pool: Pool, source: Custody) {
  for (const scheme of ['http', 'https']) {
    for (const length of [1, 255, 256, 512]) {
      const slot = `component-property-v1#${scheme}://${'x'.repeat(length)}`;
      expect((await insertSlot(pool,source,slot)).slot).toBe(slot);
    }
  }
  // The old regex counts characters, not UTF-8 bytes or UTF-16 code units.
  for (const body of ['🧭'.repeat(512), 'x://y', '/']) {
    const slot = `component-property-v1#https://${body}`;
    expect((await insertSlot(pool,source,slot)).slot).toBe(slot);
  }
  for (const slot of ['work-metadata-v1#synopsis', 'work-metadata-v1#title:ja', 'statement-v2#value']) {
    expect((await insertSlot(pool,source,slot)).slot).toBe(slot);
  }
  const before = await supportCount(pool);
  const refused = [
    ...['http', 'https'].flatMap(scheme => [
      `component-property-v1#${scheme}://`, `component-property-v1#${scheme}://${'x'.repeat(513)}`,
    ]),
    `component-property-v1#https://${'🧭'.repeat(513)}`,
    ...[' ', '\t', '\n', '\r', '\f', '\v'].flatMap(space => [
      `component-property-v1#https://${space}x`, `component-property-v1#https://x${space}y`,
      `component-property-v1#https://x${space}`,
    ]),
    'component-property-v1#ftp://x', 'component-property-v1#httpx://x',
    'component-property-v1#HTTPS://x', 'component-property-v2#https://x',
    'other-property-v1#https://x', 'prefix-component-property-v1#https://x',
    'component-property-v1#', '', 'work-metadata-v0#synopsis',
    'work-metadata-v1#title:en', 'work-author-credit-v1#author', 'work-author-credit-v1#credits',
  ];
  for (const slot of refused) {
    await expect(insertSlot(pool,source,slot)).rejects.toMatchObject({
      code: '23514', constraint: 'field_support_slot_check',
    });
  }
  expect(await supportCount(pool)).toBe(before);
}

test('fresh Source schemas accept exactly the bounded slot language without a regex repetition error', async () => {
  expect(await migrateContent(fresh)).toContain(2705);
  await assertSlotLanguage(fresh,await custody(fresh));
  expect(await migrateContent(fresh)).toEqual([]);
});

test('the corrective migration repairs applied attachment schemas and preserves existing supports and heads', async () => {
  const temporary = join(root,'.temp'); mkdirSync(temporary,{ recursive: true });
  const directory = mkdtempSync(join(temporary,'source-field-slot-migrations-'));
  try {
    const migrations = join(root,'services/content/migrations');
    for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql') && file !== repair)) {
      symlinkSync(join(migrations,file),join(directory,file));
    }
    expect(await migrateContent(established,directory)).toContain(2702);
    const source = await custody(established);
    const legacy = await insertSlot(established,source,'work-metadata-v1#synopsis');
    const saved = async () => (await established.query(`SELECT to_jsonb(s) AS support,to_jsonb(h) AS head
      FROM source.field_support s JOIN source.field_support_head h ON h.support_id=s.id WHERE s.id=$1`,[legacy.id])).rows[0];
    const before = await saved();
    // Preserve the actual pre-repair failure, rather than replacing the failed
    // constraint with a permissive test prerequisite or changing native assertions.
    await expect(insertSlot(established,source,'component-property-v1#https://x'))
      .rejects.toMatchObject({ code: '2201B' });
    expect(await supportCount(established)).toBe(1);
    expect(await migrateContent(established)).toEqual([2705]);
    expect(await saved()).toEqual(before);
    expect(await supportCount(established)).toBe(1);
    await assertSlotLanguage(established,source);
    expect(await migrateContent(established)).toEqual([]);
    expect(await saved()).toEqual(before);
  } finally { rmSync(directory,{ recursive: true,force: true }); }
});
