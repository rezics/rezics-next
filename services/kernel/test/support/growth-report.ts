import type { Capture } from './growth-cost.ts';
import type { GrowthMetric } from './growth-bound.ts';
import type { ReportSample, StatementAttribution } from './growth.ts';
import { indexStatementRepetitions } from './growth-report-index.ts';
import { walkPlanTree, type PlanNode } from './growth-plan-walk.ts';
import { validateCaptureEvidence } from './growth-capture-evidence.ts';

function normalizeStatement(statement: string): string {
  const identifierPart = (character: string | undefined) =>
    character !== undefined && (/[a-z0-9_$]/i.test(character) || character.charCodeAt(0) >= 0x80);
  const identifierStart = (character: string | undefined) =>
    character !== undefined && (/[a-z_]/i.test(character) || character.charCodeAt(0) >= 0x80);
  const opaque = () => statement;
  const quotedEnd = (start: number, quote: "'" | '"', backslashEscapes: boolean): number | undefined => {
    for (let index = start + 1; index < statement.length; index++) {
      const character = statement[index];
      if (backslashEscapes && character === '\\') {
        index++;
        continue;
      }
      if (character === quote) {
        if (statement[index + 1] === quote) index++;
        else return index + 1;
      }
    }
    return undefined;
  };
  const numericLiteral = (start: number): number | undefined => {
    const rest = statement.slice(start);
    const match =
      /^(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)/.exec(
        rest,
      )?.[0];
    if (!match || identifierPart(statement[start - 1]) || identifierPart(statement[start + match.length]))
      return undefined;
    return start + match.length;
  };

  let normalized = '';
  let pendingSpace = false;
  const append = (token: string) => {
    if (pendingSpace && normalized && !normalized.endsWith('\n')) normalized += ' ';
    normalized += token;
    pendingSpace = false;
  };

  for (let index = 0; index < statement.length;) {
    const character = statement[index]!;
    if (/\s/.test(character)) {
      pendingSpace = true;
      index++;
      continue;
    }

    if (character === '-' && statement[index + 1] === '-') {
      if (normalized && !normalized.endsWith('\n')) normalized += ' ';
      let end = index + 2;
      while (end < statement.length && statement[end] !== '\n' && statement[end] !== '\r') end++;
      normalized += statement.slice(index, end);
      if (end < statement.length) {
        normalized += '\n';
        end += statement[end] === '\r' && statement[end + 1] === '\n' ? 2 : 1;
      }
      index = end;
      pendingSpace = false;
      continue;
    }

    if (character === '/' && statement[index + 1] === '*') {
      let depth = 1;
      let end = index + 2;
      while (end < statement.length && depth > 0) {
        if (statement[end] === '/' && statement[end + 1] === '*') {
          depth++;
          end += 2;
        } else if (statement[end] === '*' && statement[end + 1] === '/') {
          depth--;
          end += 2;
        } else end++;
      }
      if (depth > 0) return opaque();
      if (normalized && !normalized.endsWith('\n')) normalized += ' ';
      normalized += statement.slice(index, end);
      pendingSpace = true;
      index = end;
      continue;
    }

    if (character === '"') {
      const end = quotedEnd(index, '"', false);
      if (end === undefined) return opaque();
      append(statement.slice(index, end));
      index = end;
      continue;
    }

    const previousIsPart = identifierPart(statement[index - 1]);
    let prefix = '';
    let quoteIndex = index;
    let escapes = false;
    if (!previousIsPart) {
      const next = statement[index + 1];
      if ((character === 'E' || character === 'e') && next === "'") {
        prefix = character;
        quoteIndex++;
        escapes = true;
      } else if (
        (character === 'N' ||
          character === 'n' ||
          character === 'B' ||
          character === 'b' ||
          character === 'X' ||
          character === 'x') &&
        next === "'"
      ) {
        prefix = character;
        quoteIndex++;
      } else if ((character === 'U' || character === 'u') && next === '&' && statement[index + 2] === "'") {
        prefix = `${character}&`;
        quoteIndex += 2;
      }
    }
    if (character === "'" || quoteIndex !== index) {
      const end = quotedEnd(quoteIndex, "'", escapes);
      if (end === undefined) return opaque();
      if (!escapes && statement.slice(quoteIndex, end).includes('\\')) return opaque();
      append(`${prefix}?`);
      index = end;
      continue;
    }

    if (character === '$') {
      const parameter = /^\$\d+/.exec(statement.slice(index))?.[0];
      if (parameter) {
        append('?');
        index += parameter.length;
        continue;
      }
      if (!previousIsPart) {
        const delimiter = /^\$(?:[a-z_][a-z_0-9]*|[\u0080-\uffff][a-z_0-9\u0080-\uffff]*)?\$/i.exec(
          statement.slice(index),
        )?.[0];
        if (delimiter) {
          const close = statement.indexOf(delimiter, index + delimiter.length);
          if (close < 0) return opaque();
          append('?');
          index = close + delimiter.length;
          continue;
        }
        return opaque();
      }
    }

    if (character === '.' && /\d/.test(statement[index + 1] ?? '')) {
      const end = numericLiteral(index);
      if (end !== undefined) {
        append('?');
        index = end;
        continue;
      }
    } else if (/\d/.test(character)) {
      const end = numericLiteral(index);
      if (end !== undefined) {
        append('?');
        index = end;
        continue;
      }
    }

    if (identifierStart(character)) {
      let end = index + 1;
      while (identifierPart(statement[end])) end++;
      append(statement.slice(index, end));
      index = end;
      continue;
    }

    append(character);
    index++;
  }
  return normalized.trim();
}

