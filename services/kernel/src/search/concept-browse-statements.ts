import { parseFilter, type FilterDocument, type FilterQualifier, type SpoilerThreshold } from '@rezics/filter';
import { holdsCurrentStatements } from './current-leaf.ts';
import {
  matchCurrentConceptStatements,
  currentConceptMemberships,
  currentConceptStatementWitnesses,
  type ConceptBrowseSource,
  type ConceptBrowseState,
  type ConceptBrowseStore,
} from './concept-browse.ts';
import type { IndexedStatement, RelationFacetMatch } from './source.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { compileCurrentFilter, currentConceptStatementsMatch } from './current-filter-plan.ts';

export type ConceptStatementRequest = Readonly<{
  subject: string;
  selection: Readonly<{ property: string; concept: string; scheme: string; includeChildren?: boolean }>;
  qualifiers?: readonly FilterQualifier[];
  spoilerThreshold?: SpoilerThreshold;
}>;
/** Internal full native statement key. A continuation is usable only with its original observation. */
export type ConceptStatementCursor = Readonly<{
  slot: string;
  candidate: string;
  observation: string;
}>;
export type ConceptStatementWindow = Readonly<{
  statements: readonly IndexedStatement[];
  examined: number;
  after: ConceptStatementCursor | null;
  terminal: boolean;
  /** True only when the native owner proves the complete selected prefix in this window. */
  complete: boolean;
  /** Native owner's ready, unsampled selected prefix identity. Every raw row, including
   * rejected/hidden rows, participates in the full-key continuation and revalidation.
   * This is not an absence proof until traversal from the start reaches a short window.
   */
  readyPrefix?: string;
}>;
export type ConceptStatementRead =
  | Readonly<{
      status: 'current';
      page: ConceptStatementWindow;
      /** Re-read native selection, disclosure, original/terminal identities and source witnesses.
       * This attempt-local function must run after retained membership I/O, even for rejected rows.
       */
      revalidate(): Promise<'current' | 'changed' | 'unavailable'>;
    }>
  | Readonly<{ status: 'preparing' | 'unavailable' | 'changed' }>;
export type ConceptStatementReader = (
  partition: number,
  request: ConceptStatementRequest,
  after: ConceptStatementCursor | null,
  limit: number,
) => Promise<ConceptStatementRead>;

