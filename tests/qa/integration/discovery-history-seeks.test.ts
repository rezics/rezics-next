import { expect, test } from 'bun:test';
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  DiscoveryProjection,
  DISCOVERY_CONDITION_COST,
  discoveryStorage,
} from '../../../services/main/src/modules/discovery/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { replaceDiscoveryWorks } from '../../../services/main/src/modules/discovery/versions.ts';
import { startMediaStack } from './media-support.ts';

const native = (n: number) =>
  `https://rezics.com/id/00001064-0000-4000-8000-${String(n).padStart(12, '0')}`;
interface Plan {
  'Node Type': string;
  Alias?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
}
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const visits = (plan: Plan) =>
  (plan['Actual Rows'] +
    (plan['Rows Removed by Filter'] ?? 0) +
    (plan['Rows Removed by Index Recheck'] ?? 0)) *
  plan['Actual Loops'];

/** Capture the actual owner statements, so a new adapter cannot leave these
 * guards explaining a hand-written approximation of the production read. */
async function capture<T>(read: () => Promise<T>) {
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  const statements: { text: string; values: unknown[] }[] = [];
  prototype.query = function (this: object, ...args: unknown[]) {
    if (
      typeof args[0] === 'string' &&
      /access\.discovery_(?:entries|terms|concepts|entry|term_count|concept_count)\b/.test(
        args[0],
      ) &&
      args[0].trim().startsWith('SELECT')
    ) {
      statements.push({ text: args[0], values: (args[1] as unknown[]) ?? [] });
    }
    return original.apply(this, args);
  };
  try {
    return { result: await read(), statements };
  } finally {
    prototype.query = original;
  }
}

