import { Buffer } from 'node:buffer';
import {
  backgroundPlanBounded,
  costOfPlanEvidence,
  isCatalogOnlyPlan,
  isControlStatement,
  type Cost,
  type PlanCostEvidence,
  type RelationCost,
} from './growth-cost.ts';
import {
  GrowthCaptureBudget,
  type GrowthCaptureEvidenceSide,
} from './growth-capture-budget.ts';
import { checkedAdd, sumFinite } from './growth-numeric.ts';
import {
  createPlanWalkSession,
  explainPlanEntries,
  type PlanWalkSession,
} from './growth-plan-walk.ts';
import {
  keyedRelationEntries,
  relationIdentityKey,
  type RelationIdentity,
} from './growth-relation-identity.ts';

export type FoldedPlanNotice = Readonly<{
  readonly index: number;
  readonly side: GrowthCaptureEvidenceSide;
  readonly owner: number | undefined;
  readonly backend: number | undefined;
  readonly database: string;
  readonly entries: number;
}>;

export type FoldedOccurrenceSummary = Readonly<{
  readonly index: number;
  /** Notice indexes in the matching foreground or background collection. */
  readonly plans: readonly number[];
  readonly rows: number;
  readonly attributionRows: number;
  readonly blocks: number;
  readonly node?: string;
  readonly relationIdentities: readonly RelationIdentity[];
  readonly limitations: readonly string[];
  readonly catalogOnly: boolean;
}>;

export type CostFoldedCapture = Readonly<{
  readonly kind: 'growth-cost-folded';
  readonly rawPlansRetained: false;
  readonly statements: readonly string[];
  readonly elapsedMs: number;
  readonly requestBytes: readonly number[];
  readonly responseBytes: readonly number[];
  readonly statementErrors: readonly (string | null)[];
  readonly statementErrorMessages: readonly (string | null)[];
  readonly statementBackends?: readonly (number | undefined)[];
  readonly foregroundOccurrences: readonly FoldedOccurrenceSummary[];
  readonly backgroundStatements: readonly string[];
  readonly backgroundRequestBytes: readonly number[];
  readonly backgroundResponseBytes: readonly number[];
  readonly backgroundStatementErrors: readonly (string | null)[];
  readonly backgroundStatementErrorMessages: readonly (string | null)[];
  readonly backgroundStatementBackends?: readonly (number | undefined)[];
  readonly backgroundOccurrences: readonly FoldedOccurrenceSummary[];
  readonly planNotices: readonly FoldedPlanNotice[];
  readonly backgroundPlanNotices: readonly FoldedPlanNotice[];
  readonly unattributedPlanNotices: Readonly<{ readonly foreground: number; readonly background: number }>;
  readonly cost: Cost;
  readonly telemetry: Readonly<{
    readonly entries: number;
    readonly chargedBytes: number;
    readonly entryLimit: number;
    readonly byteLimit: number;
    readonly nativeNoticeByteLimit: number;
  }>;
}>;

export type FoldedStatementInput = Readonly<{
  readonly text: string;
  readonly index: number;
  readonly backend: number | undefined;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}>;

export type FoldedCaptureInput = Readonly<{
  readonly elapsedMs: number;
  readonly statements: readonly FoldedStatementInput[];
  readonly backgroundStatements: readonly FoldedStatementInput[];
  readonly includeBackends: boolean;
}>;

type MutableRelationCost = {
  readonly identity: RelationIdentity;
  rows: number;
  blocks: number;
  nodes: number;
  sequentialScans: number;
};

type MutableOccurrence = {
  readonly index: number;
  readonly plans: number[];
  readonly relations: Map<string, MutableRelationCost>;
  readonly limitations: Set<string>;
  rows: number;
  attributionRows: number;
  blocks: number;
  sharedHit: number;
  sharedRead: number;
  planEntries: number;
  hasPlan: boolean;
  catalogOnly: boolean;
  node?: string;
};

type MutableBackgroundExecution = {
  rows: number;
  blocks: number;
  bounded: boolean;
  readonly relations: Map<string, RelationIdentity>;
};

type MutableBackgroundStatementCost = {
  rows: number;
  blocks: number;
  bounded: boolean;
  readonly relations: Map<string, RelationIdentity>;
};

