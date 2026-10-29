import type { Release } from '@rezics/definitions';
import { readRelease } from './definitions.ts';
import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { withoutFencedEntries } from './fences.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import type { IndexedStatement, IndexedSubject, SubjectSnapshot, SubjectSource } from '../search/source.ts';
import count from './search-source-count.sql';
import readAdoptions from './search-source-adoptions.sql';
import readFacts from './search-source-facts.sql';
import readReleases from './search-source-releases.sql';
import readPosition from './search-source-position.sql';
import readStatements from './search-source-statements.sql';
import readSubjects from './search-source-subjects.sql';

type SubjectRow = {
  route: number;
  id: string;
  type: string;
  visibility: IndexedSubject['visibility'];
  securityRevision: string;
  currentRelease: string | null;
  redirect: string | null;
};
type FactRow = {
  entry_kind: 'term' | 'compact' | 'expanded';
  route: number;
  id: string;
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract' | 'expand';
  kind: 'label' | 'description' | 'alias' | 'statement';
  language: string | null;
  property: string | null;
  candidate_id: string | null;
  body: unknown;
  release: string | null;
};
type AdoptionRow = {
  route: number;
  subject_id: string;
  slot_id: string;
  mode: 'inherit' | 'replace' | 'suppress' | null;
  selection: unknown;
};
type StatementEntry = {
  source: 'compact' | 'expanded';
  route: number;
  subject_id: string;
  slot_id: string;
  property: string;
  candidate_id: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  body?: unknown;
  release?: string;
};
type StatementRow = {
  subject_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  body: unknown;
  release: string;
  ordinal: number;
};

const ASCII = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertPartition(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new TypeError('Partition must be an integer from 0 through 4095');
}

function valueText(body: unknown, definition: Release['properties'][string] | undefined): string | null {
  if (!object(body) || !object(body.value)) return null;
  const value = body.value;
  if (value.type !== 'value' || !object(value.content)) {
    if (value.type !== 'value' || typeof value.content !== 'string') return null;
    return value.content;
  }
  const content = value.content;
  switch (definition?.datatype) {
    case 'time':
      return typeof content.time === 'string' ? content.time : null;
    case 'quantity':
      return typeof content.amount === 'string' ? content.amount : null;
    case 'monolingualtext':
      return typeof content.text === 'string' ? content.text : null;
    default:
      return null;
  }
}

function timeYear(time: string): number | null {
  const match = /^([+-])(\d+)-/.exec(time);
  if (!match) return null;
  const year = Number(`${match[1]}${match[2]}`);
  return Number.isSafeInteger(year) ? year : null;
}

function indexedStatement(row: StatementRow, release: Release): IndexedStatement | null {
  const body = row.body;
  if (!object(body)) return null;
  const definition = release.properties[row.property];
  const value = valueText(body, definition);
  if (value === null) return null;

  const statement: IndexedStatement = { property: row.property, value };
  if (definition?.datatype === 'wikibase-item') statement.facet = { kind: 'item' };
  else if (definition?.datatype === 'time') {
    const content = object(body.value) && object(body.value.content) ? body.value.content : undefined;
    const year = content && typeof content.time === 'string' ? timeYear(content.time) : null;
    if (year !== null) statement.facet = { kind: 'time', year };
  } else if (definition?.datatype === 'quantity') {
    const content = object(body.value) && object(body.value.content) ? body.value.content : undefined;
    const amount = content && typeof content.amount === 'string' ? Number(content.amount) : NaN;
    if (Number.isFinite(amount) && content && typeof content.unit === 'string')
      statement.facet = { kind: 'quantity', amount, unit: content.unit };
  } else if (
    definition?.datatype === 'string' &&
    object(definition.value) &&
    typeof definition.value.pattern === 'string'
  ) {
    statement.facet = { kind: 'code' };
  }

  if (Array.isArray(body.qualifiers)) {
    const qualifiers = body.qualifiers.flatMap((raw): { property: string; value: string }[] => {
      if (!object(raw) || typeof raw.property !== 'string' || !object(raw.value) || raw.value.type !== 'value')
        return [];
      const qualifierDefinition = release.properties[raw.property];
      const content = raw.value.content;
      return (qualifierDefinition?.datatype === 'wikibase-item' || qualifierDefinition?.datatype === 'string') &&
        typeof content === 'string'
        ? [{ property: raw.property, value: content }]
        : [];
    });
    if (qualifiers.length > 0) statement.qualifiers = qualifiers;
  }
  return statement;
}