export const CONCEPT_STATEMENT_PAGE_SIZE = 64;
/** Attempt-local revalidators retain native evidence. These bound one dispatch, not a prefix. */
export const CONCEPT_STATEMENT_PREFIX_LIMITS = Object.freeze({ windows: 32, rows: 2048 });
export type ConceptStatementPrefixAllowance = Readonly<{
  /** Dispatches, including a possible empty terminal seek. */
  windows: number;
  /** Sum of admitted raw window limits, including rejected rows and terminal seeks. */
  rows: number;
}>;
export type ConceptStatementPrefixResult = Readonly<{
  status: 'current' | 'preparing' | 'unavailable' | 'restart';
  match: RelationFacetMatch;
  windows: number;
  examined: number;
  complete: boolean;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A short first window over a ready selection is the whole current native prefix. */
export function completeNativeStatementPrefix(
  selectionReady: boolean,
  after: ConceptStatementCursor | null,
  examined: number,
  limit: number,
): boolean {
  return (
    selectionReady &&
    after === null &&
    Number.isSafeInteger(examined) &&
    examined >= 0 &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    examined < limit
  );
}

/** A ready selection proves enumeration, not disclosure. Missing native witnesses cannot
 * become negative evidence, even when the raw keyset has reached its end. A disclosed
 * nonmatching witness (for example, a spoiler above the threshold) can still prove false.
 */
export function nativeConceptStatementCoverage(
  selectionReady: boolean,
  after: ConceptStatementCursor | null,
  examined: number,
  limit: number,
  disclosed: number,
  observation: string,
): Readonly<{ complete: boolean; readyPrefix?: string }> {
  const covered =
    selectionReady &&
    Number.isSafeInteger(examined) &&
    examined >= 0 &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= CONCEPT_STATEMENT_PAGE_SIZE &&
    examined <= limit &&
    disclosed === examined &&
    /^[0-9a-f]{64}$/.test(observation);
  return {
    complete: covered && completeNativeStatementPrefix(selectionReady, after, examined, limit),
    ...(covered ? { readyPrefix: observation } : {}),
  };
}
/** Own and structurally admit inputs before any native or retained await. */
export function conceptStatementRequest(
  partition: number,
  input: ConceptStatementRequest,
  after: ConceptStatementCursor | null,
  limit: number,
): ConceptStatementRequest {
  const route = routeOf(input?.subject);
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition >= 4096 ||
    route === null ||
    partitionOf(route) !== partition ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONCEPT_STATEMENT_PAGE_SIZE ||
    (input.spoilerThreshold !== undefined && ![0, 1, 2].includes(input.spoilerThreshold)) ||
    (after !== null &&
      (!uuid.test(after.slot) || !uuid.test(after.candidate) || !/^[0-9a-f]{64}$/.test(after.observation)))
  )
    throw new TypeError('Invalid concept statement request');
  const filter = parseFilter({
    statement: {
      property: input.selection.property,
      in: [input.selection.concept],
      concept: {
        scheme: input.selection.scheme,
        ...(input.selection.includeChildren === undefined ? {} : { includeChildren: input.selection.includeChildren }),
      },
      ...(input.qualifiers ? { qualifiers: input.qualifiers } : {}),
    },
  });
  if (!('statement' in filter) || !('in' in filter.statement)) throw new TypeError('Invalid concept statement request');
  return Object.freeze({
    subject: input.subject,
    selection: Object.freeze({ ...input.selection }),
    ...(filter.statement.qualifiers
      ? {
          qualifiers: Object.freeze(
            filter.statement.qualifiers.map((q) =>
              Object.freeze({ property: q.property, in: Object.freeze([...q.in]) }),
            ),
          ),
        }
      : {}),
    ...(input.spoilerThreshold === undefined ? {} : { spoilerThreshold: input.spoilerThreshold }),
  });
}

export function conceptStatementQualifiers(request: ConceptStatementRequest): readonly FilterQualifier[] {
  return [
    ...(request.qualifiers ?? []),
    ...(request.spoilerThreshold === undefined
      ? []
      : [
          {
            property: 'rezics:spoilerLevel',
            in: ['0', '1', '2'].slice(0, request.spoilerThreshold + 1),
          },
        ]),
  ];
}

/** A bounded native witness window composed with a retained closure. Never traverses the graph
 * per candidate and never refills. A native mutation on a rejected row also retires the cut.
 */
export async function matchNativeConceptStatements(
  reader: ConceptStatementReader,
  source: ConceptBrowseSource,
  store: ConceptBrowseStore,
  state: ConceptBrowseState,
  partition: number,
  input: ConceptStatementRequest,
  after: ConceptStatementCursor | null = null,
  limit = CONCEPT_STATEMENT_PAGE_SIZE,
): Promise<
  Readonly<{
    status: 'current' | 'preparing' | 'unavailable' | 'restart';
    match: RelationFacetMatch;
    page?: ConceptStatementWindow;
  }>
