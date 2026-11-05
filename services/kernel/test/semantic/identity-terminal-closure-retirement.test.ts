import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import { historicalEdge } from './support/identity-terminal-closure.ts';
import { runCommand } from '../../src/command/command.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../../src/semantic/events.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { reserveIdentityTerminalClosure } from '../../src/semantic/identity-epoch-mapping.ts';
import { bindSemanticProducerRoles } from '../../src/semantic/erasure-producer.ts';
import { home, identityEpochDatabase, seedLegacyRoot } from './support/identity-epoch.ts';

const migration = async (version: string) =>
  (
    await Bun.file(
      new URL(`../../db/semantic/migrations/${version}_identity_terminal_closure_fresh.sql`, import.meta.url),
    ).text()
  ).split('-- migrate:down')[0]!;

test('pricing retirement preserves native reservations and unmatched provisional copies', async () => {
  const db = await identityEpochDatabase();
  try {
    const original = await seedLegacyRoot(db, 0x7610);
    await historicalEdge(db, original, newId(0x7610));
    await installIdentityEpochBootstrap(db.pool);
    await stepIdentityEpochBootstrap(db.pool, home(original));
    const inventory = async () =>
      (
        await db.admin.query(
          `SELECT slot,generation,closure_copies
      FROM semantic.identity_epoch_mapping_generation WHERE partition_no=$1 ORDER BY slot`,
          [home(original)],
        )
      ).rows;
    // Recreate the preceding pricing schema in this private database to exercise an upgrade.
    await db.admin.query((await migration('20261102000300')).split('-- Point proofs')[0]!);
    await db.admin.query(await migration('20261102000400'));
    expect((await inventory()).length).toBeGreaterThan(0);
    await runCommand(db.pool, { partition: home(original) }, async (tx) => {
      bindSemanticProducerRoles(tx, []);
      // Two actual pricing rows and one still-provisional copy share native inventory.
      const reservation = await reserveIdentityTerminalClosure(tx, randomUUID(), original, 3);
      const id = randomUUID();
      await tx.query(
        `INSERT INTO semantic.identity_terminal_closure_original
        (partition_no,original_id,source_transaction,source_epoch,source_position,source_generation,
         source_phase,operation,deadline,plan_digest,price,spent,reservation)
        SELECT $1,$2,$2,epoch,position+1,1,'subjects','bootstrap-owner-read',1,
          decode(repeat('00',32),'hex'),array_fill(0::bigint,ARRAY[8]),array_fill(0::bigint,ARRAY[8]),$3
        FROM core.partition WHERE partition_no=$1`,
        [home(original), id, reservation],
      );
      await tx.query(
        `INSERT INTO semantic.identity_terminal_closure_ticket
        (partition_no,original_id,ordinal,operation,effect_partition,phase,cursor_transaction,price,reservation)
        VALUES($1,$2,1,'owner-read',$1,'observe-owner',$2,array_fill(0::bigint,ARRAY[8]),$3)`,
        [home(original), id, reservation],
      );
      return {
        value: reservation,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: home(original), generation: '1' } }],
      };
    });
    const retained = await inventory();
    await db.admin.query(`BEGIN;${await migration('20261102163919')}COMMIT;`);
    expect(await inventory()).toEqual(retained);
    expect(
      (
        await db.admin.query(`SELECT to_regclass('semantic.identity_terminal_closure_original') AS original,
      to_regclass('semantic.identity_terminal_closure_ticket') AS ticket`)
      ).rows[0],
    ).toEqual({ original: null, ticket: null });
    expect(
      (
        await db.admin.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='semantic.identity_epoch_bootstrap_page'::regclass AND NOT attisdropped
      AND attname LIKE 'closure_cleanup_%'`)
      ).rows,
    ).toEqual([]);
    await expect(
      db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [home(original)]),
    ).rejects.toThrow('identity_epoch_unavailable');
    await stepIdentityEpochBootstrap(db.pool, home(original));
  } finally {
    await db.close();
  }
});
