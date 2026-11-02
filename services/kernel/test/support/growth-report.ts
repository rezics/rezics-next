import { costOfPlan, type Capture } from './growth-cost.ts';
import type { ByteMetric, GrowthMetric } from './growth-bound.ts';
import type { ReportSample, StatementAttribution } from './growth.ts';
import { indexStatementRepetitions } from './growth-report-index.ts';
import { checkedAdd } from './growth-numeric.ts';
import { createPlanWalkSession, type PlanNode, type PlanWalkSession } from './growth-plan-walk.ts';
import { validateCaptureEvidence } from './growth-capture-evidence.ts';
import { relationIdentityKey, type RelationIdentity } from './growth-relation-identity.ts';

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

function planCost(
  root: PlanNode,
  location: string,
  session: PlanWalkSession,
  database?: string,
): { rows: number; blocks: number; node?: string; relationIdentities: readonly RelationIdentity[] } {
  const cost = costOfPlan(root, location, database, session);
  return {
    rows: Math.round(cost.rows),
    blocks: cost.blocks,
    ...(cost.node === undefined ? {} : { node: cost.node }),
    relationIdentities: cost.relationIdentities,
  };
}

function addPlanCost(
  statements: Map<
    string,
    { rows: number; blocks: number; count: number; node?: string; relationIdentities: Map<string, RelationIdentity> }
  >,
  key: string | undefined,
  plan: PlanNode,
  location: string,
  session: PlanWalkSession,
  database?: string,
) {
  if (key === undefined) return;
  const current = statements.get(key);
  if (!current) return;
  const cost = planCost(plan, location, session, database);
  current.rows = checkedAdd(current.rows, cost.rows, 'Statement examined rows');
  current.blocks = checkedAdd(current.blocks, cost.blocks, 'Statement shared blocks');
  if (cost.node) current.node = cost.node;
  for (const identity of cost.relationIdentities)
    current.relationIdentities.set(relationIdentityKey(identity), identity);
}

export function statementAttributions(capture: Capture): StatementAttribution[] {
  validateCaptureEvidence(capture);
  const session = createPlanWalkSession();
  const statements = new Map<
    string,
    { rows: number; blocks: number; count: number; node?: string; relationIdentities: Map<string, RelationIdentity> }
  >();
  for (const statement of capture.statements) {
    const key = normalizeStatement(statement);
    const current = statements.get(key) ?? { rows: 0, blocks: 0, count: 0, relationIdentities: new Map() };
    current.count++;
    statements.set(key, current);
  }
  const nativeOwners = capture.planStatements !== undefined;
  for (let index = 0; index < capture.plans.length; index++) {
    const owner = capture.planStatements?.[index];
    const ownedKey =
      nativeOwners && owner !== undefined && Number.isInteger(owner) && owner >= 0 && owner < capture.statements.length
        ? normalizeStatement(capture.statements[owner]!)
        : undefined;
    if (nativeOwners && ownedKey === undefined) continue;
    for (const { queryText, plan, location } of planEntries(capture.plans[index], `plans[${index}]`))
      addPlanCost(
        statements,
        ownedKey ?? (queryText === undefined ? undefined : normalizeStatement(queryText)),
        plan,
        location,
        session,
        capture.planDatabases?.[index],
      );
  }
  return [...statements].map(([statement, cost]) => ({
    statement,
    rows: cost.rows,
    blocks: cost.blocks,
    count: cost.count,
    ...(cost.node === undefined ? {} : { node: cost.node }),
    ...(cost.relationIdentities.size === 0 ? {} : { relationIdentities: [...cost.relationIdentities.values()] }),
  }));
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
  readonly relationIdentities?: readonly RelationIdentity[];
};

export type StatementOccurrences = {
  readonly statements: readonly StatementOccurrence[];
  readonly backgroundStatements: readonly StatementOccurrence[];
};

