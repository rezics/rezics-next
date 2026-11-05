import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createContext } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { moderateStatement } from '../../src/semantic/moderation.ts';
import { adoptCandidates, decideCandidate, proposeStatement } from '../../src/semantic/candidates.ts';
import { createSubject, readLabels, writeFacts } from '../../src/semantic/subject.ts';
import listOutboundPage from '../../src/semantic/list-outbound-links-by-property.sql';
import listInboundPage from '../../src/semantic/list-inbound-links-by-property.sql';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Placement,
  type Population,
} from '../support/growth.ts';
import {
  captureUnforcedIndexes,
  logGrowthSeeding,
  seedSemanticPopulation,
  unrelatedSemanticPopulation,
} from './planner-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const LABEL_PARTITION = 500;
const RELATED_PARTITIONS = [510, 511, 512] as const;
const BOOK_PARTITION = 513;
const HISTORY_PARTITION = 520;
const routeKey = new Uint8Array(32).fill(61);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
  clientId: 'growth',
  scopes: [
    'subject:create',
    'subject:read',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'context:create',
    'moderation:hide',
  ],
  requestedBy: null,
  authnEpoch: 1,
};

let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
const labelIds = Array.from({ length: 8 }, (_, index) => newId(LABEL_PARTITION * 16 + index));
const people = Array.from({ length: 6 }, (_, index) => {
  const partition = RELATED_PARTITIONS[index % RELATED_PARTITIONS.length]!;
  return newId(partition * 16 + Math.floor(index / RELATED_PARTITIONS.length));
});
const bookId = newId(BOOK_PARTITION * 16);

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  kernel = createKernel({ pool: db.pool, routeKey, tokens });
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
  for (const [index, id] of labelIds.entries()) {
    await createFixed(routeOf(id)!, id, 'schema:Book', { en: `Label ${index}` });
  }
  for (const [index, id] of people.entries()) {
    await createFixed(routeOf(id)!, id, 'schema:Person', { en: `Person ${index}` });
  }
  await createFixed(
    routeOf(bookId)!,
    bookId,
    'schema:Book',
    { en: 'Related anchor' },
    {
      'schema:author': people.map((id) => ({
        property: { id: 'schema:author' },
        value: { type: 'value', content: id },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.org/record' },
              },
            ],
          },
        ],
      })),
    },
  );
  const projection = linkProjection(db.pool);
  for (let step = 0; step < 200; step++) {
    const result = await projection.run(BOOK_PARTITION);
    if (result.status !== 'busy' && result.envelopes === 0) break;
    if (step === 199) throw new Error('Semantic link projection did not catch up');
  }
  await seed({ pool: db.pool, admin: db.admin }, accessGrants(), { from: 0, to: 2_000 });
}, 60_000);

afterAll(async () => {
  if (db) await db.close();
});

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}

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

