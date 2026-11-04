import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { ACCOUNT_ROLE_BITS } from '../../src/history/contracts.ts';
import { bindCommandHistoryEvidence } from '../../src/history/record.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { listSubjectLinks, listSubjectRelations } from '../../src/semantic/links.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { seedSemanticPopulation, unrelatedSemanticPopulation } from './planner-fixtures.ts';

const appearanceProperty = 'schema:character';
const identityProperty = 'rezics:relatedCharacterIdentity';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const route = 16000;
const character = newId(route);
const holder = newId(route + 16);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(86)]]) };
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'growth-character-work',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const historyAccounts = [
  {
    accountRoute: route,
    accountId: actor.accountId,
    roles: ACCOUNT_ROLE_BITS.principal | ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS['acting-human'],
  },
];
function creationAuthorization(target: { route: number; id: string }) {
  return {
    action: 'subject:create',
    resource: target,
    denied: () => new Error('Subject creation is not authorized'),
    async authorize(tx: Parameters<typeof bindCommandHistoryEvidence>[0]) {
      bindCommandHistoryEvidence(tx, historyAccounts);
      return 'execute' as const;
    },
  };
}
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  configureTestReceiptKeys(db.pool);
  const digest = await bootstrapRelease(db.pool, bundledRelease);
  await createSubject(db.pool, {
    actor,
    target: { route, id: character },
    idempotencyKey: character,
    digest: new Uint8Array(32),
    item: { type: 'wd:Q95074', labels: { en: 'Anchor character' } },
    release: { digest, release: bundledRelease },
    authorization: creationAuthorization({ route, id: character }),
  });
  await createSubject(db.pool, {
    actor,
    target: { route: route + 16, id: holder },
    idempotencyKey: holder,
    digest: new Uint8Array(32),
    item: { type: 'schema:VideoGame', labels: { en: 'Holder work' } },
    release: { digest, release: bundledRelease },
    authorization: creationAuthorization({ route: route + 16, id: holder }),
  });
});
afterAll(async () => {
  await db.close();
});

test('a 20-row character appearance window stays fixed at 64/512/4096 unrelated population', async () => {
  const unrelated = unrelatedSemanticPopulation('character-work-identity-unrelated', route >>> 4);
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
      await seedSemanticPopulation(db, unrelated.population, { from: previous * 500, to: scale * 500 });
      if (previous === 0) {
        await db.admin.query(
          `INSERT INTO semantic.inbound_link(route,subject_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key,filter_value)
          SELECT $1,$2,$3,$4,gen_random_uuid(),1,true,gen_random_uuid(),'schema:VideoGame',lpad(n::text,8,'0'),'00000000-0000-0000-0000-000000000000'
          FROM generate_series(0,24) n`,
          [route, character, appearanceProperty, holder],
        );
        await db.admin.query(
          `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
          VALUES ($1,$2,$3,'00000000-0000-0000-0000-000000000000',25)
          ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=excluded.value`,
          [route, character, appearanceProperty],
        );
      }
    },
    operation: window,
  });
  expect(report.samples).toHaveLength(3);
}, 180_000);
