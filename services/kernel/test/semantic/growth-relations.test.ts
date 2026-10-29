import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Capture, Population } from '../support/growth.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { growRelationHistory, readRelationGrowthCardinalities } from '../support/growth-baseline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { createSubject, readSubject } from '../../src/semantic/subject.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { isRelationProperty, itemFacts, type Fact } from '../../src/semantic/item.ts';
import { FRESHNESS_POLL_MS, FRESHNESS_WAIT_MS, waitForSubjectLinks } from '../../src/semantic/link-freshness.ts';
import type { SessionComponent } from '../../src/tokens/session.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { listSubjectRelations } from '../../src/semantic/links.ts';
import type { AccountActor } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const role = newId(513 * 16);
const arc = newId(513 * 16);
const NIL = '00000000-0000-0000-0000-000000000000';
const BASE_ROUTE = 513 * 16;
const PREVIEW = 12;
const PAGE_SIZE = 25;
const properties = bundledRelease.types['schema:Book']!.properties;
const relationProperties = properties.filter((property) => isRelationProperty(bundledRelease, property));
const DESCRIPTIVE_FACTS = 1;
const descriptiveProperties = properties.length - relationProperties.length;
// Native descents into growing subject/fact/revision/outbound/counter indexes, from Semantic Cost:
// F=1 descriptive label; p=the fixed Book relation properties; only author has a nonempty preview.
// Initial read: subject + latest revision + fact_terms + F revision_transaction probes.
// Each empty descriptive slot: operation + compact fact_pkey probes (no provenance rows).
// Each relation property: outbound range + counter; author additionally fetches 13 payload keys.
// Each selected compact relation slot: operation + compact facts + one revision_transaction probe.
// Page: two holder visibility probes, one range, 26 payload keys and one counter.
// Each summary (self + 25 targets): subject, labels, image head, original-language slot, representative range.
// Redirect/account/disclosure/Access/checkpoint tables stay fixed: no growing-index descents.
const probeOperands = {
  initialSubject: 1,
  initialLatestRevision: 1,
  initialDescriptiveRange: 1,
  initialProvenance: DESCRIPTIVE_FACTS,
  emptySlotHeadsAndCompactRanges: 2 * descriptiveProperties,
  previewRangesAndCounters: 2 * relationProperties.length,
  previewPayloadKeys: PREVIEW + 1,
  selectedSlotHeadsAndCompactRanges: 2 * (PREVIEW + PAGE_SIZE),
  selectedSlotProvenance: PREVIEW + PAGE_SIZE,
  pageHolderVisibility: 2,
  pageRange: 1,
  pagePayloadKeys: PAGE_SIZE + 1,
  pageCounter: 1,
  summarySubjects: 1 + PAGE_SIZE,
  summaryLabels: 1 + PAGE_SIZE,
  summaryImageHeads: 1 + PAGE_SIZE,
  summaryOriginalLanguageSlots: 1 + PAGE_SIZE,
  summaryRepresentativeRanges: 1 + PAGE_SIZE,
};
const indexProbes = Object.values(probeOperands).reduce((total, value) => total + value, 0);
const evidenceDirectory = '.temp/growth-relations';
const cardinalities: Record<number, Record<string, number>> = {};
const tokenRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
  clientId: 'growth-relations',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const digest = new Uint8Array(32).fill(31);
const statement = (target: string) => ({
  property: { id: 'schema:author' },
  value: { type: 'value', content: target },
  qualifiers: [
    { property: { id: 'wdt:P3831' }, value: { type: 'value', content: role } },
    { property: { id: 'wdt:P518' }, value: { type: 'value', content: arc } },
  ],
  references: [],
});
const rowsFor = (subject: string, input: unknown, release?: typeof bundledRelease): Fact[] =>
  itemFacts(subject, input, 'schema:Book', release);

let db: GrowthDatabase;
let anchor = '';
let anchorRoute = 0;
let people: string[] = [];
let peopleLabels: Fact[][] = [];
let relationFacts: Fact[] = [];
let population: Population;
let growthHead: SessionComponent | undefined;