test('G1064: all Discover reads and delta probes seek 20,000 Works with live, retired and future versions', async () => {
  const f = await startMediaStack('g-1064-history');
  const evidence: { name: string; version: string; plan: Plan }[] = [];
  try {
    const projection = new DiscoveryProjection(f.accessPool),
      operator = automaticDiscovery(null);
    const position = { dataEpoch: f.env.lineage.dataEpoch, sequence: '0' };
    const context = native(90001),
      basis = { scope: 'global' as const, realm: null, context, owner: null };
    const often = native(80001),
      rare = native(80002),
      excluded = native(80003);
    const key = () => ({ idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const root = await projection.register(operator, basis, position, key());
    await f.accessPool.query(
      `INSERT INTO access.discovery_entry
      (generation_id,work,work_type,term,recent_order,rating_count,rating_sum,payload,retired_version)
      SELECT $1,'https://rezics.com/id/00001064-0000-4000-8000-'||lpad(i::text,12,'0'),kind,term,i,1,3,
        jsonb_build_object('revision',$5::text,'primaryCredits','[]'::jsonb,
          'rating',jsonb_build_object('context',$6::text,'mean',3,'count',1,'sum',3,'scale',jsonb_build_object('max',5)),
          'classification',jsonb_build_object('concept',term)),1
      FROM generate_series(1,20000) i CROSS JOIN unnest(ARRAY['','https://schema.org/Book']) kind
      CROSS JOIN LATERAL unnest(ARRAY['',CASE WHEN i%2=0 THEN $2 END,CASE WHEN i%50=0 THEN $3 END,
        CASE WHEN i%3=0 THEN $4 END]) term WHERE term IS NOT NULL`,
      [root.generation_id, often, rare, excluded, native(90000), context],
    );
    await f.accessPool.query(
      `INSERT INTO access.discovery_term_count(generation_id,term,concept,work_count,retired_version)
      SELECT $1,'https://rezics.com/id/00001064-0000-4000-8000-'||lpad((i+100000)::text,12,'0'),
        'https://rezics.com/id/00001064-0000-4000-8000-'||lpad((i+200000)::text,12,'0'),20001-i,1
      FROM generate_series(1,20000) i`,
      [root.generation_id],
    );
    await f.accessPool.query(
      `INSERT INTO access.discovery_term_count(generation_id,term,concept,work_count,retired_version)
      VALUES($1,$2,$2,10000,1),($1,$3,$3,400,1),($1,$4,$4,6666,1)`,
      [root.generation_id, often, rare, excluded],
    );
    await f.accessPool.query(
      `INSERT INTO access.discovery_concept_count(generation_id,concept,work_count,retired_version)
      SELECT generation_id,concept,work_count,retired_version FROM access.discovery_term_count WHERE generation_id=$1`,
      [root.generation_id],
    );
    await f.accessPool.query(
      'UPDATE access.discovery_generation SET work_count=20000 WHERE generation_id=$1',
      [root.generation_id],
    );
    const finish = async (id: string) => {
      const step = await projection.beginStep(operator, id, '');
      return projection.commitBatch(
        operator,
        id,
        step.lease,
        '',
        { after: '', complete: true, items: [] },
        position,
      );
    };
    const cuts = [await finish(root.generation_id)];
    // Three full physical snapshots are a storage-complexity fixture only.
    // Production deltas replace bounded explicit Works, exercised below and by G1063.
    for (let version = 1; version <= 3; version++) {
      // Install interval history directly. Closing an entire population in one
      // UPDATE would benchmark the writer guard's transition-table join, not a
      // bounded production delta, and violate routine fixture preparation.
      const id = randomUUID();
      await f.accessPool.query(
        `INSERT INTO access.derived_generation
        (id,family,scope_key,input_digest,input_manifest,lease_expires_at)
        SELECT $2,family,scope_key,input_digest,input_manifest,clock_timestamp()
        FROM access.derived_generation WHERE id=$1`,
        [root.generation_id, id],
      );
      await f.accessPool.query(
        `INSERT INTO access.discovery_generation
        (generation_id,scope,realm,context,principal_id,source_epoch,source_sequence,access_revision,
          recovery_generation,storage_generation,storage_version,work_count,changed_works)
        SELECT $2,scope,realm,context,principal_id,source_epoch,source_sequence,access_revision,
          recovery_generation,generation_id,$3,work_count,'[]'::jsonb
        FROM access.discovery_generation WHERE generation_id=$1`,
        [root.generation_id, id, version],
      );
      await f.accessPool.query(
        `INSERT INTO access.derived_generation_input
        (generation_id,source,data_epoch,pinned_sequence,checkpoint_sequence)
        VALUES($1,'main-graph',$2,0,0)`,
        [id, position.dataEpoch],
      );
      const client = await f.accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('rezics.discovery_writer',$1,true)", [id]);
        await client.query(
          `INSERT INTO access.discovery_entry
          (generation_id,work,work_type,term,recent_order,rating_count,rating_sum,payload,entry_version,retired_version)
          SELECT generation_id,work,work_type,term,recent_order,rating_count,rating_sum,
            jsonb_set(payload,'{revision}',to_jsonb($3::text)),$2,CASE WHEN $2::bigint<3 THEN $2::bigint+1 END
          FROM access.discovery_entry WHERE generation_id=$1 AND entry_version=0`,
          [root.generation_id, version, native(90000 + version)],
        );
        await client.query(
          `INSERT INTO access.discovery_term_count
          (generation_id,term,concept,work_count,entry_version,retired_version)
          SELECT generation_id,term,concept,work_count,$2,CASE WHEN $2::bigint<3 THEN $2::bigint+1 END FROM access.discovery_term_count
          WHERE generation_id=$1 AND entry_version=0`,
          [root.generation_id, version],
        );
        await client.query(
          `INSERT INTO access.discovery_concept_count(generation_id,concept,work_count,entry_version,retired_version)
          SELECT generation_id,concept,work_count,$2,CASE WHEN $2::bigint<3 THEN $2::bigint+1 END FROM access.discovery_concept_count
          WHERE generation_id=$1 AND entry_version=0`,
          [root.generation_id, version],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      cuts.push(await finish(id));
    }
    for (const table of ['discovery_entry', 'discovery_term_count', 'discovery_concept_count'])
      await f.accessPool.query(`ANALYZE access.${table}`);
    const works = Array.from({ length: 20 }, (_, i) => native((i + 1) * 50));
    const terms = Array.from({ length: 20 }, (_, i) => native(100001 + i));
    const concepts = Array.from({ length: 20 }, (_, i) => native(200001 + i));
    const check = async <T>(
      name: string,
      version: string,
      read: () => Promise<T>,
      bound: number,
      sorted = false,
    ) => {
      const { result, statements } = await capture(read);
      expect(statements.length, name).toBeGreaterThan(0);
      for (const statement of statements) {
        const plan = (
          await f.accessPool.query(
            `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${statement.text}`,
            statement.values,
          )
        ).rows[0]['QUERY PLAN'][0].Plan as Plan;
        evidence.push({ name, version, plan });
        const all = nodes(plan),
          storage = all.filter((node) =>
            ['discovery_entry', 'discovery_term_count', 'discovery_concept_count'].includes(
              node['Relation Name'] ?? '',
            ),
          );
        expect(
          all.some(
            (node) =>
              ['Seq Scan', 'Hash', 'Hash Join'].includes(node['Node Type']) ||
              (node['Node Type'] === 'Function Scan' &&
                !['drive', 'k', 'cuts'].includes(node.Alias ?? '')),
          ),
          name,
        ).toBe(false);
        if (!sorted)
          expect(
            all.some((node) => node['Node Type'] === 'Sort'),
            name,
          ).toBe(false);
        // Resource union dedup/order sorts only already limited drive windows.
        for (const node of all.filter((node) => node['Node Type'] === 'Sort'))
          expect(node.Plans?.[0]?.['Actual Rows'] ?? 0, name).toBeLessThanOrEqual(2 * 65);
        expect(
          storage.length > 0 &&
            storage.every((node) =>
              nodes(node).some(
                (index) => index['Index Name'] && index['Index Cond']?.includes('generation_id'),
              ),
            ),
          name,
        ).toBe(true);
        expect(
          storage.reduce((sum, node) => sum + visits(node), 0),
          name,
        ).toBeLessThanOrEqual(bound);
        expect(
          all
            .filter((node) => node['Relation Name'] === 'discovery_generation')
            .reduce((sum, node) => sum + visits(node), 0),
          name,
        ).toBeLessThanOrEqual(0);
        if (name.startsWith('condition-') && statement.text.includes('AS matched')) {
          const probes = storage.filter((node) =>
            /work = \w+\.work/.test(node['Index Cond'] ?? ''),
          );
          expect(probes).toHaveLength(2);
          expect(probes.reduce((sum, node) => sum + node['Actual Loops'], 0)).toBeLessThanOrEqual(
            2 * DISCOVERY_CONDITION_COST.window,
          );
          expect(plan['Actual Rows']).toBeLessThanOrEqual(DISCOVERY_CONDITION_COST.window);
        }
      }
      return result;
    };
    for (const row of [cuts[0]!, cuts[1]!, cuts[3]!]) {
      const version = row.storage_version ?? '0';
      for (const sort of ['recent', 'top-rated'] as const)
        for (const after of [
          undefined,
          { key: sort === 'recent' ? '10000' : '-3', work: native(10000) },
        ]) {
          const page = await check(
            `page-${sort}-${!!after}`,
            version,
            () => projection.page(row, sort, '', often, 20, after),
            4 * 21,
          );
          expect(
            page.every((item) => item.payload.revision === native(90000 + Number(version))),
          ).toBe(true);
          const condition = await check(
            `condition-${sort}-${!!after}`,
            version,
            () =>
              projection.conditionPage(
                row,
                '',
                { drive: [often], groups: [[rare]], excluded: [excluded] },
                20,
                after,
                sort,
              ),
            4 * 60 + 2 * 60 * 4 + 4 * 20,
          );
          expect(
            condition.rows.every(
              (item) =>
                Number(item.work.slice(-12)) % 50 === 0 && Number(item.work.slice(-12)) % 3 !== 0,
            ),
          ).toBe(true);
        }
      expect(
        await check('selected-terms', version, () => projection.selectedTerms(row, terms), 4 * 20),
      ).toHaveLength(20);
      expect(
        await check('work-terms', version, () => projection.workTerms(row, works), 4 * 20 * 4),
      ).toHaveLength(46);
      expect(
        await check(
          'term-membership',
          version,
          () => projection.termMembership(row, works, [often, rare, excluded]),
          4 * 20 * 3,
        ),
      ).toHaveLength(46);
      expect(
        (
          await check(
            'resource-membership',
            version,
            () => projection.resourceMembership(row, works),
            4 * 20,
          )
        ).size,
      ).toBe(20);
      for (const after of [undefined, { key: '10000', work: native(10000) }]) {
        expect(
          await check(
            `resource-${!!after}`,
            version,
            () => projection.resourcePage(row, 20, after),
            4 * 21,
          ),
        ).toHaveLength(21);
        expect(
          await check(
            `resource-union-${!!after}`,
            version,
            () => projection.resourcePage(row, 20, after, [often, rare]),
            4 * 2 * 21,
            true,
          ),
        ).toHaveLength(21);
      }
      expect(
        await check(
          'concept-counts',
          version,
          () => projection.conceptCounts(row, concepts),
          4 * 20,
        ),
      ).toHaveLength(20);
      expect(
        await check('popular', version, () => projection.popular(row, 20), 4 * 20),
      ).toHaveLength(20);
      for (const after of [undefined, { count: '10000', concept: native(210001) }])
        expect(
          await check(
            `concept-page-${!!after}`,
            version,
            () => projection.conceptPage(row, 20, after),
            4 * 21,
          ),
        ).toHaveLength(21);
      const cards = await check(
        'cards',
        version,
        () => projection.resourceCardPayloads([row, cuts[2]!], works),
        4 * 2 * 20,
      );
      expect(cards.get(row.generation_id)?.size).toBe(20);
      expect(discoveryStorage(row)).toEqual([root.generation_id, version]);
    }
    // Explain actual live delta source/counter queries, then roll back the write:
    // old retained rows must not turn these Work/key probes into history scans.
    const delta = await projection.register(operator, basis, position, key(), {
      generation: cuts[3]!.generation_id,
      works: [native(50)],
    });
    const client = await f.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('rezics.discovery_writer',$1,true)", [
        delta.generation_id,
      ]);
      await check(
        'delta-live-probes',
        delta.storage_version!,
        () => replaceDiscoveryWorks(client, delta, [native(50)], []),
        8,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    mkdirSync('.temp/g-1064', { recursive: true });
    writeFileSync(
      `.temp/g-1064/plans-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(evidence, null, 2),
    );
    await f.stop();
  }
}, 180_000);