const FOLDED_OBJECT_BYTES = 80;
const FOLDED_NUMERIC_DELTA_BYTES = 64;
const FOLDED_INDEX_BYTES = 8;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function chargedText(value: string, overhead = FOLDED_OBJECT_BYTES): number {
  return overhead + byteLength(value) * 8;
}

function estimatedSnapshot(value: unknown, overhead = FOLDED_OBJECT_BYTES): number {
  return overhead + byteLength(JSON.stringify(value) ?? '') * 8;
}

function occurrence(index: number): MutableOccurrence {
  return {
    index,
    plans: [],
    relations: new Map(),
    limitations: new Set(),
    rows: 0,
    attributionRows: 0,
    blocks: 0,
    sharedHit: 0,
    sharedRead: 0,
    planEntries: 0,
    hasPlan: false,
    catalogOnly: true,
  };
}

function mergeRelation(
  target: Map<string, MutableRelationCost>,
  source: RelationCost,
  budget: GrowthCaptureBudget,
  side: GrowthCaptureEvidenceSide,
): void {
  if (source.identity === undefined) throw new TypeError('Folded plan relation is missing physical identity');
  const key = relationIdentityKey(source.identity);
  let current = target.get(key);
  if (current === undefined) {
    budget.retainFoldedSummary(side, 'relation identity summary', 0, estimatedSnapshot(source.identity, 48));
    current = {
      identity: source.identity,
      rows: 0,
      blocks: 0,
      nodes: 0,
      sequentialScans: 0,
    };
    target.set(key, current);
  }
  current.rows = checkedAdd(current.rows, source.rows, 'Folded relation rows');
  current.blocks = checkedAdd(current.blocks, source.blocks, 'Folded relation blocks');
  current.nodes = checkedAdd(current.nodes, source.nodes, 'Folded relation nodes');
  current.sequentialScans = checkedAdd(current.sequentialScans, source.sequentialScans, 'Folded relation scans');
}

function mergeIdentity(
  target: Map<string, RelationIdentity>,
  source: RelationIdentity,
  budget: GrowthCaptureBudget,
  side: GrowthCaptureEvidenceSide,
): void {
  const key = relationIdentityKey(source);
  if (target.has(key)) return;
  budget.retainFoldedSummary(side, 'background relation identity', 0, estimatedSnapshot(source, 48));
  target.set(key, source);
}

function relationRecord(relations: readonly RelationCost[]): Cost['relations'] {
  return keyedRelationEntries(
    relations.flatMap((relation) =>
      relation.identity === undefined
        ? []
        : [
            {
              identity: relation.identity,
              value: {
                rows: relation.rows,
                blocks: relation.blocks,
                nodes: relation.nodes,
                sequentialScans: relation.sequentialScans,
                identity: relation.identity,
              },
            },
          ],
    ),
  );
}

export class GrowthCostFolder {
  readonly #budget: GrowthCaptureBudget;
  readonly #session: PlanWalkSession = createPlanWalkSession();
  readonly #foreground = new Map<number, MutableOccurrence>();
  readonly #background = new Map<number, MutableOccurrence>();
  readonly #planNotices: FoldedPlanNotice[] = [];
  readonly #backgroundPlanNotices: FoldedPlanNotice[] = [];
  readonly #backgroundLimitations = new Set<string>();
  readonly #backgroundQueryTexts = new Set<string>();
  readonly #backgroundExecutions = new Map<string, Map<string, MutableBackgroundExecution>>();
  readonly #unownedForeground = occurrence(-1);
  #foregroundNoticeCount = 0;
  #backgroundNoticeCount = 0;
  #backgroundRows = 0;
  #backgroundBlocks = 0;
  #unownedForegroundNoticeCount = 0;
  #unownedBackgroundNoticeCount = 0;

  constructor(budget: GrowthCaptureBudget) {
    this.#budget = budget;
    this.#budget.retainFoldedSummary('foreground', 'folder indexes and unowned summary', 0, FOLDED_OBJECT_BYTES * 3);
  }

  registerStatement(side: GrowthCaptureEvidenceSide, index: number): void {
    const target = side === 'background' ? this.#background : this.#foreground;
    if (target.has(index)) return;
    this.#budget.retainFoldedSummary(side, 'statement occurrence summary', 0, FOLDED_OBJECT_BYTES);
    target.set(index, occurrence(index));
  }

