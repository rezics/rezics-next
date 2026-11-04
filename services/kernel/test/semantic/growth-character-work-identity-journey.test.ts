import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { listSubjectLinks, listSubjectRelations } from '../../src/semantic/links.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const appearanceProperty = 'schema:character';
const identityProperty = 'rezics:relatedCharacterIdentity';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const route = 16000;
const character = newId(route);
const holder = newId(route + 16);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(86)]]) };
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  const transaction = randomUUID();
  await db.admin.query(
    `INSERT INTO semantic.subject
      (route,subject_id,type,recorded_transaction_id,visibility,security_revision,current_facts,current_release,projection_pending)
     VALUES
      ($1,$2,'wd:Q95074',$3,'visible',0,1,$4,false),
      ($5,$6,'schema:VideoGame',$3,'visible',0,1,$4,false)`,
    [route, character, transaction, bundledDigest, route + 16, holder],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision (route,subject_id,revision,kind,release,recorded_transaction_id)
     VALUES ($1,$2,1,'create',$3,$4), ($5,$6,1,'create',$3,$4)`,
    [route, character, bundledDigest, transaction, route + 16, holder],
  );
  await db.admin.query(
    `INSERT INTO semantic.inbound_link
      (route,subject_id,context_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key,filter_value)
     SELECT $1,$2,'00000000-0000-8000-8000-000000000000'::uuid,$3,$4,gen_random_uuid(),1,true,gen_random_uuid(),'schema:VideoGame',lpad(n::text,8,'0'),'00000000-0000-0000-0000-000000000000'::uuid
     FROM generate_series(0,24) n`,
    [route, character, appearanceProperty, holder],
  );
  await db.admin.query(
    `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
     VALUES ($1,$2,$3,'00000000-0000-0000-0000-000000000000',25)
     ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=excluded.value`,
    [route, character, appearanceProperty],
  );
});
afterAll(async () => {
  await db.close();
});

test('a 20-row character appearance window stays fixed at 64/512/4096 unrelated population', async () => {
  const window = async () => {
    const appearances = await listSubjectLinks(db.pool, ring, {
      routeKey: new Uint8Array(32).fill(1),
      subject: character,
      property: appearanceProperty,
      limit: 20,
      seen: [],
      caughtUp: true,
      authorize: async () => true,
    });
    expect(appearances.links).toHaveLength(20);
    expect(appearances.next).not.toBeNull();
    const identity = await listSubjectRelations(db.pool, ring, {
      routeKey: new Uint8Array(32).fill(1),
      subject: character,
      property: identityProperty,
      limit: 20,
      seen: [],
      caughtUp: true,
      release: bundledRelease,
      authorize: async () => true,
    });
    expect(identity.relations.length).toBeLessThanOrEqual(20);
  };
  const report = await checkGrowth(db, {
    name: 'Character work identity first window',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant' as const, blocks: 'constant' as const, statements: 'constant' as const },
    grow: async (_database: GrowthDatabase, scale: number, previous: number) => {
      await seed(
        db,
        {
          name: 'character-work-identity-unrelated',
          hotPartition: (route + 16) >>> 4,
          hotShare: 1,
          write: async (target, placement) => {
            await target.admin.query(
              `INSERT INTO semantic.subject
                (route,subject_id,type,recorded_transaction_id,visibility,security_revision,current_facts,current_release,projection_pending)
               VALUES ($1,$2,'schema:Book',$3,'visible',0,0,$4,false)`,
              [placement.route, newId(placement.route), randomUUID(), bundledDigest],
            );
          },
        },
        { from: previous, to: scale },
      );
      if (previous === 0) {
        const existing = await db.admin.query(
          `SELECT 1 FROM semantic.inbound_link WHERE route=$1 AND subject_id=$2 AND property=$3 LIMIT 1`,
          [route, character, appearanceProperty],
        );
        if (existing.rows.length === 0) {
          await db.admin.query(
            `INSERT INTO semantic.inbound_link
              (route,subject_id,context_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key,filter_value)
             SELECT $1,$2,'00000000-0000-8000-8000-000000000000'::uuid,$3,$4,gen_random_uuid(),1,true,gen_random_uuid(),'schema:VideoGame',lpad(n::text,8,'0'),'00000000-0000-0000-0000-000000000000'::uuid
             FROM generate_series(0,24) n`,
            [route, character, appearanceProperty, holder],
          );
        }
      }
    },
    operation: window,
  });
  expect(report.samples).toHaveLength(3);
}, 180_000);
