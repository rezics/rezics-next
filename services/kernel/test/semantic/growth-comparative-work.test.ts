import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts, type Fact } from '../../src/semantic/item.ts';
import { listSubjectLinks, listSubjectRelations } from '../../src/semantic/links.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const comparison = 'rezics:stylisticallyComparableTo';
const route = 15000;
const nil = '00000000-0000-0000-0000-000000000000';
const keyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(84)]]) };
const routeKey = new Uint8Array(32).fill(1);
const commandDigest = new Uint8Array(32).fill(31);
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'growth-comparative-work',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};

let database: GrowthDatabase;
let anchor = '';
let inverseAnchor = '';
let anchorRoute = 0;
let targets: string[] = [];
let anchorFacts: Fact[] = [];
let targetLabels: Fact[][] = [];
let targetFacts: Fact[] = [];

const statement = (target: string) => ({
  property: { id: comparison },
  value: { type: 'value' as const, content: target },
  qualifiers: [],
  references: [],
});

function factFor(subject: string, target: string, type: string): Fact {
  const fact = itemFacts(subject, { statements: { [comparison]: [statement(target)] } }, type, bundledRelease).find(
    (entry) => entry.kind === 'statement',
  );
  if (!fact) throw new Error(`Missing comparative Work fact for ${subject}`);
  return fact;
}