function termValues(rows: FactRow[], kind: 'label' | 'description' | 'alias') {
  const current = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== kind || row.language === null || typeof row.body !== 'string') continue;
    if (kind === 'alias') {
      const values = aliases.get(row.language) ?? [];
      const index = values.indexOf(row.body);
      if (row.operation === 'retract') {
        if (index >= 0) values.splice(index, 1);
      } else if (index < 0) values.push(row.body);
      aliases.set(row.language, values);
    } else if (row.operation === 'retract') current.delete(row.language);
    else current.set(row.language, row.body);
  }
  if (kind === 'alias')
    return [...aliases].flatMap(([language, values]) => values.map((value) => ({ language, value })));
  return [...current].map(([language, value]) => ({ language, value }));
}

async function inSnapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

export function subjectSource(pool: Pool, routeKey?: Uint8Array): SubjectSource {
  return {
    async read(partition, ids): Promise<SubjectSnapshot> {
      assertPartition(partition);
      if (ids.length > 256) throw new TypeError('A subject snapshot accepts at most 256 ids');
      const requested = new Map<string, number>();
      for (const id of ids) {
        const route = routeOf(id);
        if (route === null || partitionOf(route) !== partition)
          throw new TypeError('Every subject id must route to the requested partition');
        if (!requested.has(id)) requested.set(id, route);
      }
      const pairs = [...requested].map(([id, route]) => ({ id, route }));

      return inSnapshot(pool, async (client) => {
        const positionRow = await readPosition.run(client, { partition_no: partition });
        const position = BigInt(positionRow?.position ?? '0');
        if (pairs.length === 0) return { partition, position, subjects: [] };

        const rows = (await readSubjects.run(client, {
          partition_no: partition,
          routes: pairs.map(({ route }) => route),
          subject_ids: pairs.map(({ id }) => id),
        })) as SubjectRow[];
        if (rows.length === 0) return { partition, position, subjects: [] };

        const found = new Map(rows.map((row) => [row.id, row]));
        const present = rows.map(({ id, route }) => ({ id, route }));
        const factRows = (await readFacts.run(client, {
          partition_no: partition,
          routes: present.map(({ route }) => route),
          subject_ids: present.map(({ id }) => id),
        })) as FactRow[];
        const expanded = factRows.filter((row) => row.entry_kind === 'expanded');
        const adoptions = expanded.length
          ? ((await readAdoptions.run(client, {
              partition_no: partition,
              routes: expanded.map(({ route }) => route),
              subject_ids: expanded.map(({ id }) => id),
              slot_ids: expanded.map(({ slot_id }) => slot_id),
            })) as AdoptionRow[])
          : [];

        const entries: StatementEntry[] = factRows.flatMap((row) => {
          if (row.entry_kind !== 'compact' || !row.candidate_id || !row.property || !row.release) return [];
          const body = object(row.body) ? row.body : {};
          const rank = body.rank;
          if (rank !== 'normal' && rank !== 'preferred') return [];
          return [
            {
              source: 'compact' as const,
              route: row.route,
              subject_id: row.id,
              slot_id: row.slot_id,
              property: row.property,
              candidate_id: row.candidate_id,
              rank,
              ordinal: row.log_seq,
              body: row.body,
              release: row.release,
            },
          ];
        });
        for (const adoption of adoptions) {
          if (adoption.mode !== 'replace' || !Array.isArray(adoption.selection)) continue;
          const slot = expanded.find(
            (row) => row.route === adoption.route && row.id === adoption.subject_id && row.slot_id === adoption.slot_id,
          );
          if (!slot || !slot.property) continue;
          for (const [index, selected] of adoption.selection.entries()) {
            if (
              !object(selected) ||
              typeof selected.candidate !== 'string' ||
              (selected.rank !== 'normal' && selected.rank !== 'preferred')
            )
              continue;
            entries.push({
              source: 'expanded',
              route: adoption.route,
              subject_id: adoption.subject_id,
              slot_id: adoption.slot_id,
              property: slot.property,
              candidate_id: selected.candidate,
              rank: selected.rank,
              ordinal: index + 1,
            });
          }
        }

        const visible = routeKey && entries.length ? await withoutFencedEntries(client, routeKey, entries) : entries;
        const statements = visible.length
          ? ((await readStatements.run(client, { partition_no: partition, entries: visible })) as StatementRow[])
          : [];
        const digests = new Set<string>();
        for (const row of rows) if (row.currentRelease) digests.add(row.currentRelease);
        for (const row of statements) digests.add(row.release);
        const releaseRows = digests.size
          ? ((await readReleases.run(client, { route: 0, digests: [...digests] })) as {
              digest: string;
              body: Release;
            }[])
          : [];
        const releases = new Map(releaseRows.map((row) => [row.digest, row.body]));
        // A statement of a Context's own relation type was written with a composed release.
        for (const digest of digests) {
          if (releases.has(digest)) continue;
          const composed = await readRelease(client, digest);
          if (composed) releases.set(digest, composed);
        }

        const termRows = new Map<string, FactRow[]>();
        for (const row of factRows) {
          if (row.entry_kind !== 'term') continue;
          const values = termRows.get(row.id) ?? [];
          values.push(row);
          termRows.set(row.id, values);
        }
        for (const values of termRows.values())
          values.sort((left, right) => ASCII(left.slot_id, right.slot_id) || left.log_seq - right.log_seq);
        const indexed = new Map<string, Map<string, { ordinal: number; statement: IndexedStatement }[]>>();
        for (const row of statements) {
          const release = releases.get(row.release);
          if (!release) throw new Error(`Statement definition release ${row.release} is missing`);
          const statement = indexedStatement(row, release);
          if (!statement) continue;
          const properties = indexed.get(row.subject_id) ?? new Map();
          const values = properties.get(row.property) ?? [];
          values.push({ ordinal: row.ordinal, statement });
          properties.set(row.property, values);
          indexed.set(row.subject_id, properties);
        }

        const subjects: IndexedSubject[] = [];
        for (const { id } of pairs) {
          const row = found.get(id);
          if (!row) continue;
          const facts = termRows.get(id) ?? [];
          const release = row.currentRelease ? releases.get(row.currentRelease) : undefined;
          const properties: Map<string, { ordinal: number; statement: IndexedStatement }[]> =
            indexed.get(id) ?? new Map();
          const order = release?.types[row.type]?.properties ?? [...properties.keys()].sort(ASCII);
          const orderedProperties = [
            ...order,
            ...[...properties.keys()].filter((name) => !order.includes(name)).sort(ASCII),
          ];
          const indexedStatements = orderedProperties.flatMap((property) =>
            (properties.get(property) ?? [])
              .sort((left, right) => left.ordinal - right.ordinal)
              .map(({ statement }) => statement),
          );
          subjects.push({
            id,
            type: row.type,
            visibility: row.redirect ? 'hidden' : row.visibility,
            redirect: row.redirect,
            securityRevision: Number(row.securityRevision),
            labels: termValues(facts, 'label').sort((left, right) => ASCII(left.language, right.language)),
            aliases: termValues(facts, 'alias').sort((left, right) => ASCII(left.language, right.language)),
            descriptions: termValues(facts, 'description').sort((left, right) => ASCII(left.language, right.language)),
            statements: indexedStatements,
          });
        }
        return { partition, position, subjects };
      });
    },

    async count(partition) {
      assertPartition(partition);
      return inSnapshot(pool, async (client) => {
        const positionRow = await readPosition.run(client, { partition_no: partition });
        const countRow = await count.run(client, { partition_no: partition });
        return {
          position: BigInt(positionRow?.position ?? '0'),
          count: Number(countRow?.visible ?? '0'),
        };
      });
    },
  };
}