> {
  const request = conceptStatementRequest(partition, input, after, limit);
  const retained: ConceptBrowseState = structuredClone(state);
  const cursor = after === null ? null : { ...after };
  const read = await reader(partition, request, cursor, limit);
  async function restart() {
    await store.retire(retained);
    return { status: 'restart', match: 'not_proven' } as const;
  }
  if (read.status === 'changed') return restart();
  if (read.status !== 'current') return { status: read.status, match: 'not_proven' };
  const nativePage = structuredClone(read.page);
  if (
    !Array.isArray(nativePage.statements) ||
    !Number.isSafeInteger(nativePage.examined) ||
    nativePage.examined < 0 ||
    nativePage.examined < nativePage.statements.length ||
    nativePage.examined > limit ||
    typeof nativePage.complete !== 'boolean' ||
    typeof nativePage.terminal !== 'boolean' ||
    (nativePage.complete && (!nativePage.terminal || nativePage.examined >= limit)) ||
    (!nativePage.terminal && nativePage.after === null)
  )
    return restart();
  // A terminal suffix cannot prove the omitted prefix. Multi-window absence needs a separate
  // owner proof; this matcher accepts a native complete-prefix proof only from its first window.
  const page = { ...nativePage, complete: cursor === null && nativePage.complete };
  const qualifiers = conceptStatementQualifiers(request);
  const match = await matchCurrentConceptStatements(source, store, retained, {
    selection: request.selection,
    statements: page.statements.map((statement) => ({
      property: statement.property,
      concept: statement.value,
      witness: holdsCurrentStatements([statement], {
        facet: 'statement',
        property: request.selection.property,
        values: [statement.value],
        qualifiers,
      }),
    })),
    complete: page.complete,
  });
  const current = await read.revalidate();
  if (current === 'changed') return restart();
  if (current !== 'current') return { status: 'unavailable', match: 'not_proven' };
  return { status: 'current', match, page };
}

/** Prove a selected prefix across explicitly admitted bounded windows. Always starts at
 * the beginning: a caller cannot supply a suffix cursor as an absence certificate. This
 * performs no refill beyond the supplied dispatch and raw-row allowance. Callers must
 * reserve native and retained owner costs before enabling it in a Search dispatcher.
 * Revalidation closures retain at most the admitted windows, never a whole population.
 */
export async function matchNativeConceptStatementPrefix(
  reader: ConceptStatementReader,
  source: ConceptBrowseSource,
  store: ConceptBrowseStore,
  state: ConceptBrowseState,
  partition: number,
  input: ConceptStatementRequest,
  allowance: ConceptStatementPrefixAllowance,
): Promise<ConceptStatementPrefixResult> {
  const attempt = new ConceptStatementAttempt(allowance);
  const request = conceptStatementRequest(partition, input, null, attempt.windowLimit());
  const cut = ownConceptStatementCut({ source, store, state });
  const scanned = await scanConceptStatementPrefix(reader, cut, partition, request, attempt);
  if (scanned.status !== 'current') return attempt.finishStatus(scanned.status, [cut]);
  const current = await attempt.revalidate([cut]);
  if (current === 'not_proven') return attempt.result('current');
  return current === 'current'
    ? attempt.result('current', scanned.match, scanned.complete)
    : attempt.finishStatus(current, [cut]);
}

export type ConceptStatementCut = Readonly<{
  source: ConceptBrowseSource;
  store: ConceptBrowseStore;
  state: ConceptBrowseState;
}>;

function ownConceptStatementCut(cut: ConceptStatementCut): ConceptStatementCut {
  return { source: cut.source, store: cut.store, state: structuredClone(cut.state) };
}

/** Native concept-only Boolean conditions. Release admission stays with the native reader.
 * Uses the canonical current interpreter and one attempt allowance across deduplicated
 * leaves. Every cut is resolved before I/O; every visited native window is revalidated after
 * all leaves' membership work, including rejected candidates and alternatives already true.
 * This internal port does not activate universal Search or reserve native all-pool work.
 */