function planEntries(document: unknown, location = 'plan'): { queryText?: string; plan: PlanNode; location: string }[] {
  const arrayDocument = Array.isArray(document);
  const entries = arrayDocument ? document : [document];
  return entries.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null || !('Plan' in entry)) return [];
    const candidate = entry as { Plan?: unknown; 'Query Text'?: unknown };
    if (typeof candidate.Plan !== 'object' || candidate.Plan === null) return [];
    return [
      {
        ...(typeof candidate['Query Text'] === 'string' ? { queryText: candidate['Query Text'] } : {}),
        plan: candidate.Plan as PlanNode,
        location: `${location}${arrayDocument ? `[${index}]` : ''}.Plan`,
      },
    ];
  });
}

function planCost(root: PlanNode, location: string): { rows: number; blocks: number; node?: string } {
  let rows = 0;
  let costliest = { blocks: -1, rows: -1, name: undefined as string | undefined };
  let costliestNamed = { blocks: -1, rows: -1, name: undefined as string | undefined };
  const blocks =
    (typeof root['Shared Hit Blocks'] === 'number' ? root['Shared Hit Blocks'] : 0) +
    (typeof root['Shared Read Blocks'] === 'number' ? root['Shared Read Blocks'] : 0);
  for (const { node } of walkPlanTree(root, location)) {
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
    if (nodeBlocks > costliest.blocks || (nodeBlocks === costliest.blocks && nodeRows > costliest.rows)) {
      costliest = { blocks: nodeBlocks, rows: nodeRows, name: `${type}${relation ? ` ${relation}` : ''}` };
    }
    if (
      relation &&
      (nodeBlocks > costliestNamed.blocks || (nodeBlocks === costliestNamed.blocks && nodeRows > costliestNamed.rows))
    ) {
      costliestNamed = { blocks: nodeBlocks, rows: nodeRows, name: `${type} ${relation}` };
    }
  }
  const node = costliestNamed.name ?? costliest.name;
  return {
    rows,
    blocks,
    ...(node === undefined ? {} : { node }),
  };
}

export function statementAttributions(capture: Capture): StatementAttribution[] {
  validateCaptureEvidence(capture);
  const statements = new Map<string, { rows: number; blocks: number; count: number; node?: string }>();
  for (const statement of capture.statements) {
    const key = normalizeStatement(statement);
    const current = statements.get(key) ?? { rows: 0, blocks: 0, count: 0 };
    current.count++;
    statements.set(key, current);
  }
  for (let index = 0; index < capture.plans.length; index++)
    for (const { queryText, plan, location } of planEntries(capture.plans[index], `plans[${index}]`)) {
      if (queryText === undefined) continue;
      const key = normalizeStatement(queryText);
      const current = statements.get(key);
      if (!current) continue;
      const cost = planCost(plan, location);
      current.rows += cost.rows;
      current.blocks += cost.blocks;
      if (cost.node) current.node = cost.node;
    }
  return [...statements].map(([statement, cost]) => ({ statement, ...cost }));
}

export type StatementOccurrence = {
  readonly index: number;
  readonly statement: string;
  readonly backend: number | undefined;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly plans: readonly number[];
  /** Native documents linked to this occurrence, retained after the capture is released. */
  readonly planDocuments: readonly unknown[];
  readonly rows: number;
  readonly blocks: number;
};

export type StatementOccurrences = {
  readonly statements: readonly StatementOccurrence[];
  readonly backgroundStatements: readonly StatementOccurrence[];
};