function createPopulation(): Population {
  let current: Population;
  current = {
    name: 'semantic-growth-relations',
    hotPartition: partitionOf(anchorRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const target = people[ordinal]!;
      const targetTransaction = randomUUID();
      const relationTransaction = randomUUID();
      const relationFact = relationFacts[ordinal]!;
      const key = labelOrderKey({ en: `Author ${String(ordinal).padStart(4, '0')}` });
      return {
        'semantic.subject': [
          {
            route: anchorRoute,
            subject_id: target,
            type: 'schema:Person',
            recorded_transaction_id: targetTransaction,
            visibility: 'visible',
            security_revision: 0,
            current_facts: 1,
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
            recorded_transaction_id: targetTransaction,
          },
          {
            route: anchorRoute,
            subject_id: anchor,
            revision: ordinal + 2,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: relationTransaction,
          },
        ],
        'semantic.fact': [
          ...peopleLabels[ordinal]!.map((fact) => ({
            ...fact,
            route: anchorRoute,
            subject_id: target,
            recorded_transaction_id: targetTransaction,
            release: null,
            relation: false,
          })),
          {
            ...relationFact,
            route: anchorRoute,
            subject_id: anchor,
            recorded_transaction_id: relationTransaction,
            release: bundledDigest,
            relation: true,
          },
        ],
        'semantic.outbound_link': [NIL, role, arc].map((filter_value) => ({
          route: anchorRoute,
          subject_id: anchor,
          property: 'schema:author',
          filter_value,
          order_key: key,
          target_subject_id: target,
          statement_id: relationFact.statement_id,
          slot_id: relationFact.slot_id,
          relation: true,
          source_type: 'schema:Book',
          source_order_key: '',
          outbound_order: 'name',
          source_revision: ordinal + 2,
          source_security_revision: 0,
          target_revision: 0,
          target_type: 'schema:Person',
          external: null,
          value: 'value',
          present: true,
          recorded_transaction_id: relationTransaction,
        })),
      };
    },
    finish: async (admin, range) => {
      await admin.query(
        `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
         SELECT $1,$2,'schema:author',filter_value,$4 FROM unnest($3::uuid[]) filter_value
         ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
        [anchorRoute, anchor, [NIL, role, arc], range.to],
      );
      if (range.to > range.from)
        await admin.query('UPDATE semantic.partition_subjects SET visible=visible+$2 WHERE partition_no=$1', [
          partitionOf(anchorRoute),
          range.to - range.from,
        ]);
    },
  };
  return current;
}

// Separate subjects keep the matching anchor's 64/512/4096 degrees intact. Each has two descriptive
// history rows, one compact relation and two matching provenance/framework envelopes.
function historyPopulation(): Population {
  return {
    name: 'semantic-relation-neighbours',
    hotPartition: partitionOf(BASE_ROUTE),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const id = newId(BASE_ROUTE);
      const transactions = [randomUUID(), randomUUID()];
      const facts = rowsFor(
        id,
        {
          labels: { en: `Neighbour ${ordinal}` },
          statements: { 'schema:author': [statement(id)] },
        },
        bundledRelease,
      );
      const label = facts.find((fact) => fact.kind === 'label')!;
      const relation = facts.find((fact) => fact.kind === 'statement')!;
      const envelopes = transactions.map((transaction_id, index) => ({
        partition_no: partitionOf(BASE_ROUTE),
        epoch: 1,
        position: 2 + 2 * ordinal + index,
        transaction_id,
        principal_kind: 'account',
        principal_id: actor.accountId,
      }));
      return {
        'semantic.subject': [
          {
            route: BASE_ROUTE,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transactions[0],
            current_facts: 1,
            current_release: bundledDigest,
          },
        ],
        'semantic.revision': transactions.map((recorded_transaction_id, index) => ({
          route: BASE_ROUTE,
          subject_id: id,
          revision: index + 1,
          kind: index === 0 ? 'create' : 'adopt',
          release: bundledDigest,
          recorded_transaction_id,
        })),
        'semantic.fact': [
          ...transactions.map((recorded_transaction_id, index) => ({
            ...label,
            route: BASE_ROUTE,
            subject_id: id,
            log_seq: index + 1,
            recorded_transaction_id,
            release: null,
            relation: false,
          })),
          {
            ...relation,
            route: BASE_ROUTE,
            subject_id: id,
            recorded_transaction_id: transactions[1],
            release: bundledDigest,
            relation: true,
          },
        ],
        'semantic.outbound_link': [NIL, role, arc].map((filter_value) => ({
          route: BASE_ROUTE,
          subject_id: id,
          property: 'schema:author',
          filter_value,
          order_key: labelOrderKey({ en: `Neighbour ${ordinal}` }),
          target_subject_id: id,
          statement_id: relation.statement_id,
          slot_id: relation.slot_id,
          relation: true,
          source_type: 'schema:Book',
          source_order_key: '',
          outbound_order: 'name',
          source_revision: 2,
          target_type: 'schema:Book',
          target_revision: 2,
          value: 'value',
          present: true,
          recorded_transaction_id: transactions[1],
        })),
        'semantic.outbound_link_count': [NIL, role, arc].map((filter_value) => ({
          route: BASE_ROUTE,
          subject_id: id,
          property: 'schema:author',
          filter_value,
          value: 1,
        })),
        'core.receipt': envelopes.map((envelope, index) => ({
          ...envelope,
          command_kind: index === 0 ? 'subject.create' : 'subject.adopt',
          idempotency_key: randomUUID(),
          request_digest: digest,
          response: { id, revision: index + 1 },
        })),
        'core.outbox': envelopes.map(({ partition_no, epoch, position }, index) => ({
          partition_no,
          epoch,
          position,
          event_seq: 0,
          event_count: 1,
          id: newId(BASE_ROUTE),
          type: 'com.rezics.subject.revised.v1',
          subject: id,
          data: { id, revision: index + 1, kind: index === 0 ? 'create' : 'adopt' },
        })),
        'editorial.write_basis': envelopes.map((envelope) => ({
          ...envelope,
          client_id: actor.clientId,
          requested_by: null,
        })),
      };
    },
    finish: async (admin, range) => {
      // These fixture projections are already materialized; keep their source position and checkpoint coherent.
      const position = 2 * range.to + 1;
      await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
        partitionOf(BASE_ROUTE),
        position,
      ]);
      await admin.query(
        `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
        VALUES ($1,'semantic_links',1,$2) ON CONFLICT (partition_no,consumer)
        DO UPDATE SET epoch=1,position=EXCLUDED.position`,
        [partitionOf(BASE_ROUTE), position],
      );
      await admin.query('UPDATE semantic.partition_subjects SET visible=visible+$2 WHERE partition_no=$1', [
        partitionOf(BASE_ROUTE),
        range.to - range.from,
      ]);
    },
  };
}

async function grow(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await growRelationHistory(database, historyPopulation(), scale, previous);
  await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
  const sizes = await readRelationGrowthCardinalities(database);
  // The history preload must grow indexed neighbours without changing F or any matching filter degree.
  const degrees = await database.admin.query<{ filter: string; n: string }>(
    `SELECT filter_value::text AS filter, count(*)::text AS n FROM semantic.outbound_link
     WHERE route=$1 AND subject_id=$2 AND context_id=$3 AND property='schema:author' AND present
     GROUP BY filter_value ORDER BY filter_value`,
    [anchorRoute, anchor, GLOBAL_CONTEXT],
  );
  expect(degrees.rows.map((row) => row.filter).sort()).toEqual([NIL, role, arc].sort());
  for (const row of degrees.rows) expect(Number(row.n)).toBe(scale);
  const descriptive = await database.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM semantic.fact
     WHERE route=$1 AND subject_id=$2 AND kind <> 'statement'`,
    [anchorRoute, anchor],
  );
  expect(Number(descriptive.rows[0]!.n)).toBe(DESCRIPTIVE_FACTS);
  cardinalities[scale] = sizes;
  console.info('Actual indexed cardinalities', {
    scale,
    matchingDegrees: degrees.rows,
    descriptiveFacts: Number(descriptive.rows[0]!.n),
    relationProperties: relationProperties.length,
    preview: PREVIEW,
    pageSize: PAGE_SIZE,
    related: 1 + PAGE_SIZE,
    sizes,
  });
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const record = value as Record<string, unknown>;
  return [...(typeof record['Node Type'] === 'string' ? [record] : []), ...Object.values(record).flatMap(nodes)];
}

function examined(node: Record<string, unknown>): number {
  return (
    (Number(node['Actual Rows'] ?? 0) +
      Number(node['Rows Removed by Filter'] ?? 0) +
      Number(node['Rows Removed by Index Recheck'] ?? 0)) *
    Number(node['Actual Loops'] ?? 0)
  );
}

function assertPlans(raw: Capture, scale: number): void {
  // Keep raw native evidence before assertions: a query failure belongs to its owner, not a weaker test.
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    `${evidenceDirectory}/plans-${scale}.json`,
    JSON.stringify({ cardinalities: cardinalities[scale], raw }),
  );
  const initial = raw.plans.find((plan) => JSON.stringify(plan).includes('AS fact_revision'));
  expect(initial).toBeDefined();
  const initialStatement = raw.statements.findIndex((text) => text.includes('AS fact_revision'));
  expect(initialStatement).toBeGreaterThanOrEqual(0);
  const begin = raw.statements.slice(0, initialStatement).findLastIndex((text) => /^BEGIN/.test(text));
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(raw.statements.slice(begin, initialStatement).some((text) => text.includes('enable_seqscan'))).toBe(false);
  expect(raw.statements.slice(initialStatement + 1).some((text) => text.includes('enable_seqscan'))).toBe(true);
  function requireIndex(plans: unknown, index: string, keys: string[], bound: number): void {
    const matching = nodes(plans).filter((node) => node['Index Name'] === index && Number(node['Actual Loops']) > 0);
    expect(matching.length).toBeGreaterThan(0);
    for (const node of matching) {
      for (const key of keys) expect(String(node['Index Cond'])).toContain(key);
      expect(examined(node)).toBeLessThanOrEqual(bound);
    }
  }
  requireIndex(initial, 'subject_pkey', ['route', 'subject_id'], 1);
  requireIndex(initial, 'fact_terms', ['route', 'subject_id'], DESCRIPTIVE_FACTS);
  requireIndex(initial, 'revision_pkey', ['route', 'subject_id'], 1);
  requireIndex(initial, 'revision_transaction', ['recorded_transaction_id', 'route', 'subject_id'], 1);
  const all = nodes(raw.plans);
  for (const node of all) {
    if (
      [
        'subject',
        'fact',
        'revision',
        'outbound_link',
        'outbound_link_count',
        'receipt',
        'outbox',
        'write_basis',
      ].includes(String(node['Relation Name'])) &&
      Number(node['Actual Loops']) > 0
    )
      expect(node['Node Type']).not.toBe('Seq Scan');
  }
  // Summaries preserve label retractions, so the source predicate uses fact_terms rather than the assert-only
  // fact_label partial index. Require the keyed source access and bound its examined rows.
  const summaries = raw.plans.filter((plan) => JSON.stringify(plan).includes('AS latest WHERE operation'));
  expect(summaries).toHaveLength(2);
  for (const [index, plan] of summaries.entries()) {
    const subjects = index === 0 ? 1 : PAGE_SIZE;
    requireIndex(plan, 'subject_pkey', ['route', 'subject_id'], subjects);
    requireIndex(plan, 'fact_terms', ['route', 'subject_id'], subjects);
  }
  const ranges = raw.plans.filter(
    (plan) => JSON.stringify(plan).includes('r_after_order') && JSON.stringify(plan).includes('sort_statement'),
  );
  expect(ranges).toHaveLength(relationProperties.length + 1);
  for (const [index, plan] of ranges.entries()) {
    const limit = index < relationProperties.length ? PREVIEW + 1 : PAGE_SIZE + 1;
    requireIndex(
      plan,
      'outbound_link_present',
      [
        'route',
        'subject_id',
        'context_id',
        'property',
        'filter_value',
        'order_key',
        'target_subject_id',
        'statement_id',
      ],
      limit,
    );
    for (const node of nodes(plan).filter((node) => node['Relation Name'] === 'outbound_link'))
      expect(examined(node)).toBeLessThanOrEqual(limit);
  }
  requireIndex(raw.plans, 'outbound_link_count_pkey', ['route', 'subject_id', 'property', 'filter_value'], 1);
  console.info(
    'Native index plans',
    JSON.stringify({
      scale,
      indexes: all
        .filter((node) => node['Index Name'])
        .map((node) => ({ index: node['Index Name'], condition: node['Index Cond'], examined: examined(node) })),
    }),
  );
}

function middleCursor(size: number): string {
  const after = Math.floor(size / 2) - 1;
  const key = labelOrderKey({ en: `Author ${String(after).padStart(4, '0')}` });
  const target = people[after]!;
  const statementId = relationFacts[after]!.statement_id!;
  return encodeCursor(
    tokenRing,
    {
      operation: 'subject.relations',
      parameters: {
        subject: anchor,
        property: 'schema:author',
        context: GLOBAL_CONTEXT,
        filter: arc,
        type: null,
        language: null,
      },
    },
    { epoch: 1, after: [key, target, statementId] },
  );
}

async function actualHead(database: GrowthDatabase): Promise<SessionComponent> {
  const result = await database.admin.query<{ partition_no: number; epoch: number; position: string }>(
    'SELECT partition_no, epoch, position FROM core.partition WHERE partition_no = $1',
    [partitionOf(anchorRoute)],
  );
  const head = result.rows[0];
  if (!head) throw new Error('Growth partition disappeared');
  return { partition: head.partition_no, epoch: head.epoch, position: BigInt(head.position) };
}

async function setCheckpoint(database: GrowthDatabase, position: bigint): Promise<void> {
  const head = await actualHead(database);
  await database.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     VALUES ($1, 'semantic_links', $2, $3)
     ON CONFLICT (partition_no, consumer) DO UPDATE
     SET epoch = EXCLUDED.epoch, position = EXCLUDED.position, updated_at = now()`,
    [head.partition, head.epoch, position],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
  await activeRelease(db.pool);
  anchor = newId(BASE_ROUTE);
  anchorRoute = routeOf(anchor)!;
  await createSubject(db.pool, {
    actor,
    target: { route: anchorRoute, id: anchor },
    idempotencyKey: randomUUID(),
    digest,
    item: { type: 'schema:Book', labels: { en: 'Relation growth anchor' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  people = Array.from({ length: 4_096 }, () => newId(anchorRoute));
  peopleLabels = people.map((id, index) => rowsFor(id, { labels: { en: `Author ${String(index).padStart(4, '0')}` } }));
  relationFacts = people.map((id) =>
    rowsFor(
      anchor,
      { labels: { en: 'Relation growth anchor' }, statements: { 'schema:author': [statement(id)] } },
      bundledRelease,
    ).find((fact) => fact.kind === 'statement')!,
  );
  population = createPopulation();
}, 60_000);

afterAll(async () => {
  if (db) await db.close();
});

test('A subject read examines the same rows whatever the number of relations it holds under series with derived logarithmic blocks indexProbes and production-shaped initial access', async () => {
  const report = await checkGrowth(db, {
    name: 'A subject read examines the same rows whatever the number of relations it holds',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 5,
    includeBackends: true,
    rule: 'series',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    indexProbes,
    warmup: async (database, scale) => {
      const measured = await capture(database, () => operation(database, scale), { includeBackends: true });
      try {
        assertPlans(measured.capture, scale);
      } catch (error) {
        // Remote check workspaces are disposable; preserve the owner's raw failure in the returned log too.
        console.error('Native relation-growth plan failure', JSON.stringify({ scale, raw: measured.capture }));
        throw error;
      }
    },
    grow,
    operation,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    `${evidenceDirectory}/report.json`,
    JSON.stringify({ indexProbes, probeOperands, cardinalities, report }),
  );
  console.info(
    'Growth repetitions and actual N',
    JSON.stringify({
      indexProbes,
      probeOperands,
      cardinalities,
      samples: report.samples.map(({ scale, repetitions }) => ({ scale, repetitions })),
    }),
  );
});

async function operation(database: GrowthDatabase, scale: number) {
  // These fixture callbacks isolate source cost; native Auth/API discovery has separate acceptance.
  const pageCursor = middleCursor(scale);
  const subject = await readSubject(database.pool, anchor, async () => true, GLOBAL_CONTEXT);
  if (!subject) throw new Error('Growth anchor disappeared');
  const page = await listSubjectRelations(database.pool, tokenRing, {
    subject: anchor,
    property: 'schema:author',
    context: GLOBAL_CONTEXT,
    filter: arc,
    limit: PAGE_SIZE,
    cursor: pageCursor,
    release: bundledRelease,
    authorize: async () => true,
    seen: [],
    caughtUp: true,
  });
  if (subject.subject.statements['schema:author']?.length !== PREVIEW)
    throw new Error(`Expected a 12 statement preview at ${scale}`);
  if (subject.subject.relationCounts['schema:author'] !== scale)
    throw new Error(`Expected ${scale} relation count, got ${subject.subject.relationCounts['schema:author']}`);
  if (page.relations.length !== PAGE_SIZE || page.count.value !== scale || !page.count.exact)
    throw new Error(`Expected a 25 statement middle page at ${scale}`);
  expect(subject.subject.labels).toEqual({ en: 'Relation growth anchor' });
  expect(subject.subject.statements['schema:author']!.map((entry) => entry.value)).toEqual(
    people.slice(0, PREVIEW).map((content) => ({ type: 'value', content })),
  );
  const start = Math.floor(scale / 2);
  expect(page.relations.map((entry) => entry.target)).toEqual(people.slice(start, start + PAGE_SIZE));
  for (const entry of page.relations) {
    expect(entry.statement.qualifiers.map((qualifier) => qualifier.value)).toEqual([
      { type: 'value', content: role },
      { type: 'value', content: arc },
    ]);
  }
  expect(page.next).not.toBeNull();
  return { subject: subject.subject, page };
}

test('a genuinely waiting link freshness probe has constant work per poll across relation growth', async () => {
  anchor = newId(BASE_ROUTE);
  anchorRoute = routeOf(anchor)!;
  await createSubject(db.pool, {
    actor,
    target: { route: anchorRoute, id: anchor },
    idempotencyKey: randomUUID(),
    digest,
    item: { type: 'schema:Book', labels: { en: 'Waiting relation growth anchor' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  people = Array.from({ length: 4_096 }, () => newId(anchorRoute));
  peopleLabels = people.map((id, index) => rowsFor(id, { labels: { en: `Author ${String(index).padStart(4, '0')}` } }));
  relationFacts = people.map((id) =>
    rowsFor(
      anchor,
      { labels: { en: 'Waiting relation growth anchor' }, statements: { 'schema:author': [statement(id)] } },
      bundledRelease,
    ).find((fact) => fact.kind === 'statement')!,
  );
  population = createPopulation();
  growthHead = await actualHead(db);

  const waitBudget = FRESHNESS_WAIT_MS;
  const holdBehind = async (database: GrowthDatabase) => {
    const head = await actualHead(database);
    growthHead = head;
    if (head.position <= 0n) throw new Error('Waiting probe requires a nonzero actual partition head');
    await setCheckpoint(database, head.position - 1n);
  };
  const waitBehind = async (database: GrowthDatabase): Promise<boolean> => {
    const head = growthHead;
    if (!head) throw new Error('Growth partition head was not prepared');
    return waitForSubjectLinks(database.pool, [head], anchor, Date.now() + waitBudget * 2);
  };
  const report = await checkGrowth(db, {
    name: 'A genuinely waiting link freshness probe has constant work per poll across relation growth',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 5,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    slack: {
      rows: { absolute: 2, relative: 0.1 },
      blocks: { absolute: 4, relative: 0.5 },
      statements: { absolute: 0, relative: 0 },
    },
    grow,
    warmup: async (database) => {
      await holdBehind(database);
      if (await waitBehind(database)) throw new Error('The held semantic_links checkpoint unexpectedly caught up');
    },
    prepare: holdBehind,
    operation: async (database) => {
      const caughtUp = await waitBehind(database);
      if (caughtUp) throw new Error('The held semantic_links checkpoint unexpectedly caught up');
      return caughtUp;
    },
  });

  const perPollStatements: number[] = [];
  for (const sample of report.samples) {
    for (const run of sample.occurrenceRepetitions) {
      const polls = run.statements.filter(({ statement }) =>
        statement.includes('FROM core.consumer_checkpoint'),
      ).length;
      const statements = run.statements.length;
      expect(polls).toBeGreaterThan(0);
      expect(polls).toBeLessThanOrEqual(Math.ceil(waitBudget / FRESHNESS_POLL_MS) + 1);
      expect(statements % polls).toBe(0);
      perPollStatements.push(statements / polls);
    }
  }
  expect(new Set(perPollStatements).size).toBe(1);
});