/** Costs each statement occurrence only from plans linked to it at capture time. */
export function statementOccurrences(capture: Capture): StatementOccurrences {
  validateCaptureEvidence(capture);
  const session = createPlanWalkSession();
  const occurrences = (
    statements: readonly string[],
    errors: readonly (string | null)[] | undefined,
    messages: readonly (string | null)[] | undefined,
    backends: readonly (number | undefined)[] | undefined,
    plans: readonly unknown[],
    planStatements: readonly (number | undefined)[] | undefined,
    planDatabases: readonly (string | undefined)[] | undefined,
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
      const relationIdentities = new Map<string, RelationIdentity>();
      for (const planIndex of planIndices) {
        for (const entry of planEntries(plans[planIndex], `${planCollection}[${planIndex}]`)) {
          const cost = planCost(entry.plan, entry.location, session, planDatabases?.[planIndex]);
          rows = checkedAdd(rows, cost.rows, 'Statement examined rows');
          blocks = checkedAdd(blocks, cost.blocks, 'Statement shared blocks');
          for (const identity of cost.relationIdentities)
            relationIdentities.set(relationIdentityKey(identity), identity);
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
        ...(relationIdentities.size === 0 ? {} : { relationIdentities: [...relationIdentities.values()] }),
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
      capture.planDatabases,
      'plans',
    ),
    backgroundStatements: occurrences(
      capture.backgroundStatements ?? [],
      capture.backgroundStatementErrors,
      capture.backgroundStatementErrorMessages,
      capture.backgroundStatementBackends,
      capture.backgroundPlans ?? [],
      capture.backgroundPlanStatements,
      capture.backgroundPlanDatabases,
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
      const relationIdentities = new Map<string, RelationIdentity>();
      for (const run of statementRepetitions) {
        for (const identity of run.find((item) => item.statement === statement)?.relationIdentities ?? [])
          relationIdentities.set(relationIdentityKey(identity), identity);
      }
      return {
        statement,
        rows: profile.rows,
        blocks: profile.blocks,
        count: profile.count,
        ...(relationIdentities.size === 0 ? {} : { relationIdentities: [...relationIdentities.values()] }),
      };
    });
  });
}

type AttributionSample = Pick<ReportSample, 'scale' | 'statementRepetitions'> & {
  readonly cost?: Partial<Record<ByteMetric, number>> & { readonly limitations?: readonly string[] };
  readonly repetitions?: readonly { readonly limitations?: readonly string[] }[];
};

const MAX_LIMITATION_ITEMS = 5;

function formatCteLimitations(samples: readonly AttributionSample[]): string[] {
  const lines: string[] = [];
  for (const { scale, cost, repetitions } of samples) {
    const items: string[] = [];
    repetitions?.forEach((repetition, index) => {
      for (const limitation of repetition.limitations ?? []) items.push(`repetition ${index + 1}: ${limitation}`);
    });
    if (items.length === 0) items.push(...(cost?.limitations ?? []));
    if (items.length === 0) continue;
    const shown = items.slice(0, MAX_LIMITATION_ITEMS);
    const omitted = items.length - shown.length;
    lines.push(
      `Scale ${scale} CTE accounting limitations: ${shown.join('; ')}${omitted > 0 ? `; ${omitted} more omitted` : ''}`,
    );
  }
  return lines;
}

function rankedStatementLines(
  samples: readonly Pick<ReportSample, 'scale'>[],
  profiles: readonly ReturnType<typeof profileStatementRuns>[],
  field: 'rows' | 'blocks' | 'count',
): string[] {
  const all = new Set(profiles.flatMap(({ statements }) => [...statements.keys()]));
  return [...all]
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
    .slice(0, 5)
    .map(
      (item) =>
        `  ${item.statement.split('\n')[0]} | ${samples.map(({ scale }, index) => `${scale}: ${item.values[index] ?? 0}`).join(', ')} | ${item.node}`,
    );
}

function formatByteMetric(
  samples: readonly AttributionSample[],
  metric: ByteMetric,
): { totals: string; unavailable: string } {
  const totals = samples
    .map(({ scale, cost }) => `${scale}: ${cost?.[metric] === undefined ? 'unmeasured' : cost[metric]}`)
    .join(', ');
  return {
    totals: `Measured ${metric} totals by scale: ${totals}`,
    unavailable: `Per-statement ${metric} attribution is unavailable; StatementAttribution has rows, blocks and counts, not byte costs.`,
  };
}

/** Byte metrics keep sample-cost totals and never rank SQL rows as statement byte costs. */
export function formatStatementAttribution(
  samples: readonly AttributionSample[],
  metrics: readonly GrowthMetric[],
): string {
  const lines: string[] = [];
  const profiles = samples.map(({ statementRepetitions }) => profileStatementRuns(statementRepetitions));
  const unique = [...new Set(metrics)];
  let sqlContext = unique.some((metric) => metric !== 'requestBytes' && metric !== 'responseBytes');
  for (const metric of unique) {
    if (metric === 'requestBytes' || metric === 'responseBytes') {
      const { totals, unavailable } = formatByteMetric(samples, metric);
      lines.push(totals, unavailable);
      if (!sqlContext) {
        lines.push('SQL row attribution (not statement byte costs):');
        lines.push(...rankedStatementLines(samples, profiles, 'rows'));
        sqlContext = true;
      }
      continue;
    }
    const field = metric === 'rows' ? 'rows' : metric === 'blocks' ? 'blocks' : 'count';
    lines.push(`Statements growing most for ${metric}:`);
    lines.push(...rankedStatementLines(samples, profiles, field));
  }
  lines.push(...formatCteLimitations(samples));
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
