import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId, partitionOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SubjectRedirectError } from '../../src/semantic/merges.ts';
import { readSubjectReference } from '../../src/semantic/references.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const route = 24320;
const actor = { kind: 'account' as const, accountId: newId(route), clientId: 'reference-growth',
  scopes: ['subject:create'], requestedBy: null, authnEpoch: 1 };
const target = newId(route);
const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;
const encode = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

beforeAll(async () => {
  db = await openGrowthDatabase(process.env.DATABASE_URL!);
  await bootstrapRelease(db.pool, bundledRelease);
  // Stable production-shaped background for the normal planner, shared by all axes.
  await seed(db, {
    name: 'reference-background', hotPartition: partitionOf(route), hotShare: 1,
    rows: () => {
      const id = newId(route);
      const transaction = randomUUID();
      return {
        'semantic.subject': [{ route, subject_id: id, type: 'schema:Book', recorded_transaction_id: transaction }],
        'semantic.redirect': [{ route, subject_id: id, sequence: 1, target: '00000000-0000-0000-0000-000000000000', recorded_transaction_id: transaction }],
      };
    },
  }, { from: 0, to: 2048 });
});
afterAll(async () => { if (db) await db.close(); });

test('reference resolution stays bounded as unrelated history and relation degree grow', async () => {
  for (const axis of ['subjects', 'redirects', 'editorial', 'relations'] as const) {
    const id = newId(route);
    await createSubject(db.pool, {
      actor, target: { route, id }, idempotencyKey: randomUUID(), digest: new Uint8Array(32),
      item: { type: 'schema:Book', labels: { en: 'Fixed reference' } },
      release: { digest: bundledDigest, release: bundledRelease }, authorize: async () => true,
    });
    let expected: string | undefined;
    const read = () => readSubjectReference(db.pool, id, async () => true).catch((error: unknown) => {
      if (error instanceof SubjectRedirectError) return { from: error.from, to: error.to };
      throw error;
    });
    const report = await checkGrowth(db, {
      name: `Subject reference ${axis}`, scales: [64, 512, 4096], bounds,
      grow: async (database, scale, previous) => {
        await seed(database, {
          name: `reference-${axis}`, hotPartition: partitionOf(route), hotShare: 1,
          rows: ({ ordinal }) => {
            const transaction = randomUUID();
            if (axis === 'subjects') return {
              'semantic.subject': [{ route, subject_id: newId(route), type: 'schema:Book', recorded_transaction_id: transaction }],
            };
            if (axis === 'redirects') return {
              'semantic.redirect': [{ route, subject_id: id, sequence: ordinal + 1, target, recorded_transaction_id: transaction }],
            };
            if (axis === 'editorial') {
              const candidate = newId(route);
              const slot = newId(route);
              return {
                'semantic.revision': [{ route, subject_id: id, revision: ordinal + 2, kind: 'adopt',
                  release: bundledDigest, recorded_transaction_id: transaction }],
                'semantic.candidate': [{ route, subject_id: id, candidate_id: candidate, slot_id: slot,
                  property: 'schema:inLanguage', rank: 'normal', statement: { value: { type: 'value', content: 'en' } },
                  release: bundledDigest, revision: ordinal + 2, origin: 'proposal' }],
                'semantic.adoption': [{ route, subject_id: id, slot_id: slot, context_id: GLOBAL_CONTEXT,
                  head: 1, mode: 'replace', selection: [{ candidate, rank: 'normal' }], revision: ordinal + 2 }],
              };
            }
            const related = newId(route);
            const statement = newId(route);
            return {
              'semantic.outbound_link': [{ route, subject_id: id, property: 'schema:author',
                filter_value: '00000000-0000-0000-0000-000000000000', order_key: String(ordinal),
                target_subject_id: related, statement_id: statement, slot_id: newId(route), relation: true,
                source_revision: 1, value: 'value', present: true, recorded_transaction_id: transaction }],
              'semantic.inbound_link': [{ route, subject_id: id, property: 'schema:author',
                source_subject_id: related, statement_id: statement, source_revision: 1,
                present: true, recorded_transaction_id: transaction }],
            };
          },
        }, { from: previous, to: scale });
        // Display text grows independently of the fixed identity input and result.
        await database.admin.query('UPDATE semantic.subject SET type=$3 WHERE route=$1 AND subject_id=$2',
          [route, id, `schema:T${'x'.repeat(scale)}`]);
        await database.admin.query(`INSERT INTO semantic.fact
          (route,subject_id,slot_id,log_seq,operation,kind,language,body,recorded_transaction_id)
          VALUES ($1,$2,$3,1,'assert','label','en',$4::jsonb,$5)`,
        [route, id, newId(route), JSON.stringify('Label'.repeat(scale)), randomUUID()]);
      },
      operation: async () => {
        const value = await read();
        expect(value).not.toBeNull();
        if (axis === 'redirects') expect(value).toEqual({ from: id, to: target });
        else expect(value).toHaveProperty('id', id);
        const bytes = encode(value);
        expected ??= bytes;
        expect(bytes).toBe(expected);
        return value;
      },
      warmup: async (database) => {
        const measured = await capture(database, read);
        const cost = costOf(measured.capture);
        const sql = measured.capture.statements.join('\n');
        expect(sql).not.toMatch(/consumer_checkpoint|projection_pending|semantic\.(?:fact|definition\w*|summary\w*|merge_member|outbound_link\w*|inbound_link\w*|revision|candidate|adoption)\b/i);
        expect(Object.keys(cost.relations).sort()).toEqual(['core.partition', 'semantic.redirect', 'semantic.subject']);
        expect(cost.rows).toBe(axis === 'redirects' ? 3 : 2);
        expect(cost.statements).toBe(2);
        expect(cost.controlStatements).toBe(3);
        const plans = JSON.stringify(measured.capture.plans);
        expect(plans).toContain('subject_pkey');
        expect(plans).toContain('redirect_pkey');
        expect(cost.relations['semantic.subject']!.sequentialScans).toBe(0);
        expect(cost.relations['semantic.redirect']!.sequentialScans).toBe(0);
        expect(encode(measured.value)).toBe(expected ?? encode(measured.value));
      },
    });
    expect(report.samples).toHaveLength(3);
    console.log(`Reference ${axis}: ${encode(report.samples.map(({ scale, cost }) => ({ scale,
      rows: cost.rows, statements: cost.statements, controls: cost.controlStatements, blocks: cost.blocks,
      bytes: Buffer.byteLength(expected!), })))}`);
  }
}, 60_000);
