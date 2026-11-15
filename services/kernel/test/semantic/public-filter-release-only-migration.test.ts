import { expect, test } from 'bun:test';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { fixture, nativeProducer, readContext } from './support/public-filter-source.ts';

const relations = [
  'public_filter_read_definition',
  'public_filter_projection_build',
  'public_filter_projection_replay',
  'public_filter_bootstrap',
  'public_filter_bootstrap_account',
  'public_filter_repair_step',
  'public_filter_repair_advance',
  'public_filter_population_start',
];

test('release-only migration refuses an actual retained definition before changing data or schema', async () => {
  const f = await fixture();
  try {
    const { publicFilterSource } = await nativeProducer();
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const resolved = await binding.resolve({
      source: publicFilterSource(f.config),
      meaning: f.meaning,
      capture: { sort: 'id', size: 10, filterDocument: undefined, text: undefined },
    }, readContext());
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error(`Native retained definition: ${resolved.reason}`);
    const snapshot = async () => {
      const definition = await f.db.admin.query(
        `SELECT to_jsonb(d) AS definition FROM semantic.public_filter_read_definition d
         WHERE partition_no=0 AND read_definition=$1`,
        [resolved.definition.readDefinition],
      );
      const rows = [];
      for (const relation of relations) {
        const counted = await f.db.admin.query(`SELECT count(*)::text AS count FROM semantic.${relation}`);
        rows.push({ relation, count: counted.rows[0]?.count });
      }
      const schema = await f.db.admin.query(
        `SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
                a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expression
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
         WHERE n.nspname='semantic' AND c.relname=ANY($1::text[])
         ORDER BY c.relname,a.attnum`,
        [relations],
      );
      const constraints = await f.db.admin.query(
        `SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_constraint k ON k.conrelid=c.oid
         WHERE n.nspname='semantic' AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname`,
        [relations],
      );
      const guard = await f.db.admin.query(
        "SELECT pg_get_functiondef('semantic.retain_public_filter_definition()'::regprocedure) AS definition",
      );
      return { definition: definition.rows, rows, schema: schema.rows, constraints: constraints.rows, guard: guard.rows };
    };
    const before = await snapshot();
    expect(before.definition).toHaveLength(1);
    const migration = (await Bun.file(new URL(
      '../../db/semantic/migrations/20261115000200_public_filter_release_only_meaning.sql',
      import.meta.url,
    )).text()).split('-- migrate:down')[0]!;
    const client = await f.db.admin.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(migration)).rejects.toMatchObject({
        code: '23514',
        message: 'Release-only public-filter meaning requires an operator-verified derivative drain',
      });
    } finally {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
    expect(await snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});