async function create(type: string, label: string): Promise<string> {
  const id = newId(route);
  await createSubject(database.pool, {
    actor,
    target: { route, id },
    idempotencyKey: id,
    digest: commandDigest,
    item: { type, labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return id;
}

function population(): Population {
  return {
    name: 'comparative-work-forward-inverse-degree',
    hotPartition: partitionOf(anchorRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const target = targets[ordinal]!;
      const targetCreateTransaction = randomUUID();
      const targetAdoptTransaction = randomUUID();
      const anchorTransaction = randomUUID();
      const targetLabel = targetLabels[ordinal]!;
      const anchorFact = anchorFacts[ordinal]!;
      const targetFact = targetFacts[ordinal]!;
      const title = `Comparative Work ${String(ordinal).padStart(4, '0')}`;
      const orderKey = labelOrderKey({ en: title });
      const anchorRevision = ordinal + 2;
      return {
        'semantic.subject': [
          {
            route: anchorRoute,
            subject_id: target,
            type: 'wd:Q689445',
            recorded_transaction_id: targetCreateTransaction,
            visibility: 'visible',
            security_revision: 0,
            current_facts: 2,
            current_release: bundledDigest,
          },
        ],
        'semantic.revision': [
          {
            route: anchorRoute,
            subject_id: target,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: targetCreateTransaction,
          },
          {
            route: anchorRoute,
            subject_id: target,
            revision: 2,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: targetAdoptTransaction,
          },
          {
            route: anchorRoute,
            subject_id: anchor,
            revision: anchorRevision,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: anchorTransaction,
          },
        ],
        'semantic.fact': [
          {
            ...targetLabel[0]!,
            route: anchorRoute,
            subject_id: target,
            recorded_transaction_id: targetCreateTransaction,
            release: null,
            relation: false,
          },
          {
            ...targetFact,
            route: anchorRoute,
            subject_id: target,
            recorded_transaction_id: targetAdoptTransaction,
            release: bundledDigest,
            relation: true,
          },
          {
            ...anchorFact,
            route: anchorRoute,
            subject_id: anchor,
            recorded_transaction_id: anchorTransaction,
            release: bundledDigest,
            relation: true,
          },
        ],
        'semantic.outbound_link': [
          {
            route: anchorRoute,
            subject_id: anchor,
            property: comparison,
            filter_value: nil,
            order_key: orderKey,
            target_subject_id: target,
            statement_id: anchorFact.statement_id,
            slot_id: anchorFact.slot_id,
            relation: true,
            source_type: 'schema:Book',
            source_order_key: '',
            outbound_order: 'name',
            source_revision: anchorRevision,
            source_security_revision: 0,
            target_revision: 2,
            target_type: 'wd:Q689445',
            external: null,
            value: 'value',
            present: true,
            recorded_transaction_id: anchorTransaction,
          },
          {
            route: anchorRoute,
            subject_id: target,
            property: comparison,
            filter_value: nil,
            order_key: labelOrderKey({ en: 'Comparative Work target' }),
            target_subject_id: inverseAnchor,
            statement_id: targetFact.statement_id,
            slot_id: targetFact.slot_id,
            relation: true,
            source_type: 'wd:Q689445',
            source_order_key: '',
            outbound_order: 'name',
            source_revision: 2,
            source_security_revision: 0,
            target_revision: 1,
            target_type: 'schema:Book',
            external: null,
            value: 'value',
            present: true,
            recorded_transaction_id: targetAdoptTransaction,
          },
        ],
        'semantic.inbound_link': [
          {
            route: anchorRoute,
            subject_id: target,
            property: comparison,
            source_subject_id: anchor,
            statement_id: anchorFact.statement_id,
            source_revision: anchorRevision,
            source_security_revision: 0,
            present: true,
            recorded_transaction_id: anchorTransaction,
            source_type: 'schema:Book',
            order_key: labelOrderKey({ en: 'Comparative Work target' }),
            filter_value: nil,
          },
          {
            route: anchorRoute,
            subject_id: inverseAnchor,
            property: comparison,
            source_subject_id: target,
            statement_id: targetFact.statement_id,
            source_revision: 2,
            source_security_revision: 0,
            present: true,
            recorded_transaction_id: targetAdoptTransaction,
            source_type: 'wd:Q689445',
            order_key: orderKey,
            filter_value: nil,
          },
        ],
      };
    },
    finish: async (admin, range) => {
      if (range.to > range.from)
        await admin.query('UPDATE semantic.partition_subjects SET visible = visible + $2 WHERE partition_no = $1', [
          partitionOf(anchorRoute),
          range.to - range.from,
        ]);
    },
  };
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(database.pool, bundledRelease);
  await activeRelease(database.pool);
  await create('schema:Book', 'Comparative Work degree source').then((id) => (anchor = id));
  await create('schema:Book', 'Comparative Work inverse target').then((id) => (inverseAnchor = id));
  anchorRoute = routeOf(anchor)!;
  targets = Array.from({ length: 4096 }, () => newId(anchorRoute));
  targetLabels = targets.map((target, ordinal) =>
    itemFacts(
      target,
      { labels: { en: `Comparative Work ${String(ordinal).padStart(4, '0')}` } },
      'wd:Q689445',
      bundledRelease,
    ).filter((fact) => fact.kind === 'label'),
  );
  anchorFacts = targets.map((target) => factFor(anchor, target, 'schema:Book'));
  targetFacts = targets.map((target) => factFor(target, inverseAnchor, 'wd:Q689445'));
}, 60_000);

afterAll(async () => {
  await database?.close();
});

test('comparative Work forward and inverse native pages stay bounded from 64 through 4096 members', async () => {
  const relations = population();
  const report = await checkGrowth(database, {
    name: 'Comparative Work forward and inverse native pages',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (_database, scale, previous) => {
      await seed({ pool: database.pool, admin: database.admin }, relations, { from: previous, to: scale });
    },
    operation: async () => {
      const forward = await listSubjectRelations(database.pool, keyRing, {
        routeKey,
        subject: anchor,
        property: comparison,
        context: GLOBAL_CONTEXT,
        limit: 25,
        release: bundledRelease,
        authorize: async () => true,
        seen: [],
        caughtUp: true,
      });
      expect(forward.relations).toHaveLength(25);
      expect(forward.relations.every((entry) => entry.type === 'wd:Q689445')).toBe(true);
      expect(forward.next).not.toBeNull();

      const inverse = await listSubjectLinks(database.pool, keyRing, {
        routeKey,
        subject: inverseAnchor,
        property: comparison,
        limit: 25,
        release: bundledRelease,
        authorize: async () => true,
        seen: [],
        caughtUp: true,
      });
      expect(inverse.links).toHaveLength(25);
      expect(inverse.links.every((entry) => entry.type === 'wd:Q689445')).toBe(true);
      expect(inverse.next).not.toBeNull();
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 120_000);
