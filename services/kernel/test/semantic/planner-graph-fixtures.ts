import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { itemFacts } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
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
  otherPartitions: readonly number[] = [],
): {
  readonly target: string;
  readonly population: Population;
} {
  const partitions = [hotPartition, ...otherPartitions];
  const baseRoute = hotPartition * 16;
  const target = newId(baseRoute);
  const targetOrder = labelOrderKey({ en: `Unrelated target ${name}` });
  const filters = [NIL];
  return {
    target,
    population: {
      name,
      hotPartition,
      hotShare: 1,
      rows: ({ ordinal, route: placedRoute }) => {
        const route = partitions[ordinal % partitions.length]! * 16 + (placedRoute % 16);
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
            context_id: GLOBAL_CONTEXT,
            route,
            subject_id: source,
            property: 'schema:author',
            filter_value,
            order_key: targetOrder,
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
            context_id: GLOBAL_CONTEXT,
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
            context_id: GLOBAL_CONTEXT,
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
          `INSERT INTO semantic.inbound_link_count(route,subject_id,context_id,property,filter_value,value)
           VALUES($1,$2,$5,'schema:author',$3,$4)
           ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
          [baseRoute, target, NIL, range.to, GLOBAL_CONTEXT],
        );
        for (const [index, partition] of partitions.entries()) {
          const count = (end: number) => Math.floor((end + partitions.length - 1 - index) / partitions.length);
          await admin.query(
            `INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES($1,$2)
             ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+EXCLUDED.visible`,
            [
              partition,
              count(range.to) - count(range.from) + (index === 0 && range.from === 0 && range.to > 0 ? 1 : 0),
            ],
          );
        }
      },
    },
  };
}

export function unrelatedMediaPopulation(
  name: string,
  hotPartition: number,
  uploader: string,
  metadata: Pick<MediaImportRequest, 'credit' | 'provenance'>,
): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows: ({ route }) => {
      const media = newId(route);
      const transaction = randomUUID();
      return {
        'content.media': [
          {
            route,
            media_id: media,
            container_id: newId(route),
            uploader_id: uploader,
            reservation_request_id: media,
            purpose: 'cover',
            media_type: 'image/jpeg',
            byte_count: 256,
            actual_byte_count: 256,
            sha256: 'a'.repeat(64),
            state: 'available',
            key: `m/${media}/original`,
            transaction_id: transaction,
            source_url: 'https://images.example.test/cover.jpg',
            ...metadata,
            width: 1200,
            height: 1800,
            thumbhash: new Uint8Array([1, 2, 3]),
            average_color: '#5a4632',
          },
        ],
        'content.media_variant': ['avif', 'webp'].map((format) => ({
          route,
          media_id: media,
          format,
          width: 320,
          height: 533,
          media_type: `image/${format}`,
          byte_count: 1,
          sha256: 'c'.repeat(64),
          key: `m/${media}/${format}-320`,
          transaction_id: transaction,
        })),
      };
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

export function assertUnforcedIndexes(name: string, scale: number, raw: Capture, required: IndexRequirement): void {
  const plannerSettings = [...raw.statements, ...(raw.backgroundStatements ?? [])].filter((statement) =>
    /\benable_[a-z_]+\b|\bset_config\s*\(/i.test(statement),
  );
  const indexes = indexNames(raw);
  const missing = Object.entries(required).flatMap(([relation, wanted]) => {
    const choices = typeof wanted === 'string' ? [wanted] : wanted;
    const actual = indexes[relation] ?? [];
    return choices.some((index) => actual.includes(index))
      ? []
      : [`${relation}: expected ${choices.join(' or ')}, got ${actual.join(', ') || '<none>'}`];
  });
  const cost = costOf(raw);
  console.info(
    `Unforced semantic plans ${JSON.stringify({ name, scale, plannerSettings, indexes, rows: cost.rows, blocks: cost.blocks, statements: cost.statements, controlStatements: cost.controlStatements, relations: cost.relations })}`,
  );
  // Keep all statements and plans together: a failing growth bound needs every scale's evidence.
  console.info(`UNFORCED_RAW_PLANS ${JSON.stringify({ name, scale, ...raw })}`);
  if (process.env.DUMP_SEMANTIC_PLANS === '1') {
    const directory = resolve(process.cwd(), '../..', '.temp');
    mkdirSync(directory, { recursive: true });
    appendFileSync(resolve(directory, 'semantic-unforced-plans.jsonl'), `${JSON.stringify({ name, scale, ...raw })}\n`);
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
  const measured = await capture(db, operation);
  assertUnforcedIndexes(name, scale, measured.capture, required);
  return measured.value;
}

export function logGrowthSeeding(report: Pick<GrowthReport, 'name' | 'samples'>): void {
  console.info(
    `Semantic growth seeding ${JSON.stringify({
      name: report.name,
      samples: report.samples.map(({ scale, cost, seeding }) => ({ scale, cost, ...seeding })),
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
