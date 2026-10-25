import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';

export type Binding = { bound: true; parameter: string | null } | { bound: false; reason: string };

type Queryable = Pick<Pool | PoolClient, 'query'>;
type Column = { name: string; attnum: number };
type Relation = { schema: string; name: string; key: string; columns: Column[] };
type PlanNode = {
  'Node Type'?: string;
  Operation?: string;
  'Relation Name'?: string;
  Schema?: string;
  Alias?: string;
  Output?: string[];
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  Filter?: string;
  Plans?: PlanNode[];
};

async function relations(client: Queryable): Promise<Map<string, Relation>> {
  const { rows } = await client.query<{
    schema_name: string;
    relation_name: string;
    key_name: string;
    attnum: number;
    column_name: string;
  }>(`
    SELECT n.nspname AS schema_name, c.relname AS relation_name, key_column.attname AS key_name,
      key_column.attnum, a.attname AS column_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN LATERAL (
      SELECT pa.attname, pa.attnum
      FROM pg_index pi
      JOIN pg_attribute pa ON pa.attrelid = c.oid AND pa.attnum = pi.indkey[0]
      WHERE pi.indrelid = c.oid AND pi.indisprimary
      LIMIT 1
    ) key_column ON true
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND n.nspname NOT IN ('public', 'dbos')
    ORDER BY n.nspname, c.relname, a.attnum
  `);
  const result = new Map<string, Relation>();
  for (const row of rows) {
    const key = `${row.schema_name}.${row.relation_name}`;
    let relation = result.get(key);
    if (!relation) {
      relation = { schema: row.schema_name, name: row.relation_name, key: row.key_name, columns: [] };
      result.set(key, relation);
    }
    relation.columns.push({ name: row.column_name, attnum: row.attnum });
  }
  return result;
}

export async function checkKeys(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ violation: string }>(`
    WITH tables AS (
      SELECT c.oid, n.nspname, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND n.nspname NOT IN ('public', 'dbos')
    ), violations AS (
      SELECT format('%I.%I', t.nspname, t.relname) AS violation
      FROM tables t
      WHERE NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = t.oid AND i.indisprimary)
      UNION ALL
      SELECT format('%I.%I', tn.nspname, ti.relname) AS violation
      FROM pg_index i
      JOIN tables t ON t.oid = i.indrelid
      JOIN pg_class ti ON ti.oid = i.indexrelid
      JOIN pg_namespace tn ON tn.oid = ti.relnamespace
      WHERE i.indisunique
        AND NOT EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = t.oid AND a.attnum = i.indkey[0]
            AND a.attname IN ('route', 'partition_no')
        )
    )
    SELECT violation FROM violations ORDER BY violation
  `);
  return rows.map((row) => row.violation);
}

function stripParens(expression: string): string {
  let value = expression.trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let encloses = true;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      if (depth === 0 && i < value.length - 1) {
        encloses = false;
        break;
      }
    }
    if (!encloses) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function conjuncts(expression: string): string[] {
  const value = stripParens(expression);
  let depth = 0;
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (depth === 0 && /^AND\b/i.test(value.slice(i))) {
      pieces.push(value.slice(start, i).trim());
      i += 2;
      start = i + 1;
    }
  }
  pieces.push(value.slice(start).trim());
  return pieces.flatMap((piece) => {
    const stripped = stripParens(piece);
    return stripped === piece ? [piece] : conjuncts(stripped);
  });
}