async function createFixed(
  route: number,
  id: string,
  type: string,
  labels: Record<string, string>,
  statements?: Record<string, unknown>,
): Promise<void> {
  await createSubject(db.pool, {
    actor,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: digest(id),
    item: { type, labels, ...(statements ? { statements } : {}) },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
}

function positionOf(name: string, ordinal: number): number {
  return 1_000_000_000 + createHash('sha256').update(name).digest().readUIntBE(0, 3) * 2_100_000 + ordinal * 128;
}

function subjectRows(name: string, ordinal: number, route: number): Record<string, readonly Record<string, unknown>[]> {
  const id = newId(route);
  const transactionId = randomUUID();
  const facts = itemFacts(id, { labels: { en: `Seed ${ordinal}` } });
  const position = positionOf(name, ordinal);
  const partition = route >>> 4;
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
    'core.receipt': [
      {
        partition_no: partition,
        principal_kind: 'account',
        principal_id: actor.accountId,
        command_kind: 'subject.create',
        idempotency_key: `${name}-${ordinal}-${randomUUID()}`,
        request_digest: digest(`${name}-${ordinal}`),
        epoch: 1,
        position,
        transaction_id: randomUUID(),
        response: { id },
      },
    ],
    'core.outbox': [
      {
        partition_no: partition,
        position,
        event_seq: 0,
        event_count: 1,
        epoch: 1,
        id: newId(route),
        type: 'com.rezics.subject.created.v1',
        subject: id,
        data: { id },
      },
    ],
    'editorial.write_basis': [
      {
        partition_no: partition,
        transaction_id: randomUUID(),
        epoch: 1,
        position,
        principal_kind: 'account',
        principal_id: actor.accountId,
        client_id: actor.clientId,
        requested_by: null,
      },
    ],
  };
}

function growingPopulation(
  name: string,
  hotPartition: number,
  hotShare: number,
  routeFor: (ordinal: number, placed: Placement) => number,
): Population {
  let current: Population;
  current = {
    name,
    hotPartition,
    hotShare,
    rows: (placed) => subjectRows(name, placed.ordinal, routeFor(placed.ordinal, placed)),
    finish: async (admin, range) => {
      const positions = new Map<number, number>();
      for (let ordinal = range.from; ordinal < range.to; ordinal++) {
        const route = routeFor(ordinal, placement(current, ordinal));
        const partition = route >>> 4;
        positions.set(partition, Math.max(positions.get(partition) ?? 0, positionOf(name, ordinal)));
      }
      for (const [partition, position] of positions) {
        await admin.query('UPDATE core.partition SET position = GREATEST(position, $2) WHERE partition_no = $1', [
          partition,
          position,
        ]);
      }
    },
  };
  return current;
}

function accessGrants(): Population {
  return {
    name: 'semantic-growth-read-access',
    hotPartition: 700,
    hotShare: 0.5,
    rows: ({ route }) => ({
      'access.resource_grant': [
        {
          route,
          resource_id: newId(route),
          subject_id: actor.accountId,
          subject_role: '',
          action: 'subject:read',
          valid: '(,)',
          transaction_id: randomUUID(),
          subject_kind: 'identity',
        },
      ],
    }),
  };
}

function editorialBaseline(): Population {
  return {
    name: 'semantic-growth-read-history-baseline',
    hotPartition: 530,
    hotShare: 0.5,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const candidate = newId(route);
      const slot = newId(route);
      const transactionId = randomUUID();
      const facts = itemFacts(id, { labels: { en: `History support ${ordinal}` } });
      const statement = { value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] };
      const position = positionOf('semantic-growth-read-history-baseline', ordinal);
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transactionId,
            visibility: 'visible',
            security_revision: 0,
            current_facts: facts.length + 1,
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
        'semantic.acceptance': [
          {
            route,
            subject_id: id,
            context_id: GLOBAL_CONTEXT,
            candidate_id: candidate,
            head: 1,
            verdict: 'accept',
            revision: 1,
          },
        ],
        'semantic.acceptance_current': [
          {
            route,
            subject_id: id,
            context_id: GLOBAL_CONTEXT,
            candidate_id: candidate,
            slot_id: slot,
            head: 1,
            verdict: 'accept',
            revision: 1,
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
        'semantic.fact': [
          ...facts.map((fact) => ({
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
        'core.receipt': [
          {
            partition_no: route >>> 4,
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: 'subject.create',
            idempotency_key: `history-base-${ordinal}-${randomUUID()}`,
            request_digest: digest(`history-base-${ordinal}`),
            epoch: 1,
            position,
            transaction_id: randomUUID(),
            response: { id },
          },
        ],
        'core.outbox': [
          {
            partition_no: route >>> 4,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(route),
            type: 'com.rezics.subject.created.v1',
            subject: id,
            data: { id },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: route >>> 4,
            transaction_id: randomUUID(),
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: actor.accountId,
            client_id: actor.clientId,
            requested_by: null,
          },
        ],
      };
    },
  };
}

async function growPopulation(population: Population, scale: number, previous: number, perScale: number, base: number) {
  await seed({ pool: db.pool, admin: db.admin }, population, {
    from: previous === 0 ? 0 : base + previous * perScale,
    to: base + scale * perScale,
  });
  await db.admin.query('CHECKPOINT');
}

async function readAnchor(id: string): Promise<{ related: Record<string, { labels?: Record<string, string> }> }> {
  const response = await kernel.handle(new Request(`http://localhost/v1/subjects/${id}`));
  const text = await response.text();
  if (response.status !== 200) throw new Error(`subject read ${response.status}: ${text}`);
  return JSON.parse(text) as { related: Record<string, { labels?: Record<string, string> }> };
}

test('Batch label fill stays within its bound as its partition grows', async () => {
  const population = growingPopulation(
    'semantic-growth-label-fill',
    LABEL_PARTITION,
    0.5,
    (_ordinal, placed) => placed.route,
  );
  const report = await checkGrowth(db, {
    name: 'Batch label fill stays within its bound as its partition grows',
    bounds,
    grow: (_database, scale, previous) => growPopulation(population, scale, previous, 80, 2_000),
    operation: async (database) => {
      const labels = await readLabels(database.pool, labelIds);
      if (labels.size !== labelIds.length) throw new Error(`expected ${labelIds.length} labels, got ${labels.size}`);
      return labels;
    },
  });
  logGrowthSeeding(report);
  expect(report.samples).toHaveLength(3);
}, 900_000);

test('semantic covering reads use unforced indexed access as populations grow', async () => {
  const population = growingPopulation('semantic-growth-related-labels', 510, 0, (ordinal) => {
    const elsewhere = ordinal % 4 === 3;
    const partition = elsewhere ? 600 + (ordinal % 40) : RELATED_PARTITIONS[ordinal % RELATED_PARTITIONS.length]!;
    return partition * 16 + (ordinal % 16);
  });
  const unrelated = unrelatedSemanticPopulation('growth-reads-related-unrelated', BOOK_PARTITION);
  const operation = async () => {
    const body = await readAnchor(bookId);
    for (const id of people) {
      if (!body.related[id]) throw new Error(`missing related subject ${id}`);
    }
    return body;
  };
  const indexedScales = new Set<number>();
  const report = await checkGrowth(db, {
    name: 'Related labels of a subject read stay within their bound as the related partitions grow',
    bounds,
    grow: async (_database, scale, previous) => {
      await growPopulation(population, scale, previous, 60, 2_400);
      await seedSemanticPopulation({ pool: db.pool, admin: db.admin }, unrelated.population, {
        from: previous * 500,
        to: scale * 500,
      });
    },
    operation,
    prepare: async (_database, scale) => {
      if (indexedScales.has(scale)) return;
      await captureUnforcedIndexes(db, 'Related labels of a subject read', scale, operation, {
        'semantic.subject': 'subject_pkey',
        'semantic.revision': 'revision_pkey',
        'semantic.fact': ['fact_label', 'fact_terms'],
        'semantic.outbound_link': 'outbound_link_present',
        'semantic.outbound_link_count': 'outbound_link_count_pkey',
      });
      indexedScales.add(scale);
    },
  });
  logGrowthSeeding(report);
  expect(report.samples).toHaveLength(3);
}, 900_000);

test("Anchored subject read stays within its bound as the subject's history grows", async () => {
  const route = HISTORY_PARTITION * 16;
  const subject = newId(route);
  await createFixed(route, subject, 'schema:Book', { en: 'History anchor' });
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
  await seed({ pool: db.pool, admin: db.admin }, editorialBaseline(), { from: 0, to: 2_000 });
  const unrelated = unrelatedSemanticPopulation('growth-reads-history-unrelated', HISTORY_PARTITION);
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
  const operation = async () => readAnchor(subject);
  const indexedScales = new Set<number>();
  const report = await checkGrowth(db, {
    name: "Anchored subject read stays within its bound as the subject's history grows",
    scales: [8, 64, 512],
    bounds,
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
      await seedSemanticPopulation({ pool: db.pool, admin: db.admin }, unrelated.population, {
        from: previous * 500,
        to: scale * 500,
      });
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
    operation,
    prepare: async (_database, scale) => {
      if (indexedScales.has(scale)) return;
      await captureUnforcedIndexes(db, 'Anchored subject read', scale, operation, {
        'semantic.subject': 'subject_pkey',
        'semantic.redirect': 'redirect_pkey',
        'semantic.revision': 'revision_pkey',
        'semantic.fact': ['fact_label', 'fact_terms'],
        'semantic.outbound_link': 'outbound_link_present',
        'semantic.outbound_link_count': 'outbound_link_count_pkey',
        'semantic.candidate': 'candidate_page',
        'semantic.adoption': 'adoption_pkey',
        'semantic.acceptance_current': 'acceptance_current_rejected',
        'semantic.hidden_candidate': 'hidden_candidate_pkey',
      });
      indexedScales.add(scale);
    },
  });
  logGrowthSeeding(report);
  expect(report.samples).toHaveLength(3);
}, 900_000);

test('the fact writer refuses more than 512 facts for one subject', async () => {
  let queried = false;
  const client = {
    async query(): Promise<unknown> {
      queried = true;
      throw new Error('SQL should not run');
    },
  };
  const route = LABEL_PARTITION * 16;
  const facts = Array.from({ length: 513 }, (_, index) => ({
    slot_id: newId(route),
    log_seq: 1,
    operation: 'assert' as const,
    kind: 'label' as const,
    language: 'en',
    property: null,
    statement_id: null,
    body: `Fact ${index}`,
    release: null,
  }));
  await expect(
    writeFacts(client, {
      route,
      subject_id: newId(route),
      transaction_id: randomUUID(),
      facts,
    }),
  ).rejects.toThrow(TypeError);
  expect(queried).toBe(false);
}, 60_000);

test('semantic covering reads use unforced indexed access as their populations grow', async () => {
  const partition = 550;
  const route = partition * 16;
  const holder = newId(route);
  const target = newId(route);
  const nil = '00000000-0000-0000-0000-000000000000';
  await createFixed(route, holder, 'schema:Book', { en: 'Community seek holder' });
  await createFixed(route, target, 'schema:Person', { en: 'Community seek target' });
  const contextTarget = { route, id: newId(route) };
  const created = await createContext(db.pool, {
    actor,
    target: contextTarget,
    idempotencyKey: randomUUID(),
    digest: digest(contextTarget.id),
    input: { labels: { en: 'Community covering seeks' } },
    authorize: async () => true,
  });
  const context = created.context.id;
  const unrelated = unrelatedSemanticPopulation('growth-reads-community-unrelated', partition);
  const page = async (scale: number, selectedContext: string, middle: boolean) => {
    const start = middle ? Math.floor(scale / 2) : 0;
    const afterStatement = start
      ? createHash('md5')
          .update(`community-covering-statement-${start - 1}`)
          .digest('hex')
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
      : nil;
    const parameters = {
      route,
      context_id: selectedContext,
      property: 'schema:author',
      filter_value: nil,
      after_order: start ? String(start - 1).padStart(8, '0') : '',
      after_statement: afterStatement,
      page_limit: 26,
      scan_limit: 0,
    };
    const expected: string[] = [];
    for (let ordinal = start; ordinal < scale && expected.length < 26; ordinal++) {
      if (selectedContext !== GLOBAL_CONTEXT && ordinal < 12) continue;
      expected.push(String(ordinal).padStart(8, '0'));
    }
    expect(expected).toHaveLength(26);
    const outbound = await listOutboundPage.run(db.pool, {
      ...parameters,
      subject_id: holder,
      after_target: start ? target : nil,
    });
    const inbound = await listInboundPage.run(db.pool, {
      ...parameters,
      subject_id: target,
      after_source: start ? holder : nil,
    });
    expect(outbound.map((row) => row.order_key)).toEqual(expected);
    expect(inbound.map((row) => row.order_key)).toEqual(expected);
    expect(outbound.every((row) => row.target === target)).toBe(true);
    expect(inbound.every((row) => row.subject === holder)).toBe(true);
  };
  const indexedScales = new Set<number>();
  const report = await checkGrowth(db, {
    name: 'Global and community native covering seeks',
    scales: [64, 512, 4096],
    bounds,
    grow: async (_database, scale, previous) => {
      await seedSemanticPopulation(db, unrelated.population, { from: previous * 500, to: scale * 500 });
      await db.admin.query(
        `INSERT INTO semantic.outbound_link(route,subject_id,context_id,property,filter_value,order_key,
          target_subject_id,statement_id,slot_id,relation,source_revision,source_type,target_type,value,suppressed,
          present,recorded_transaction_id)
         SELECT $1,$2,context,'schema:author',$5,lpad(n::text,8,'0'),$3,
                md5('community-covering-statement-' || n)::uuid,md5('community-covering-slot-' || n)::uuid,
                true,1,'schema:Book','schema:Person','value',context=$4::uuid AND n<12,
                context<>$4::uuid OR n<12 OR n%2=0,$8
         FROM generate_series($6::integer,$7::integer) n
         CROSS JOIN unnest(ARRAY[$4::uuid,$9::uuid]) context`,
        [route, holder, target, context, nil, previous, scale - 1, randomUUID(), GLOBAL_CONTEXT],
      );
      await db.admin.query(
        `INSERT INTO semantic.inbound_link(route,subject_id,context_id,property,filter_value,order_key,
          source_subject_id,statement_id,source_revision,source_type,suppressed,present,recorded_transaction_id)
         SELECT route,target_subject_id,context_id,property,filter_value,order_key,subject_id,statement_id,
                source_revision,'schema:Book',suppressed,present,recorded_transaction_id
         FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2
           AND order_key>=lpad($3::text,8,'0')`,
        [route, holder, previous],
      );
    },
    operation: async (_database, scale) => {
      for (const selectedContext of [GLOBAL_CONTEXT, context]) {
        await page(scale, selectedContext, false);
        await page(scale, selectedContext, true);
      }
    },
    prepare: async (_database, scale) => {
      if (indexedScales.has(scale)) return;
      for (const selectedContext of [GLOBAL_CONTEXT, context]) {
        for (const middle of [false, true]) {
          await captureUnforcedIndexes(
            db,
            `${selectedContext === GLOBAL_CONTEXT ? 'Global' : 'Community'} covering ${middle ? 'middle' : 'first'} pages`,
            scale,
            () => page(scale, selectedContext, middle),
            { 'semantic.outbound_link': 'outbound_link_present', 'semantic.inbound_link': 'inbound_link_present' },
          );
        }
      }
      indexedScales.add(scale);
    },
  });
  logGrowthSeeding(report);
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
}, 900_000);