export async function matchNativeConceptFilter(
  reader: ConceptStatementReader,
  partition: number,
  input: Readonly<{ subject: string; filter: FilterDocument; spoilerThreshold?: SpoilerThreshold }>,
  resolveCut: (request: ConceptStatementRequest) => ConceptStatementCut | null,
  allowance: ConceptStatementPrefixAllowance,
): Promise<ConceptStatementPrefixResult> {
  const attempt = new ConceptStatementAttempt(allowance);
  const plan = compileCurrentFilter(parseFilter(input.filter));
  // Admit and copy the entire request before calling even a synchronous cut resolver.
  const requests = plan.leaves.map((clause) => {
    if (clause.facet !== 'statement' || !('values' in clause) || !clause.concept || clause.inverse)
      throw new TypeError('Native concept conditions require scheme-bound concept leaves');
    return conceptStatementRequest(
      partition,
      {
        subject: input.subject,
        selection: {
          property: clause.property,
          concept: clause.values[0]!,
          scheme: clause.concept.scheme,
          includeChildren: clause.concept.includeChildren,
        },
        qualifiers: clause.qualifiers,
        spoilerThreshold: input.spoilerThreshold,
      },
      null,
      attempt.windowLimit(),
    );
  });
  const cuts = requests.map((request) => {
    const cut = resolveCut(request);
    return cut === null ? null : ownConceptStatementCut(cut);
  });
  if (cuts.some((cut) => cut === null)) return attempt.result('preparing');
  const admittedCuts = cuts as ConceptStatementCut[];
  const matches: RelationFacetMatch[] = [];
  let complete = true;
  for (const [index, request] of requests.entries()) {
    const scanned = await scanConceptStatementPrefix(reader, admittedCuts[index]!, partition, request, attempt);
    if (scanned.status !== 'current') return attempt.finishStatus(scanned.status, admittedCuts);
    matches.push(scanned.match);
    complete &&= scanned.complete;
  }
  const current = await attempt.revalidate(admittedCuts);
  if (current === 'not_proven') return attempt.result('current');
  return current === 'current'
    ? attempt.result('current', plan.evaluate(matches), complete)
    : attempt.finishStatus(current, admittedCuts);
}

/** Attempt-local native evidence is bounded across the whole Boolean expression. */
class ConceptStatementAttempt {
  windows = 0;
  examined = 0;
  private remainingRows: number;
  private remainingWindows: number;
  readonly validators: (() => Promise<'current' | 'changed' | 'unavailable'>)[] = [];
  constructor(allowance: ConceptStatementPrefixAllowance) {
    const { windows, rows } = allowance;
    if (
      !Number.isSafeInteger(windows) ||
      windows < 1 ||
      windows > CONCEPT_STATEMENT_PREFIX_LIMITS.windows ||
      !Number.isSafeInteger(rows) ||
      rows < 1 ||
      rows > CONCEPT_STATEMENT_PREFIX_LIMITS.rows
    )
      throw new RangeError('Invalid concept statement prefix allowance');
    this.remainingWindows = windows;
    this.remainingRows = rows;
  }
  windowLimit(): number {
    return Math.min(CONCEPT_STATEMENT_PAGE_SIZE, this.remainingRows);
  }
  admitWindow(): number {
    if (this.remainingWindows === 0 || this.remainingRows === 0) return 0;
    const limit = this.windowLimit();
    this.remainingRows -= limit;
    this.remainingWindows--;
    this.windows++;
    return limit;
  }
  result(
    status: ConceptStatementPrefixResult['status'],
    match: RelationFacetMatch = 'not_proven',
    complete = false,
  ): ConceptStatementPrefixResult {
    return { status, match, complete, windows: this.windows, examined: this.examined };
  }
  async finishStatus(status: ConceptStatementPrefixResult['status'], cuts: readonly ConceptStatementCut[]) {
    if (status === 'restart') {
      // Retirement is a revision CAS; repeated references to the same cut cannot revive it.
      for (const cut of cuts) await cut.store.retire(cut.state);
    }
    return this.result(status);
  }
  async revalidate(
    cuts: readonly ConceptStatementCut[],
  ): Promise<'current' | 'not_proven' | 'restart' | 'unavailable'> {
    let usable = true;
    // All retained I/O precedes every native revalidation, across all leaves.
    for (const { source, store, state } of cuts) {
      const current = await currentConceptMemberships(source, store, state, [state.selection.concept]);
      usable &&= current[0] === true;
    }
    for (const validate of this.validators) {
      const current = await validate();
      if (current === 'changed') return 'restart';
      if (current !== 'current') return 'unavailable';
    }
    return usable ? 'current' : 'not_proven';
  }
}

