import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createContext } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { moderateStatement } from '../../src/semantic/moderation.ts';
import { adoptCandidates, decideCandidate, proposeStatement } from '../../src/semantic/candidates.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import type { AccountActor } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let source: ReturnType<typeof subjectSource>;
const hotPartition = 2048;
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000054',
  clientId: 'growth',
  scopes: ['subject:create', 'subject:read', 'statement:propose', 'context:accept', 'context:adopt', 'moderation:hide'],
  requestedBy: null,
  authnEpoch: 1,
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  source = subjectSource(db.pool);
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
  await seed({ pool: db.pool, admin: db.admin }, supportingData(), { from: 0, to: 2_000 });
});
afterAll(async () => {
  if (db) await db.close();
});

function auth(id: string, action: string): CommandAuthorization {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Expected a routed resource id');
  return {
    action,
    resource: { route, id },
    denied: () => new Error('Growth fixture authorization denied'),
    async authorize() {
      return 'execute';
    },
  };
}

function digest(seed: string): Uint8Array {
  return createHash('sha256').update(seed).digest();
}

async function writeSubject(route: number, label: string): Promise<string> {
  const target = { route, id: newId(route) };
  await createSubject(db.pool, {
    actor,
    target,
    idempotencyKey: randomUUID(),
    digest: digest(target.id),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return target.id;
}

function population(name: string): Population {
  let current: Population;
  current = {
    name,
    hotPartition,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const transactionId = randomUUID();
      const facts = itemFacts(id, { labels: { en: `Seed ${ordinal}` } });
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transactionId,
            visibility: 'visible',
            security_revision: 0,
            current_facts: facts.length,
            current_release: bundledDigest,
          },
        ],
        'semantic.fact': facts.map((fact) => ({
          ...fact,
          route,
          subject_id: id,
          recorded_transaction_id: transactionId,
          release: null,
        })),
      };
    },
    finish: async (admin, range) => {
      const counts = new Map<number, number>();
      for (let ordinal = range.from; ordinal < range.to; ordinal++) {
        const partition = placement(current, ordinal).partition;
        counts.set(partition, (counts.get(partition) ?? 0) + 1);
      }
      for (const [partition, visible] of counts) {
        await admin.query(
          `INSERT INTO semantic.partition_subjects (partition_no, visible) VALUES ($1, $2)
           ON CONFLICT (partition_no) DO UPDATE SET visible = semantic.partition_subjects.visible + EXCLUDED.visible`,
          [partition, visible],
        );
        await admin.query('UPDATE core.partition SET position = GREATEST(position, $2) WHERE partition_no = $1', [
          partition,
          1_000_000_000 + range.to,
        ]);
      }
    },
  };
  return current;
}

async function growPopulation(database: GrowthDatabase, name: string, scale: number, previous: number) {
  const records = population(name);
  await seed({ pool: database.pool, admin: database.admin }, records, { from: previous, to: scale });
}

function supportingData(): Population {
  return {
    name: 'semantic-search-source-supporting-data',
    hotPartition,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const candidate = newId(route);
      const slot = newId(route);
      const transactionId = randomUUID();
      const releaseDigest = `sha256:${createHash('sha256').update(`source-release-${ordinal}`).digest('hex')}`;
      const statement = {
        value: { type: 'value', content: 'ja' },
        qualifiers: [],
        references: [],
      };
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transactionId,
            visibility: 'visible',
            security_revision: 0,
            current_facts: 2,
            current_release: bundledDigest,
          },
        ],
        'semantic.revision': [
          {
            route,
            subject_id: id,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transactionId,
          },
        ],
        'semantic.fact': [
          ...itemFacts(id, { labels: { en: `Support ${ordinal}` } }).map((fact) => ({
            ...fact,
            route,
            subject_id: id,
            recorded_transaction_id: transactionId,
            release: null,
          })),
          {
            route,
            subject_id: id,
            slot_id: slot,
            log_seq: 1,
            operation: 'assert',
            kind: 'statement',
            language: null,
            property: 'schema:inLanguage',
            statement_id: candidate,
            body: { ...statement, rank: 'normal' },
            recorded_transaction_id: transactionId,
            release: bundledDigest,
          },
        ],
        'semantic.candidate': [
          {
            route,
            subject_id: id,
            candidate_id: candidate,
            slot_id: slot,
            property: 'schema:inLanguage',
            rank: 'normal',
            statement,
            release: bundledDigest,
            revision: 1,
            origin: 'proposal',
            view_order: 0,
          },
        ],
        'semantic.adoption': [
          {
            route,
            subject_id: id,
            slot_id: slot,
            context_id: GLOBAL_CONTEXT,
            head: 1,
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            revision: 1,
          },
        ],
        'semantic.hidden_candidate': [
          {
            route,
            subject_id: id,
            candidate_id: candidate,
            visibility: 'hidden',
            security_revision: 1,
          },
        ],
        'semantic.redirect': [
          {
            route,
            subject_id: id,
            sequence: 1,
            target: '00000000-0000-0000-0000-000000000000',
            recorded_transaction_id: transactionId,
          },
        ],
        'semantic.definition_release': [
          {
            route: 0,
            digest: releaseDigest,
            body: { types: {}, properties: {} },
            recorded_transaction_id: transactionId,
          },
        ],
      };
    },
  };
}

