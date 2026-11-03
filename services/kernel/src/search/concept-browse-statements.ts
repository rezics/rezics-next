import { parseFilter, type FilterQualifier, type SpoilerThreshold } from '@rezics/filter';
import { holdsCurrentStatements } from './current-leaf.ts';
import {
  matchCurrentConceptStatements,
  type ConceptBrowseSource,
  type ConceptBrowseState,
  type ConceptBrowseStore,
} from './concept-browse.ts';
import type { IndexedStatement, RelationFacetMatch } from './source.ts';
import { partitionOf, routeOf } from '../route/route.ts';

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
  /** Exhaustion is progress, never a native complete-absence proof. */
  complete: false;
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  const page = structuredClone(read.page);
  if (
    !Number.isSafeInteger(page.examined) ||
    page.examined < page.statements.length ||
    page.examined > limit ||
    page.complete !== false ||
    (!page.terminal && page.after === null)
  )
    return restart();
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
    complete: false,
  });
  const current = await read.revalidate();
  if (current === 'changed') return restart();
  if (current !== 'current') return { status: 'unavailable', match: 'not_proven' };
  return { status: 'current', match, page };
}