type ScannedConceptPrefix = Readonly<{
  status: ConceptStatementPrefixResult['status'];
  match: RelationFacetMatch;
  complete: boolean;
}>;

async function scanConceptStatementPrefix(
  reader: ConceptStatementReader,
  cut: ConceptStatementCut,
  partition: number,
  request: ConceptStatementRequest,
  attempt: ConceptStatementAttempt,
): Promise<ScannedConceptPrefix> {
  const { source, store, state: retained } = cut;
  const qualifiers = conceptStatementQualifiers(request);
  let cursor: ConceptStatementCursor | null = null;
  let prefix: string | undefined;
  let certified = true,
    terminal = false,
    matched = false,
    unknown = false;
  const result = (
    status: ScannedConceptPrefix['status'],
    match: RelationFacetMatch = 'not_proven',
    complete = false,
  ): ScannedConceptPrefix => ({ status, match, complete });
  while (true) {
    // Consume the full admitted raw window, including rejected rows and empty terminal seeks.
    const limit = attempt.admitWindow();
    if (limit === 0) break;
    const read = await reader(partition, request, cursor === null ? null : { ...cursor }, limit);
    if (read.status === 'changed') return result('restart');
    if (read.status !== 'current') return result(read.status);
    const page = structuredClone(read.page);
    if (
      !Array.isArray(page.statements) ||
      !Number.isSafeInteger(page.examined) ||
      page.examined < page.statements.length ||
      page.examined > limit ||
      page.terminal !== page.examined < limit ||
      (page.examined > 0 && page.after === null)
    )
      return result('restart');
    if (page.after !== null) {
      // Also admit empty terminal continuations before treating them as evidence.
      try {
        conceptStatementRequest(partition, request, page.after, limit);
      } catch {
        return result('restart');
      }
      if (
        cursor &&
        (page.after.observation !== cursor.observation ||
          (page.examined > 0 &&
            (page.after.slot < cursor.slot ||
              (page.after.slot === cursor.slot && page.after.candidate <= cursor.candidate))) ||
          (page.examined === 0 && (page.after.slot !== cursor.slot || page.after.candidate !== cursor.candidate)))
      )
        return result('restart');
    }
    if (page.readyPrefix === undefined) certified = false;
    else {
      if (
        !/^[0-9a-f]{64}$/.test(page.readyPrefix) ||
        (prefix !== undefined && page.readyPrefix !== prefix) ||
        (page.after !== null && page.readyPrefix !== page.after.observation)
      )
        return result('restart');
      prefix = page.readyPrefix;
    }
    attempt.examined += page.examined;
    const witnesses = await currentConceptStatementWitnesses(source, store, retained, {
      selection: request.selection,
      statements: page.statements.map((statement) => ({
        property: statement.property,
        concept: statement.value,
        witness: holdsCurrentStatements([statement], {
          facet: 'statement',
          property: request.selection.property,
          values: [statement.value],
          qualifiers,
        }),
      })),
    });
    // Window-local false evidence becomes predicate absence only after every window is
    // visited and every native witness is revalidated after the last membership read.
    if (witnesses === null) unknown = true;
    else {
      const local = currentConceptStatementsMatch(witnesses, true);
      matched ||= local === true;
      unknown ||= local === 'not_proven';
    }
    attempt.validators.push(() => read.revalidate());
    terminal = page.terminal;
    cursor = page.after;
    if (terminal) break;
  }
  if (unknown) return result('current');
  const complete = terminal && certified;
  return result('current', matched ? true : complete ? false : 'not_proven', complete);
}