test('Source snapshot stays within its bound as P grows', async () => {
  const ids = await Promise.all(
    Array.from({ length: 32 }, (_, index) => writeSubject(hotPartition * 16, `Fixed ${index}`)),
  );
  const report = await checkGrowth(db, {
    name: 'Source snapshot stays within its bound as P grows',
    scales: [8, 64, 512],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    grow: (database, scale, previous) => growPopulation(database, 'semantic-search-source-p-growth', scale, previous),
    operation: () => source.read(hotPartition, ids),
  });
  expect(report.samples).toHaveLength(3);
}, 60_000);

test("Source snapshot stays within its bound as a subject's history grows", async () => {
  const route = hotPartition * 16;
  const subject = await writeSubject(route, 'History anchor');
  const neighbor = await writeSubject(route, 'History neighbor');
  const contextTarget = { route, id: newId(route) };
  const context = await createContext(db.pool, {
    actor,
    target: contextTarget,
    idempotencyKey: randomUUID(),
    digest: digest(contextTarget.id),
    input: { labels: { en: 'History context' } },
    authorize: async () => true,
  });
  const contextId = context.context.id;
  const command = (action: string) => ({
    actor,
    subject,
    idempotencyKey: randomUUID(),
    digest: digest(`${action}-${randomUUID()}`),
    authorization: auth(subject, action),
    deadline: Date.now() + 30_000,
  });
  const statement = {
    property: { id: 'schema:inLanguage' },
    value: { type: 'value' as const, content: 'ja' },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value' as const, content: 'https://example.org/record' },
          },
        ],
      },
    ],
  };
  let latestCandidate = '';
  let selectedCandidate = '';
  let globalHead: number | null = null;
  let contextHead: number | null = null;

  const report = await checkGrowth(db, {
    name: "Source snapshot stays within its bound as a subject's history grows",
    scales: [8, 64, 512],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    grow: async (_database, scale, previous) => {
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        switch (ordinal % 5) {
          case 0:
            latestCandidate = (
              await proposeStatement(db.pool, {
                ...command('statement:propose'),
                statement,
                release: { digest: bundledDigest, release: bundledRelease },
              })
            ).candidate;
            break;
          case 1:
            await decideCandidate(db.pool, {
              ...command('context:accept'),
              candidate: latestCandidate,
              context: GLOBAL_CONTEXT,
              decision: 'accept',
              expectedHead: null,
            });
            break;
          case 2:
            await decideCandidate(db.pool, {
              ...command('context:accept'),
              candidate: latestCandidate,
              context: contextId,
              decision: 'accept',
              expectedHead: null,
            });
            break;
          case 3:
            globalHead = (
              await adoptCandidates(db.pool, {
                ...command('context:adopt'),
                context: GLOBAL_CONTEXT,
                property: 'schema:inLanguage',
                mode: 'replace',
                selection: [{ candidate: latestCandidate, rank: 'normal' }],
                expectedHead: globalHead,
                release: { digest: bundledDigest, release: bundledRelease },
              })
            ).adoption.head;
            selectedCandidate = latestCandidate;
            break;
          case 4:
            contextHead = (
              await adoptCandidates(db.pool, {
                ...command('context:adopt'),
                context: contextId,
                property: 'schema:inLanguage',
                mode: 'replace',
                selection: [{ candidate: latestCandidate, rank: 'normal' }],
                expectedHead: contextHead,
                release: { digest: bundledDigest, release: bundledRelease },
              })
            ).adoption.head;
            break;
        }
      }
      if (scale === 512) {
        await moderateStatement(db.pool, {
          ...command('moderation:hide'),
          subject,
          candidate: selectedCandidate,
          action: 'hide',
          body: { reason: 'Growth fixture hidden statement' },
        });
      }
    },
    operation: () => source.read(hotPartition, [subject, neighbor]),
  });
  expect(report.samples).toHaveLength(3);
}, 60_000);

test('Source count stays within its bound as P grows', async () => {
  const report = await checkGrowth(db, {
    name: 'Source count stays within its bound as P grows',
    scales: [8, 64, 512],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    grow: (database, scale, previous) =>
      growPopulation(database, 'semantic-search-source-count-growth', scale, previous),
    operation: () => source.count(hotPartition),
  });
  expect(report.samples).toHaveLength(3);
}, 60_000);