function directParameter(expression: string, alias: string, key: string): number | null {
  const left = new RegExp(`^(?:"?${escapeRegex(alias)}"?\\.)"?${escapeRegex(key)}"?\\s*=\\s*\\$(\\d+)$`, 'i');
  const right = new RegExp(`^\\$(\\d+)\\s*=\\s*(?:"?${escapeRegex(alias)}"?\\.)"?${escapeRegex(key)}"?$`, 'i');
  const normalized = stripParens(expression)
    .replace(/::[\w\s.[\]"]+/g, '')
    .trim();
  return Number(normalized.match(left)?.[1] ?? normalized.match(right)?.[1]) || null;
}

function rangeParameter(expressions: string[], alias: string, key: string): number | null {
  const column = `(?:"?${escapeRegex(alias)}"?\\.)"?${escapeRegex(key)}"?`;
  const lower = new RegExp(`^${column}\\s*>=\\s*\\(?(?:\\$(\\d+)\\s*\\*\\s*16)\\)?$`, 'i');
  const upper = new RegExp(`^${column}\\s*<\\s*\\(\\s*\\(\\s*\\$(\\d+)\\s*\\+\\s*1\\s*\\)\\s*\\*\\s*16\\s*\\)$`, 'i');
  const lows = expressions.map((part) => stripParens(part).match(lower)?.[1]).filter(Boolean);
  const highs = expressions.map((part) => stripParens(part).match(upper)?.[1]).filter(Boolean);
  return lows.find((parameter) => highs.includes(parameter))
    ? Number(lows.find((parameter) => highs.includes(parameter)))
    : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function checkStatement(
  client: Queryable,
  statement: { sql: string; params: string[] },
): Promise<Binding> {
  const metadata = await relations(client);
  const { rows } = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `EXPLAIN (VERBOSE, GENERIC_PLAN, FORMAT JSON) ${statement.sql}`,
  );
  const root = rows[0]?.['QUERY PLAN']?.[0]?.Plan;
  if (!root) return { bound: false, reason: 'EXPLAIN returned no plan' };
  const bindings = new Set<number>();
  const failures = new Set<string>();

  const visit = (node: PlanNode): void => {
    const relation =
      node.Schema && node['Relation Name'] ? metadata.get(`${node.Schema}.${node['Relation Name']}`) : undefined;
    if (relation) {
      const alias = node.Alias ?? relation.name;
      if (node['Node Type'] === 'ModifyTable' && node.Operation === 'Insert') {
        const output = node.Plans?.at(-1)?.Output ?? [];
        const leadingPosition = relation.columns.findIndex((column) => column.name === relation.key);
        const match = output[leadingPosition]?.trim().match(/^\$(\d+)$/);
        if (match) bindings.add(Number(match[1]));
        else failures.add(`${relation.schema}.${relation.name} INSERT is not from one route parameter`);
      } else if (node['Node Type'] !== 'ModifyTable') {
        const expressions = [node['Index Cond'], node['Recheck Cond'], node.Filter]
          .filter((expression): expression is string => Boolean(expression))
          .flatMap(conjuncts);
        const parameter =
          expressions.map((expression) => directParameter(expression, alias, relation.key)).find(Boolean) ??
          rangeParameter(expressions, alias, relation.key);
        if (parameter) bindings.add(parameter);
        else failures.add(`${relation.schema}.${relation.name} has no condition on ${relation.key}`);
      }
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  if (failures.size) return { bound: false, reason: [...failures].sort().join('; ') };
  if (bindings.size > 1) {
    const parameters = [...bindings]
      .sort((a, b) => a - b)
      .map((number) => `$${number}${statement.params[number - 1] ? ` (${statement.params[number - 1]})` : ''}`);
    return { bound: false, reason: `multiple parameters bind authoritative tables: ${parameters.join(', ')}` };
  }
  const parameter = [...bindings][0];
  return { bound: true, parameter: parameter ? (statement.params[parameter - 1] ?? null) : null };
}

export function exemption(raw: string): string | null {
  const match = raw.match(/^-- unbound: (\S(?:.*\S)?)\r?(?:\n|$)/);
  return match?.[1]?.trim() || null;
}

async function sqlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) return sqlFiles(file);
      return entry.isFile() && entry.name.endsWith('.sql') ? [file] : [];
    }),
  );
  return nested.flat().sort((a, b) => {
    const left = relative(directory, a).split('\\').join('/');
    const right = relative(directory, b).split('\\').join('/');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export async function checkSqlFiles(
  client: Queryable,
  directory: string,
): Promise<{ file: string; binding: Binding | { exempt: string } }[]> {
  const files = await sqlFiles(resolve(directory));
  const results = await Promise.all(
    files.map(async (file) => {
      const imported = (await import(pathToFileURL(file).href)) as {
        default?: { sql?: string; raw?: string; params?: string[] };
      };
      const query = imported.default;
      if (!query) throw new Error(`${file} did not load as a reylo query`);
      const raw = query.raw ?? query.sql ?? '';
      const reason = exemption(raw);
      const binding = reason
        ? { exempt: reason }
        : await checkStatement(client, { sql: query.sql ?? raw, params: query.params ?? [] });
      return { file: relative(resolve(directory), file).split('\\').join('/'), binding };
    }),
  );
  return results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
