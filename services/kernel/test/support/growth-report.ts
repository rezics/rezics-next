import type { Capture } from './growth-cost.ts';
import type { GrowthMetric } from './growth-bound.ts';
import type { ReportSample, StatementAttribution } from './growth.ts';

type PlanNode = Record<string, unknown>;

function normalizeStatement(statement: string): string {
  const leading = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/.exec(statement)?.[0] ?? '';
  const body = statement.slice(leading.length).replace(/'(?:''|[^'])*'|\$\d+|\?\d*|\b\d+(?:\.\d+)?\b/g, '?');
  return `${leading}${body}`.replace(/\s+/g, ' ').trim();
}

function planEntries(document: unknown): { queryText?: string; plan: PlanNode }[] {
  const entries = Array.isArray(document) ? document : [document];
  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || !('Plan' in entry)) return [];
    const candidate = entry as { Plan?: unknown; 'Query Text'?: unknown };
    if (typeof candidate.Plan !== 'object' || candidate.Plan === null) return [];
    return [
      {
        ...(typeof candidate['Query Text'] === 'string' ? { queryText: candidate['Query Text'] } : {}),
        plan: candidate.Plan as PlanNode,
      },
    ];
  });
}

function planCost(root: PlanNode): { rows: number; blocks: number; node?: string } {
  let rows = 0;
  let blocks = 0;
  let costliest = { blocks: -1, rows: -1, name: undefined as string | undefined };
  const visit = (node: PlanNode) => {
    const type = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Unknown';
    const relation =
      typeof node['Relation Name'] === 'string'
        ? `${typeof node.Schema === 'string' ? `${node.Schema}.` : ''}${node['Relation Name']}`
        : typeof node['Index Name'] === 'string'
          ? `index:${node['Index Name']}`
          : undefined;
    const loops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 1;
    const scanned = [
      'Seq Scan',
      'Index Scan',
      'Index Only Scan',
      'Bitmap Heap Scan',
      'Tid Scan',
      'Tid Range Scan',
      'Sample Scan',
    ].includes(type);
    const nodeRows = scanned
      ? ((typeof node['Actual Rows'] === 'number' ? node['Actual Rows'] : 0) +
          (typeof node['Rows Removed by Filter'] === 'number' ? node['Rows Removed by Filter'] : 0) +
          (typeof node['Rows Removed by Index Recheck'] === 'number' ? node['Rows Removed by Index Recheck'] : 0)) *
        loops
      : type === 'ModifyTable'
        ? (typeof node['Actual Rows'] === 'number' ? node['Actual Rows'] : 0) * loops
        : 0;
    const nodeBlocks =
      (typeof node['Shared Hit Blocks'] === 'number' ? node['Shared Hit Blocks'] : 0) +
      (typeof node['Shared Read Blocks'] === 'number' ? node['Shared Read Blocks'] : 0);
    rows += nodeRows;
    blocks += nodeBlocks;
    if (nodeBlocks > costliest.blocks || (nodeBlocks === costliest.blocks && nodeRows > costliest.rows)) {
      costliest = { blocks: nodeBlocks, rows: nodeRows, name: `${type}${relation ? ` ${relation}` : ''}` };
    }
    if (Array.isArray(node.Plans))
      for (const child of node.Plans) if (typeof child === 'object' && child !== null) visit(child as PlanNode);
  };
  visit(root);
  return { rows, blocks, ...(costliest.name ? { node: costliest.name } : {}) };
}

export function statementAttributions(capture: Capture): StatementAttribution[] {
  const statements = new Map<string, { rows: number; blocks: number; count: number; node?: string }>();
  for (const statement of capture.statements) {
    const key = normalizeStatement(statement);
    const current = statements.get(key) ?? { rows: 0, blocks: 0, count: 0 };
    current.count++;
    statements.set(key, current);
  }
  for (const document of capture.plans)
    for (const { queryText, plan } of planEntries(document)) {
      if (queryText === undefined) continue;
      const key = normalizeStatement(queryText);
      const current = statements.get(key);
      if (!current) continue;
      const cost = planCost(plan);
      current.rows += cost.rows;
      current.blocks += cost.blocks;
      if (cost.node) current.node = cost.node;
    }
  return [...statements].map(([statement, cost]) => ({ statement, ...cost }));
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function profileStatements(samples: readonly ReportSample[]) {
  return samples.map(({ statementRepetitions }) => {
    const keys = new Set(statementRepetitions.flatMap((run) => run.map(({ statement }) => statement)));
    return [...keys].sort().map((statement) => {
      const values = statementRepetitions.map((run) => run.find((item) => item.statement === statement));
      return {
        statement,
        rows: median(values.map((item) => item?.rows ?? 0)),
        blocks: median(values.map((item) => item?.blocks ?? 0)),
        count: median(values.map((item) => item?.count ?? 0)),
      };
    });
  });
}

export function formatStatementAttribution(samples: readonly ReportSample[], metrics: readonly GrowthMetric[]): string {
  const lines: string[] = [];
  for (const metric of [...new Set(metrics)]) {
    const all = new Set(
      samples.flatMap(({ statementRepetitions }) =>
        statementRepetitions.flatMap((run) => run.map((item) => item.statement)),
      ),
    );
    const field =
      metric === 'rows' || metric === 'requestBytes' || metric === 'responseBytes'
        ? 'rows'
        : metric === 'blocks'
          ? 'blocks'
          : 'count';
    const ranked = [...all]
      .map((statement) => {
        const values = samples.map(({ statementRepetitions }) =>
          median(statementRepetitions.map((run) => run.find((item) => item.statement === statement)?.[field] ?? 0)),
        );
        const nodes = samples.flatMap(({ statementRepetitions }) =>
          statementRepetitions.flatMap((run) =>
            run
              .filter((item) => item.statement === statement)
              .map((item) => item.node)
              .filter((node): node is string => !!node),
          ),
        );
        return {
          statement,
          values,
          growth: (values.at(-1) ?? 0) - (values[0] ?? 0),
          node: nodes.at(-1) ?? 'unknown plan node',
        };
      })
      .sort((a, b) => b.growth - a.growth)
      .slice(0, 5);
    lines.push(`Statements growing most for ${metric}:`);
    for (const item of ranked)
      lines.push(
        `  ${item.statement.split('\n')[0]} | ${samples.map(({ scale }, index) => `${scale}: ${item.values[index] ?? 0}`).join(', ')} | ${item.node}`,
      );
  }
  samples.forEach(({ scale, statementRepetitions }) => {
    const keys = new Set(statementRepetitions.flatMap((run) => run.map(({ statement }) => statement)));
    for (const statement of keys) {
      const reps = statementRepetitions.flatMap((run, index) =>
        run.some((item) => item.statement === statement) ? [index + 1] : [],
      );
      if (reps.length > 0 && reps.length < statementRepetitions.length)
        lines.push(`Intermittent at scale ${scale}: ${statement.split('\n')[0]} ran in repetitions ${reps.join(', ')}`);
    }
  });
  return lines.length ? `\nStatement attribution:\n${lines.join('\n')}` : '';
}
