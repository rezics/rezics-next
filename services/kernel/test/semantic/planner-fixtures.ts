import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { itemFacts } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { newId } from '../../src/route/route.ts';
import {
  capture,
  costOf,
  seed,
  type Capture,
  type GrowthDatabase,
  type GrowthReport,
  type SeedRange,
  type SeedTarget,
} from '../support/growth.ts';
import type { Population } from '../support/growth.ts';

type PlanNode = Record<string, unknown>;
type IndexRequirement = Readonly<Record<string, string | readonly string[]>>;

const NIL = '00000000-0000-0000-0000-000000000000';

export function unrelatedSemanticPopulation(
  name: string,
  hotPartition: number,
): {
  readonly target: string;
  readonly population: Population;
} {
  const baseRoute = hotPartition * 16;
  const target = newId(baseRoute);
  const filters = [NIL];
  return {
    target,
    population: {
      name,
      hotPartition,
      hotShare: 1,
      rows: ({ ordinal, route }) => {
        const source = newId(route);
        const transaction = randomUUID();
        const label = `Unrelated ${name} ${String(ordinal).padStart(7, '0')}`;
        const facts = itemFacts(
          source,
          {
            labels: { en: label },
            statements: {
              'schema:author': [
                {
                  property: { id: 'schema:author' },
                  value: { type: 'value', content: target },
                  qualifiers: [],
                  references: [],
                },
              ],
            },
          },
          'schema:Book',
          bundledRelease,
        );
        const relation = facts.find((fact) => fact.kind === 'statement')!;
        const orderKey = labelOrderKey({ en: label });
        const rows: Record<string, readonly Record<string, unknown>[]> = {
          'semantic.subject': [
            {
              route,
              subject_id: source,
              type: 'schema:Book',
              recorded_transaction_id: transaction,
              visibility: 'visible',
              security_revision: 0,
              current_facts: facts.length,
              current_release: bundledDigest,
              projection_pending: false,
            },
          ],
          'semantic.revision': [
            {
              route,
              subject_id: source,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          'semantic.fact': facts.map((fact) => ({
            ...fact,
            route,
            subject_id: source,
            recorded_transaction_id: transaction,
            release: fact.kind === 'statement' ? bundledDigest : null,
            relation: fact.kind === 'statement',
          })),
          'semantic.outbound_link': filters.map((filter_value) => ({
            route,
            subject_id: source,
            property: 'schema:author',
            filter_value,
            order_key: orderKey,
            target_subject_id: target,
            statement_id: relation.statement_id,
            slot_id: relation.slot_id,
            relation: true,
            source_type: 'schema:Book',
            source_order_key: orderKey,
            outbound_order: 'name',
            source_revision: 1,
            source_security_revision: 0,
            target_revision: 1,
            target_type: 'schema:Person',
            external: null,
            value: 'value',
            present: true,
            recorded_transaction_id: transaction,
          })),
          'semantic.inbound_link': filters.map((filter_value) => ({
            route: baseRoute,
            subject_id: target,
            property: 'schema:author',
            source_subject_id: source,
            statement_id: relation.statement_id,
            source_revision: 1,
            source_security_revision: 0,
            present: true,
            recorded_transaction_id: transaction,
            source_type: 'schema:Book',
            order_key: orderKey,
            filter_value,
          })),
          'semantic.outbound_link_count': filters.map((filter_value) => ({
            route,
            subject_id: source,
            property: 'schema:author',
            filter_value,
            value: 1,
          })),
        };
        if (ordinal === 0) {
          const targetTransaction = randomUUID();
          const targetFacts = itemFacts(target, { labels: { en: `Unrelated target ${name}` } });
          rows['semantic.subject'] = [
            ...rows['semantic.subject']!,
            {
              route: baseRoute,
              subject_id: target,
              type: 'schema:Person',
              recorded_transaction_id: targetTransaction,
              visibility: 'visible',
              security_revision: 0,
              current_facts: targetFacts.length,
              current_release: bundledDigest,
              projection_pending: false,
            },
          ];
          rows['semantic.revision'] = [
            ...rows['semantic.revision']!,
            {
              route: baseRoute,
              subject_id: target,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: targetTransaction,
            },
          ];
          rows['semantic.fact'] = [
            ...rows['semantic.fact']!,
            ...targetFacts.map((fact) => ({
              ...fact,
              route: baseRoute,
              subject_id: target,
              recorded_transaction_id: targetTransaction,
              release: null,
              relation: false,
            })),
          ];
        }
        return rows;
      },
      finish: async (admin, range) => {
        await admin.query(
          `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
           VALUES($1,$2,'schema:author',$3,$4)
           ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
          [baseRoute, target, NIL, range.to],
        );
        await admin.query(
          `INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES($1,$2)
           ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+EXCLUDED.visible`,
          [hotPartition, range.to - range.from + (range.from === 0 && range.to > 0 ? 1 : 0)],
        );
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entries(raw: Capture): { query: string; root: PlanNode }[] {
  const result: { query: string; root: PlanNode }[] = [];
  for (const document of raw.plans) {
    const plans = Array.isArray(document) ? document : [document];
    for (const entry of plans) {
      if (!isRecord(entry) || !isRecord(entry.Plan)) continue;
      result.push({
        query: typeof entry['Query Text'] === 'string' ? entry['Query Text'] : '<unknown>',
        root: entry.Plan,
      });
    }
  }
  return result;
}

function indexNames(raw: Capture): Readonly<Record<string, readonly string[]>> {
  const found = new Map<string, Set<string>>();
  const visit = (node: PlanNode, relation?: string): void => {
    const schema = node.Schema;
    const name = node['Relation Name'];
    const current = typeof name === 'string' ? `${typeof schema === 'string' ? schema : 'public'}.${name}` : relation;
    const index = node['Index Name'];
    if (current && typeof index === 'string') {
      const names = found.get(current) ?? new Set<string>();
      names.add(index);
      found.set(current, names);
    }
    if (Array.isArray(node.Plans)) for (const child of node.Plans) if (isRecord(child)) visit(child, current);
  };
  for (const { root } of entries(raw)) visit(root);
  return Object.fromEntries([...found].map(([relation, names]) => [relation, [...names].sort()]));
}

function sequentialScans(raw: Capture): readonly Record<string, unknown>[] {
  const scans: Record<string, unknown>[] = [];
  const visit = (node: PlanNode): void => {
    if (node['Node Type'] === 'Seq Scan') {
      const keys = [
        'Schema',
        'Relation Name',
        'Actual Rows',
        'Actual Loops',
        'Rows Removed by Filter',
        'Shared Hit Blocks',
        'Shared Read Blocks',
      ];
      scans.push(Object.fromEntries(keys.flatMap((key) => (key in node ? [[key, node[key]]] : []))));
    }
    if (Array.isArray(node.Plans)) for (const child of node.Plans) if (isRecord(child)) visit(child);
  };
  for (const { root } of entries(raw)) visit(root);
  return scans;
}

export function assertUnforcedIndexes(name: string, scale: number, raw: Capture, required: IndexRequirement): void {
  const plannerSettings = [...raw.statements, ...(raw.backgroundStatements ?? [])].filter((statement) =>
    /\benable_[a-z_]+\b|\bset_config\s*\(/i.test(statement),
  );
  const indexes = indexNames(raw);
  const scans = sequentialScans(raw);
  const missing = Object.entries(required).flatMap(([relation, wanted]) => {
    const choices = typeof wanted === 'string' ? [wanted] : wanted;
    const actual = indexes[relation] ?? [];
    return choices.some((index) => actual.includes(index))
      ? []
      : [`${relation}: expected ${choices.join(' or ')}, got ${actual.join(', ') || '<none>'}`];
  });
  const cost = costOf(raw);
  console.info(
    `Unforced semantic plans ${JSON.stringify({ name, scale, plannerSettings, indexes, scans, rows: cost.rows, blocks: cost.blocks, statements: cost.statements, controlStatements: cost.controlStatements })}`,
  );
  // Keep complete covering and re-emission page plans even when remote runs do not forward dump flags.
  // Aggregate operation costs cannot identify a sort that consumes an entire ordered range before LIMIT.
  for (const entry of entries(raw)) {
    const reemit = /list-(?:outbound|inbound)-key-reemit\.sql/.test(entry.query);
    const mirror = name.endsWith('key re-emission') && /upsert-(?:outbound|inbound)-links\.sql/.test(entry.query);
    if (!reemit && !mirror && !/list-(?:outbound|inbound)-links-by-property\.sql/.test(entry.query)) continue;
    const source = costOf({ statements: [entry.query], plans: [{ 'Query Text': entry.query, Plan: entry.root }] });
    const kind = reemit ? 'key re-emission source' : mirror ? 'key re-emission mirror' : 'covering source';
    console.info(
      `Semantic ${kind} plan ${JSON.stringify({ name, scale, rows: source.rows, blocks: source.blocks, statements: source.statements, query: entry.query, plan: entry.root })}`,
    );
  }
  if (process.env.DUMP_SEMANTIC_PLANS === '1') {
    const visit = (
      node: PlanNode,
      path: string[],
      found: {
        path: string[];
        node: Readonly<Record<string, unknown>>;
      }[],
    ): void => {
      const schema = node.Schema;
      const relation = node['Relation Name'];
      const rows = node['Actual Rows'];
      const loops = node['Actual Loops'];
      if (
        schema === 'semantic' &&
        (relation === 'inbound_link' || relation === 'outbound_link') &&
        typeof rows === 'number' &&
        typeof loops === 'number' &&
        rows * loops >= 25
      ) {
        const keys = [
          'Node Type',
          'Relation Name',
          'Schema',
          'Index Name',
          'Actual Rows',
          'Actual Loops',
          'Plan Rows',
          'Rows Removed by Filter',
          'Rows Removed by Index Recheck',
          'Index Cond',
          'Filter',
          'Shared Hit Blocks',
          'Shared Read Blocks',
          'Shared Dirtied Blocks',
          'Shared Written Blocks',
          'Temp Read Blocks',
          'Temp Written Blocks',
        ];
        found.push({
          path: [...path, `${node['Node Type']} ${schema}.${relation}`],
          node: Object.fromEntries(keys.flatMap((key) => (key in node ? [[key, node[key]]] : []))),
        });
      }
      if (Array.isArray(node.Plans))
        for (const [index, child] of node.Plans.entries())
          if (isRecord(child)) visit(child, [...path, `${node['Node Type']}[${index}]`], found);
    };
    for (const entry of entries(raw)) {
      const observed: { path: string[]; node: Readonly<Record<string, unknown>> }[] = [];
      visit(entry.root, [], observed);
      if (observed.length) {
        console.info(`UNFORCED_RAW_PLAN ${JSON.stringify({ name, scale, statement: entry.query, observed })}`);
        const directory = resolve(process.cwd(), '../..', '.temp');
        mkdirSync(directory, { recursive: true });
        appendFileSync(
          resolve(directory, 'semantic-unforced-plans.jsonl'),
          `${JSON.stringify({ name, scale, statement: entry.query, plan: entry.root })}\n`,
        );
      }
    }
  }
  expect(plannerSettings, `${name} at ${scale} used planner method settings`).toEqual([]);
  expect(missing, `${name} at ${scale} missed intended indexes`).toEqual([]);
}

export async function captureUnforcedIndexes<T>(
  db: GrowthDatabase,
  name: string,
  scale: number,
  operation: () => Promise<T>,
  required: IndexRequirement,
): Promise<T> {
  const measured = await capture(db, async () => {
    try {
      return { ok: true as const, value: await operation() };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (!measured.value.ok) {
    // Preserve native failures together with every pool's completed physical work, including HTTP deadline paths.
    console.info(
      `Semantic failed operation capture ${JSON.stringify({ name, scale, cost: costOf(measured.capture), capture: measured.capture })}`,
    );
    throw measured.value.error;
  }
  assertUnforcedIndexes(name, scale, measured.capture, required);
  return measured.value.value;
}

export function logGrowthSeeding(report: Pick<GrowthReport, 'name' | 'samples'>): void {
  console.info(
    `Semantic growth report ${JSON.stringify({
      name: report.name,
      samples: report.samples.map(({ scale, cost, repetitions, relationSizes, seeding }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        repetitions: repetitions.map(({ rows, blocks, statements }) => ({ rows, blocks, statements })),
        relationSizes,
        seeding,
      })),
    })}`,
  );
}

export async function seedSemanticPopulation(
  target: SeedTarget,
  population: Population,
  range: SeedRange,
): Promise<void> {
  const started = performance.now();
  await seed(target, population, range);
  console.info(
    `Semantic population seed ${JSON.stringify({
      name: population.name,
      hotPartition: population.hotPartition,
      from: range.from,
      to: range.to,
      ordinals: range.to - range.from,
      elapsedMs: performance.now() - started,
    })}`,
  );
}