  retainStatementError(side: GrowthCaptureEvidenceSide): void {
    this.#budget.retainFoldedSummary(side, 'statement error metadata', 0, 32);
  }

  hasNativePlan(side: GrowthCaptureEvidenceSide, owner: number): boolean {
    return (side === 'background' ? this.#background : this.#foreground).get(owner)?.hasPlan === true;
  }

  addNotice(
    document: unknown,
    detail: Readonly<{
      side: GrowthCaptureEvidenceSide;
      owner: number | undefined;
      backend: number | undefined;
      database: string;
    }>,
  ): number {
    const side = detail.side;
    const index = side === 'background' ? this.#backgroundNoticeCount++ : this.#foregroundNoticeCount++;
    const collection = side === 'background' ? 'backgroundPlans' : 'plans';
    const entries = explainPlanEntries(document, `${collection}[${index}]`);
    const notice: FoldedPlanNotice = {
      index,
      side,
      owner: detail.owner,
      backend: detail.backend,
      database: detail.database,
      entries: entries.length,
    };
    this.#budget.retainFoldedSummary(side, 'native plan provenance', 0, estimatedSnapshot(notice));
    (side === 'background' ? this.#backgroundPlanNotices : this.#planNotices).push(notice);

    let statement = detail.owner === undefined
      ? undefined
      : (side === 'background' ? this.#background : this.#foreground).get(detail.owner);
    if (detail.owner !== undefined && statement === undefined) {
      this.#budget.retainFoldedSummary(side, 'statement occurrence summary', 0, FOLDED_OBJECT_BYTES);
      statement = occurrence(detail.owner);
      (side === 'background' ? this.#background : this.#foreground).set(detail.owner, statement);
    }
    if (statement !== undefined) {
      this.#budget.retainFoldedSummary(side, 'occurrence plan index', 0, FOLDED_INDEX_BYTES);
      statement.plans.push(index);
      statement.hasPlan = true;
    } else if (side === 'foreground') {
      this.#unownedForegroundNoticeCount++;
    } else {
      this.#unownedBackgroundNoticeCount++;
    }

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex]!;
      try {
        const evidence = costOfPlanEvidence(entry.plan, entry.location, detail.database, this.#session);
        const catalogOnly = isCatalogOnlyPlan(entry.plan, entry.location, this.#session);
        this.#foldEntry(side, statement, evidence, catalogOnly, notice, entryIndex, entry.queryText);
      } finally {
        this.#session.forget(entry.location, entry.plan);
      }
    }
    return index;
  }

  finish(input: FoldedCaptureInput): CostFoldedCapture {
    const foregroundSummaries = this.#summaries(this.#foreground, input.statements);
    const backgroundSummaries = this.#summaries(this.#background, input.backgroundStatements);
    const cost = this.#cost(input);
    const summaryBytes =
      FOLDED_OBJECT_BYTES +
      (foregroundSummaries.length + backgroundSummaries.length) * FOLDED_OBJECT_BYTES +
      [...foregroundSummaries, ...backgroundSummaries].reduce(
        (total, summary) => total + summary.plans.length * FOLDED_INDEX_BYTES,
        0,
      );
    this.#budget.retainFoldedSummary('foreground', 'capture result summaries', 0, summaryBytes);
    this.#budget.retainFoldedSummary('foreground', 'capture cost result', 0, estimatedSnapshot(cost, 128));
    this.#budget.retainFoldedSummary('foreground', 'capture telemetry result', 0, FOLDED_OBJECT_BYTES);

    const foregroundStatements = input.statements.map(({ text }) => text);
    const backgroundStatements = input.backgroundStatements.map(({ text }) => text);
    const telemetry = {
      entries: this.#budget.entriesUsed,
      chargedBytes: this.#budget.chargedBytes,
      entryLimit: this.#budget.limits.entries,
      byteLimit: this.#budget.limits.bytes,
      nativeNoticeByteLimit: this.#budget.limits.nativeNoticeBytes,
    };
    return {
      kind: 'growth-cost-folded',
      rawPlansRetained: false,
      statements: foregroundStatements,
      elapsedMs: input.elapsedMs,
      requestBytes: input.statements.map(({ requestBytes }) => requestBytes),
      responseBytes: input.statements.map(({ responseBytes }) => responseBytes),
      statementErrors: input.statements.map(({ errorCode }) => errorCode),
      statementErrorMessages: input.statements.map(({ errorMessage }) => errorMessage),
      ...(input.includeBackends ? { statementBackends: input.statements.map(({ backend }) => backend) } : {}),
      foregroundOccurrences: foregroundSummaries,
      backgroundStatements,
      backgroundRequestBytes: input.backgroundStatements.map(({ requestBytes }) => requestBytes),
      backgroundResponseBytes: input.backgroundStatements.map(({ responseBytes }) => responseBytes),
      backgroundStatementErrors: input.backgroundStatements.map(({ errorCode }) => errorCode),
      backgroundStatementErrorMessages: input.backgroundStatements.map(({ errorMessage }) => errorMessage),
      ...(input.includeBackends
        ? { backgroundStatementBackends: input.backgroundStatements.map(({ backend }) => backend) }
        : {}),
      backgroundOccurrences: backgroundSummaries,
      planNotices: this.#planNotices,
      backgroundPlanNotices: this.#backgroundPlanNotices,
      unattributedPlanNotices: {
        foreground: this.#unownedForegroundNoticeCount,
        background: this.#unownedBackgroundNoticeCount,
      },
      cost,
      telemetry,
    };
  }

  #foldEntry(
    side: GrowthCaptureEvidenceSide,
    statement: MutableOccurrence | undefined,
    evidence: PlanCostEvidence,
    catalogOnly: boolean,
    notice: FoldedPlanNotice,
    entryIndex: number,
    queryText: string | undefined,
  ): void {
    const limitations = side === 'background'
      ? evidence.limitations.map((limitation) =>
          `${notice.owner === undefined ? `Background plan backgroundPlans[${notice.index}] (statement occurrence unavailable)` : `Background plan backgroundPlans[${notice.index}] for background statement occurrence ${notice.owner}`}: ${limitation}`,
        )
      : evidence.limitations;
    const ownerSummary = statement ?? (side === 'foreground' ? this.#unownedForeground : undefined);
    if (side === 'foreground') {
      const totals = statement ?? this.#unownedForeground;
      totals.sharedHit = checkedAdd(totals.sharedHit, evidence.sharedHit, 'Folded occurrence shared hit blocks');
      totals.sharedRead = checkedAdd(totals.sharedRead, evidence.sharedRead, 'Folded occurrence shared read blocks');
    }
    if (ownerSummary !== undefined) {
      this.#budget.retainFoldedSummary(side, 'occurrence cost delta', 0, FOLDED_NUMERIC_DELTA_BYTES);
      ownerSummary.rows = checkedAdd(ownerSummary.rows, evidence.rows, 'Folded occurrence rows');
      ownerSummary.attributionRows = checkedAdd(
        ownerSummary.attributionRows,
        evidence.rows,
        'Folded statement attribution rows',
      );
      ownerSummary.blocks = checkedAdd(ownerSummary.blocks, evidence.blocks, 'Folded occurrence blocks');
      ownerSummary.planEntries++;
      ownerSummary.catalogOnly = ownerSummary.catalogOnly && catalogOnly;
      if (evidence.node !== undefined) ownerSummary.node = evidence.node;
      for (const relation of evidence.relationCosts) mergeRelation(ownerSummary.relations, relation, this.#budget, side);
      for (const limitation of limitations) {
        if (ownerSummary.limitations.has(limitation)) continue;
        this.#budget.retainFoldedSummary(side, 'plan limitation', 0, chargedText(limitation, 24));
        ownerSummary.limitations.add(limitation);
      }
    }

    if (side === 'background')
      for (const limitation of limitations) {
        if (this.#backgroundLimitations.has(limitation)) continue;
        this.#budget.retainFoldedSummary(side, 'background cost limitation', 0, chargedText(limitation, 24));
        this.#backgroundLimitations.add(limitation);
      }

    if (side === 'background') {
      const rows = Math.round(evidence.rows);
      this.#backgroundRows = checkedAdd(this.#backgroundRows, rows, 'Folded background rows');
      this.#backgroundBlocks = checkedAdd(this.#backgroundBlocks, evidence.blocks, 'Folded background blocks');
      if (queryText === undefined) {
        const limitation = `Background plan backgroundPlans[${notice.index}] entry ${entryIndex} has no native Query Text for background execution grouping`;
        if (!ownerSummary?.limitations.has(limitation)) {
          this.#budget.retainFoldedSummary('background', 'missing background query text diagnostic', 0, chargedText(limitation, 24));
          ownerSummary?.limitations.add(limitation);
        }
        if (!this.#backgroundLimitations.has(limitation)) {
          this.#budget.retainFoldedSummary('background', 'background cost limitation', 0, chargedText(limitation, 24));
          this.#backgroundLimitations.add(limitation);
        }
      }
      const text = queryText ?? '<unknown background statement>';
      if (!this.#backgroundQueryTexts.has(text)) {
        this.#budget.retainFoldedSummary('background', 'background query identity', 0, chargedText(text));
        this.#backgroundQueryTexts.add(text);
      }
      const executions = this.#backgroundExecutions.get(text) ?? new Map<string, MutableBackgroundExecution>();
      const ownerKey = notice.owner === undefined ? `unowned:${notice.index}:${entryIndex}` : `owner:${notice.owner}`;
      let execution = executions.get(ownerKey);
      if (execution === undefined) {
        this.#budget.retainFoldedSummary('background', 'background execution summary', 0, FOLDED_OBJECT_BYTES);
        execution = { rows: 0, blocks: 0, bounded: true, relations: new Map() };
        executions.set(ownerKey, execution);
        this.#backgroundExecutions.set(text, executions);
      }
      execution.rows = checkedAdd(execution.rows, rows, 'Folded background execution rows');
      execution.blocks = checkedAdd(execution.blocks, evidence.blocks, 'Folded background execution blocks');
      execution.bounded = execution.bounded && backgroundPlanBounded(relationRecord(evidence.relationCosts));
      for (const relation of evidence.relationCosts)
        if (relation.identity !== undefined) mergeIdentity(execution.relations, relation.identity, this.#budget, side);
    }

    if (side === 'foreground' && statement === undefined) {
      const limitation = `Foreground native plan notice ${notice.index} has no client statement occurrence owner`;
      if (!this.#unownedForeground.limitations.has(limitation)) {
        this.#budget.retainFoldedSummary(side, 'unowned plan diagnostic', 0, chargedText(limitation, 24));
        this.#unownedForeground.limitations.add(limitation);
      }
    }
  }

  #summaries(
    source: Map<number, MutableOccurrence>,
    statements: readonly FoldedStatementInput[],
  ): FoldedOccurrenceSummary[] {
    return statements.map(({ index, text }) => {
      const summary = source.get(index) ?? occurrence(index);
      return {
        index,
        plans: summary.plans,
        rows: summary.rows,
        attributionRows: summary.attributionRows,
        blocks: summary.blocks,
        ...(summary.node === undefined ? {} : { node: summary.node }),
        relationIdentities: [...summary.relations.values()].map(({ identity }) => identity),
        limitations: [...summary.limitations],
        catalogOnly: summary.hasPlan && summary.catalogOnly && !isControlStatement(text),
      };
    });
  }

  #cost(input: FoldedCaptureInput): Cost {
    const foregroundStatements = input.statements;
    let rows = 0;
    let sharedHit = 0;
    let sharedRead = 0;
    let plans = 0;
    const catalogIndexes = new Set(
      foregroundStatements
        .filter(({ text, index }) =>
          !isControlStatement(text) && this.#foreground.get(index)?.hasPlan && this.#foreground.get(index)?.catalogOnly,
        )
        .map(({ index }) => index),
    );
    const catalogStatements = catalogIndexes.size;
    const relationCosts = new Map<string, MutableRelationCost>();
    const limitations = new Set<string>();
    const mergeForeground = (source: MutableOccurrence) => {
      rows = checkedAdd(rows, source.rows, 'Folded total examined rows');
      sharedHit = checkedAdd(sharedHit, source.sharedHit, 'Folded total shared hit blocks');
      sharedRead = checkedAdd(sharedRead, source.sharedRead, 'Folded total shared read blocks');
      plans = checkedAdd(plans, source.planEntries, 'Folded total plan entries');
      for (const relation of source.relations.values()) {
        const key = relationIdentityKey(relation.identity);
        let target = relationCosts.get(key);
        if (target === undefined) {
          target = { ...relation, rows: 0, blocks: 0, nodes: 0, sequentialScans: 0 };
          relationCosts.set(key, target);
        }
        target.rows = checkedAdd(target.rows, relation.rows, 'Folded total relation rows');
        target.blocks = checkedAdd(target.blocks, relation.blocks, 'Folded total relation blocks');
        target.nodes = checkedAdd(target.nodes, relation.nodes, 'Folded total relation nodes');
        target.sequentialScans = checkedAdd(
          target.sequentialScans,
          relation.sequentialScans,
          'Folded total relation scans',
        );
      }
      for (const limitation of source.limitations) limitations.add(limitation);
    };
    for (const summary of this.#foreground.values()) {
      if (catalogIndexes.has(summary.index)) continue;
      mergeForeground(summary);
    }
    mergeForeground(this.#unownedForeground);
    for (const limitation of this.#backgroundLimitations) limitations.add(limitation);

    const backgroundCosts = new Map<string, MutableBackgroundStatementCost>();
    for (const [text, executions] of this.#backgroundExecutions) {
      for (const execution of executions.values()) {
        const prior = backgroundCosts.get(text);
        if (prior === undefined) {
          backgroundCosts.set(text, {
            rows: execution.rows,
            blocks: execution.blocks,
            bounded: execution.bounded,
            relations: new Map(execution.relations),
          });
          continue;
        }
        prior.rows = Math.max(prior.rows, execution.rows);
        prior.blocks = Math.max(prior.blocks, execution.blocks);
        prior.bounded = prior.bounded && execution.bounded;
        for (const [key, identity] of execution.relations) prior.relations.set(key, identity);
      }
    }
    const totalBlocks = checkedAdd(sharedHit, sharedRead, 'Folded total shared blocks');
    const requestBytes = sumFinite(foregroundStatements.map(({ requestBytes }) => requestBytes), 'Request bytes');
    const responseBytes = sumFinite(foregroundStatements.map(({ responseBytes }) => responseBytes), 'Response bytes');
    const backgroundRequestBytes = sumFinite(
      input.backgroundStatements.map(({ requestBytes }) => requestBytes),
      'Background request bytes',
    );
    const backgroundResponseBytes = sumFinite(
      input.backgroundStatements.map(({ responseBytes }) => responseBytes),
      'Background response bytes',
    );
    const failedStatements = new Map<string, number>();
    for (const { errorCode } of foregroundStatements)
      if (errorCode !== null) failedStatements.set(errorCode, (failedStatements.get(errorCode) ?? 0) + 1);
    const hasBackgroundWork =
      input.backgroundStatements.length > 0 || backgroundRequestBytes > 0 || backgroundResponseBytes > 0;
    const statementCount = foregroundStatements.filter(({ text, index }) =>
      !isControlStatement(text) && !catalogIndexes.has(index),
    ).length;
    const relations = keyedRelationEntries(
      [...relationCosts.values()].map((relation) => ({ identity: relation.identity, value: relation })),
    );
    return {
      statements: statementCount,
      controlStatements: foregroundStatements.filter(({ text }) => isControlStatement(text)).length,
      catalogStatements,
      plans,
      rows: Math.round(rows),
      blocks: totalBlocks,
      sharedHit,
      sharedRead,
      ...(limitations.size === 0 ? {} : { limitations: [...limitations] }),
      relations,
      requestBytes,
      responseBytes,
      ...(failedStatements.size === 0 ? {} : { failedStatements: Object.fromEntries(failedStatements) }),
      backgroundStatements: input.backgroundStatements.length,
      ...(hasBackgroundWork ? { backgroundRequestBytes, backgroundResponseBytes } : {}),
      backgroundRows: this.#backgroundRows,
      backgroundBlocks: this.#backgroundBlocks,
      backgroundCosts: Object.fromEntries(
        [...backgroundCosts].map(([text, value]) => [
          text,
          {
            rows: value.rows,
            blocks: value.blocks,
            bounded: value.bounded,
            ...(value.relations.size === 0 ? {} : { relationIdentities: [...value.relations.values()] }),
          },
        ]),
      ),
    };
  }

}

export function isCostFoldedCapture(value: unknown): value is CostFoldedCapture {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'growth-cost-folded';
}