/** Costs each statement occurrence only from plans linked to it at capture time. */
export function statementOccurrences(capture: Capture): StatementOccurrences {
  validateCaptureEvidence(capture);
  const occurrences = (
    statements: readonly string[],
    errors: readonly (string | null)[] | undefined,
    messages: readonly (string | null)[] | undefined,
    backends: readonly (number | undefined)[] | undefined,
    plans: readonly unknown[],
    planStatements: readonly (number | undefined)[] | undefined,
    planCollection: string,
  ): StatementOccurrence[] => {
    const plansByStatement = Array.from({ length: statements.length }, () => [] as number[]);
    for (let planIndex = 0; planIndex < plans.length; planIndex++) {
      const statementIndex = planStatements?.[planIndex];
      if (
        statementIndex !== undefined &&
        Number.isInteger(statementIndex) &&
        statementIndex >= 0 &&
        statementIndex < statements.length
      )
        plansByStatement[statementIndex]!.push(planIndex);
    }
    return statements.map((statement, index) => {
      const planIndices = plansByStatement[index]!;
      let rows = 0;
      let blocks = 0;
      for (const planIndex of planIndices) {
        for (const entry of planEntries(plans[planIndex], `${planCollection}[${planIndex}]`)) {
          const cost = planCost(entry.plan, entry.location);
          rows += cost.rows;
          blocks += cost.blocks;
        }
      }
      const code = errors?.[index] ?? null;
      return {
        index,
        statement: normalizeStatement(statement),
        backend: backends?.[index],
        error: code === null ? null : { code, message: messages?.[index] ?? '' },
        plans: planIndices,
        planDocuments: planIndices.map((planIndex) => plans[planIndex]),
        rows,
        blocks,
      };
    });
  };
  return {
    statements: occurrences(
      capture.statements,
      capture.statementErrors,
      capture.statementErrorMessages,
      capture.statementBackends,
      capture.plans,
      capture.planStatements,
      'plans',
    ),
    backgroundStatements: occurrences(
      capture.backgroundStatements ?? [],
      capture.backgroundStatementErrors,
      capture.backgroundStatementErrorMessages,
      capture.backgroundStatementBackends,
      capture.backgroundPlans ?? [],
      capture.backgroundPlanStatements,
      'backgroundPlans',
    ),
  };
}

function medianWithMissingZeros(values: readonly number[], repetitionCount: number): number {
  if (!repetitionCount) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const missing = repetitionCount - sorted.length;
  let firstZero = 0;
  while (firstZero < sorted.length && sorted[firstZero]! < 0) firstZero++;
  const at = (index: number) => {
    if (index >= firstZero && index < firstZero + missing) return 0;
    return sorted[index < firstZero ? index : index - missing]!;
  };
  const middle = Math.floor(repetitionCount / 2);
  return repetitionCount % 2 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
}

type ProfiledStatement = {
  readonly rows: number;
  readonly blocks: number;
  readonly count: number;
  readonly repetitions: readonly number[];
  readonly node?: string;
};

function profileStatementRuns(runs: readonly (readonly StatementAttribution[])[]) {
  const index = indexStatementRepetitions(runs);
  const statements = new Map<string, ProfiledStatement>();
  for (const [statement, summary] of index.statements)
    statements.set(statement, {
      rows: medianWithMissingZeros(
        summary.entries.map(({ rows }) => rows),
        index.repetitionCount,
      ),
      blocks: medianWithMissingZeros(
        summary.entries.map(({ blocks }) => blocks),
        index.repetitionCount,
      ),
      count: medianWithMissingZeros(
        summary.entries.map(({ count }) => count),
        index.repetitionCount,
      ),
      repetitions: summary.repetitions,
      ...(summary.node === undefined ? {} : { node: summary.node }),
    });
  return { repetitionCount: index.repetitionCount, statements };
}

export function profileStatements(samples: readonly Pick<ReportSample, 'statementRepetitions'>[]) {
  return samples.map(({ statementRepetitions }) => {
    const { statements } = profileStatementRuns(statementRepetitions);
    return [...statements.keys()].sort().map((statement) => {
      const profile = statements.get(statement)!;
      return { statement, rows: profile.rows, blocks: profile.blocks, count: profile.count };
    });
  });
}

export function formatStatementAttribution(
  samples: readonly Pick<ReportSample, 'scale' | 'statementRepetitions'>[],
  metrics: readonly GrowthMetric[],
): string {
  const lines: string[] = [];
  const profiles = samples.map(({ statementRepetitions }) => profileStatementRuns(statementRepetitions));
  for (const metric of [...new Set(metrics)]) {
    const all = new Set(profiles.flatMap(({ statements }) => [...statements.keys()]));
    const field =
      metric === 'rows' || metric === 'requestBytes' || metric === 'responseBytes'
        ? 'rows'
        : metric === 'blocks'
          ? 'blocks'
          : 'count';
    const ranked = [...all]
      .map((statement) => {
        const values = profiles.map(({ statements }) => statements.get(statement)?.[field] ?? 0);
        const nodes = profiles.flatMap(({ statements }) => {
          const node = statements.get(statement)?.node;
          return node ? [node] : [];
        });
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
  samples.forEach(({ scale }, sampleIndex) => {
    const { repetitionCount, statements } = profiles[sampleIndex]!;
    for (const [statement, profile] of statements) {
      if (profile.repetitions.length > 0 && profile.repetitions.length < repetitionCount)
        lines.push(
          `Intermittent at scale ${scale}: ${statement.split('\n')[0]} ran in repetitions ${profile.repetitions.join(', ')}`,
        );
    }
  });
  return lines.length ? `\nStatement attribution:\n${lines.join('\n')}` : '';
}
