import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { listSubjectLinks, listSubjectRelations } from '../../src/semantic/links.ts';
import { writeFacts } from '../../src/semantic/write-facts.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const appearanceProperty = 'schema:character';
const identityProperty = 'rezics:relatedCharacterIdentity';
const globalContext = '00000000-0000-8000-8000-000000000000';
const nilFilter = '00000000-0000-0000-0000-000000000000';

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
  const appearances = Array.from({ length: 25 }, () => ({
    property: { id: appearanceProperty },
    value: { type: 'value' as const, content: character },
    qualifiers: [],
    references: [],
  }));
  const facts = itemFacts(
    holder,
    { labels: { en: 'Holder work' }, statements: { [appearanceProperty]: appearances } },
    'schema:VideoGame',
    bundledRelease,
  );
  await db.admin.query(
    `INSERT INTO semantic.subject
      (route,subject_id,type,recorded_transaction_id,visibility,security_revision,current_facts,current_release,projection_pending)
     VALUES
      ($1,$2,'wd:Q95074',$3,'visible',0,0,$4,false),
      ($5,$6,'schema:VideoGame',$3,'visible',0,$7,$4,false)`,
    [route, character, transaction, bundledDigest, route + 16, holder, facts.length],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision (route,subject_id,revision,kind,release,recorded_transaction_id)
     VALUES ($1,$2,1,'create',$3,$4), ($5,$6,1,'create',$3,$4)`,
    [route, character, bundledDigest, transaction, route + 16, holder],
  );
  const client = await db.admin.connect();
  try {
    await writeFacts(client, {
      route: route + 16,
      subject_id: holder,
      transaction_id: transaction,
      facts: facts.map((fact) => ({
        ...fact,
        release: fact.kind === 'statement' ? bundledDigest : null,
        relation: fact.kind === 'statement',
      })),
    });
  } finally {
    client.release();
  }
  const relations = facts.filter((fact) => fact.kind === 'statement');
  await db.admin.query(
    `INSERT INTO semantic.inbound_link
      (route,subject_id,context_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key,filter_value)
     SELECT $1,$2,$3::uuid,$4,$5,statement_id,1,true,$6,'schema:VideoGame',lpad(ordinal::text,8,'0'),$7::uuid
     FROM unnest($8::uuid[]) WITH ORDINALITY AS appearance(statement_id, ordinal)`,
    [
      route,
      character,
      globalContext,
      appearanceProperty,
      holder,
      transaction,
      nilFilter,
      relations.map((fact) => fact.statement_id),
    ],
  );
  await db.admin.query(
    `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
     VALUES ($1,$2,$3,$4,$5)`,
    [route, character, appearanceProperty, nilFilter, relations.length],
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
    },
    operation: window,
  });
  expect(report.samples).toHaveLength(3);
}, 180_000);
