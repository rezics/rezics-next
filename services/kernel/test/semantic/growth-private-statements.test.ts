import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId } from '../../src/route/route.ts';
import { ensureAccountAgent, accountAgentId } from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { relationSlotForApi } from '../../src/semantic/item.ts';
import { listSubjectLinks } from '../../src/semantic/links.ts';
import { withStatementReader } from '../../src/semantic/statement-disclosure.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const route = 24000;
const owner = newId(route);
const outsider = newId(route);
const target = accountAgentId(owner);
const property = 'rezics:penNameOf';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  await ensureAccountAgent(db.pool, { account: owner, kind: 'person', name: 'Private names' });
});
afterAll(async () => {
  await db.close();
});

test('public inverse rows stay flat with 64, 512 and 4096 private pen-name links', async () => {
  const report = await checkGrowth(db, {
    name: 'public inverse rows stay flat with private pen-name links',
    scales: [64, 512, 4096],
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const entries = Array.from({ length: scale - previous }, () => {
        const subject = newId(route);
        return {
          subject,
          candidate: newId(route),
          slot: relationSlotForApi(subject, property, bundledRelease.properties[property]!.relation, { target }),
        };
      });
      const data = JSON.stringify(entries);
      await database.admin.query(
        `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_release)
        SELECT $1,subject,'schema:Person',subject,$3 FROM jsonb_to_recordset($2) AS x(subject uuid)`,
        [route, data, bundledDigest],
      );
      await database.admin.query(
        `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
        SELECT $1,subject,1,'create',$3,subject FROM jsonb_to_recordset($2) AS x(subject uuid)`,
        [route, data, bundledDigest],
      );
      await database.admin.query(
        `INSERT INTO semantic.candidate(route,subject_id,candidate_id,slot_id,property,rank,statement,release,revision,origin,relation)
        SELECT $1,subject,candidate,slot,$3,'normal',$4,$5,1,'compact',true
        FROM jsonb_to_recordset($2) AS x(subject uuid,candidate uuid,slot uuid)`,
        [
          route,
          data,
          property,
          JSON.stringify({ rank: 'normal', value: { type: 'value', content: target }, qualifiers: [], references: [] }),
          bundledDigest,
        ],
      );
      await database.admin.query(
        `INSERT INTO semantic.adoption(route,subject_id,slot_id,context_id,head,mode,selection,revision)
        SELECT $1,subject,slot,$3,1,'replace',jsonb_build_array(jsonb_build_object('candidate',candidate,'rank','normal')),1
        FROM jsonb_to_recordset($2) AS x(subject uuid,candidate uuid,slot uuid)`,
        [route, data, GLOBAL_CONTEXT],
      );
      await database.admin.query(
        `INSERT INTO semantic.statement_disclosure(route,subject_id,candidate_id,target_id,account_id,property,source_order_key,target_order_key)
        SELECT $1,subject,candidate,$3,$4,$5,'0name','0person'
        FROM jsonb_to_recordset($2) AS x(subject uuid,candidate uuid)`,
        [route, data, target, owner, property],
      );
    },
    async operation(database) {
      const page = await withStatementReader({ account: outsider, moderator: async () => false }, () =>
        listSubjectLinks(
          database.pool,
          { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
          {
            subject: target,
            property,
            limit: 20,
            authorize: async () => true,
            seen: [],
            caughtUp: true,
            release: bundledRelease,
          },
        ),
      );
      expect(page.links).toEqual([]);
      expect(page.count).toEqual({ value: 0, exact: true });
    },
  });
  expect(report.samples.map((row) => row.scale)).toEqual([64, 512, 4096]);
});
