import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadUnavailable } from '../work/read-session.ts';
import { CompositionUnavailable, compositionForMainVersion, orderTreeKey, readCompositionHeader }
  from '../structure/graph.ts';
import { readCompositionPage, readStructureMeasures } from '../structure/read.ts';
import { STRUCTURE_LIMITS, type OccurrenceRecord, type RecipeMeasure } from '../structure/format.ts';
import { scaleIngredients } from './operations.ts';
import { exactRational, type ExactRational } from './quantity.ts';

/** Occurrences returned by one Recipe work-page call. */
export const RECIPE_WORK_PAGE_OCCURRENCES = 100;
/** Per-page JSON ceiling. The aggregate hierarchy is not buffered, so this applies to one call. */
export const RECIPE_WORK_PAGE_BYTES = 1_048_576;
/** Opaque cursor, including its mac. Long enough for a depth-limited parent stack. */
export const RECIPE_WORK_PAGE_CURSOR_MAX = 8192;
/**
 * Composition reads in one call: one child page, plus one re-read of each
 * cursor ancestor (at most {@link STRUCTURE_LIMITS.maxDepth}), plus one empty
 * child page for each exhausted frame popped (at most maxDepth + 1, the root
 * plus that many groups). The first page also reads the measure manifest once.
 */
export const RECIPE_WORK_PAGE_READ_BOUND = 2 * STRUCTURE_LIMITS.maxDepth + 2;

/** Deepest cursor stack: the Structure root plus one frame per nesting level. */
const MAX_STACK = STRUCTURE_LIMITS.maxDepth + 1;
// Restart-local mac. A cursor is a continuation address, not an authorization grant.
const cursorKey = randomBytes(32);

interface CursorFrame { parent: string; after?: string }
interface RecipeCursor {
  v: 1;
  structure: string;
  revision: string;
  servings: number | null;
  factor: ExactRational;
  stack: CursorFrame[];
}

export interface RecipeWorkPageStale {
  profile: 'recipe-work-page-stale';
  structure: string;
  revision: string;
  cursorRevision: string;
}

interface ChildPage {
  occurrences: OccurrenceRecord[];
  next: string | null;
  pagesRead: number;
}

export interface RecipeHierarchyRead {
  readChildren(query: { parent: string; after?: string; limit: number }): Promise<ChildPage>;
  readParent(occurrence: string): Promise<{ record: OccurrenceRecord | null; pagesRead: number }>;
}

const invalidCursor = () => new WorkReadInvalid('Recipe cursor is invalid');

function macOf(body: string): string {
  return createHmac('sha256', cursorKey).update(body).digest('base64url');
}

function encodeCursor(cursor: RecipeCursor): string {
  const body = Buffer.from(JSON.stringify({
    v: cursor.v, structure: cursor.structure, revision: cursor.revision, servings: cursor.servings,
    factor: { n: cursor.factor.numerator.toString(), d: cursor.factor.denominator.toString() },
    stack: cursor.stack.map(frame => frame.after === undefined
      ? { parent: frame.parent } : { parent: frame.parent, after: frame.after }),
  })).toString('base64url');
  const token = `${body}.${macOf(body)}`;
  if (token.length > RECIPE_WORK_PAGE_CURSOR_MAX) throw new WorkReadLimit('Recipe cursor exceeds its bound');
  return token;
}

function decodeCursor(token: string, structure: string): RecipeCursor {
  if (token.length > RECIPE_WORK_PAGE_CURSOR_MAX || !/^[\w-]+\.[\w-]+$/.test(token)) throw invalidCursor();
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = macOf(body);
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw invalidCursor();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { throw invalidCursor(); }
  if (!parsed || typeof parsed !== 'object') throw invalidCursor();
  const record = parsed as Record<string, unknown>;
  const factor = record.factor as { n?: unknown; d?: unknown } | undefined;
  const stack = record.stack;
  if (record.v !== 1 || record.structure !== structure || typeof record.revision !== 'string'
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(record.revision)
    || (record.servings !== null && (typeof record.servings !== 'number' || !Number.isInteger(record.servings)
      || record.servings < 1 || record.servings > 100))
    || !factor || typeof factor.n !== 'string' || typeof factor.d !== 'string'
    || !/^[0-9]{1,16}$/.test(factor.n) || !/^[0-9]{1,16}$/.test(factor.d)
    || !Array.isArray(stack) || stack.length < 1 || stack.length > MAX_STACK) throw invalidCursor();
  const frames: CursorFrame[] = [];
  const seen = new Set<string>();
  for (const [index, frame] of stack.entries()) {
    if (!frame || typeof frame !== 'object') throw invalidCursor();
    const parent = (frame as { parent?: unknown }).parent;
    const after = (frame as { after?: unknown }).after;
    if (typeof parent !== 'string' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(parent)
      || seen.has(parent) || (index === 0 ? parent !== structure : parent === structure)
      || (after !== undefined && (typeof after !== 'string' || after.length > 512
        || !after.startsWith(`${parent}\u0001`)))) throw invalidCursor();
    seen.add(parent);
    frames.push(after === undefined ? { parent } : { parent, after });
  }
  try {
    return { v: 1, structure, revision: record.revision, servings: record.servings as number | null,
      factor: exactRational(BigInt(factor.n), BigInt(factor.d)), stack: frames };
  } catch { throw invalidCursor(); }
}

function servingsFactor(measures: readonly RecipeMeasure[], servings: number | undefined): ExactRational {
  const base = measures.find(item => item.kind === 'servings');
  if (servings !== undefined && (!base || base.value.numerator === 0)) {
    throw new WorkReadInvalid('Recipe has no scalable servings measure');
  }
  return base && servings !== undefined && base.value.numerator > 0
    ? exactRational(BigInt(servings) * BigInt(base.value.denominator), BigInt(base.value.numerator))
    : exactRational(1n, 1n);
}

function scaled(records: readonly OccurrenceRecord[], factor: ExactRational) {
  return scaleIngredients(records, factor).map(item => ({ ...item,
    ...(item.amount ? { amount: { numerator: Number(item.amount.numerator),
      denominator: Number(item.amount.denominator) } } : {}),
    ...(item.amountUpper ? { amountUpper: { numerator: Number(item.amountUpper.numerator),
      denominator: Number(item.amountUpper.denominator) } } : {}) }));
}

/**
 * One depth-first page of a pinned Recipe revision. See {@link RECIPE_WORK_PAGE_READ_BOUND}
 * for the composition-read ceiling. Measures are returned only when `cursor` is absent;
 * a continuation uses the factor stored in the cursor and does not read them again.
 */
export async function readRecipeHierarchyPage(input: {
  structure: string;
  revision: string;
  servings?: number;
  measures?: readonly RecipeMeasure[];
  cursor?: string;
} & RecipeHierarchyRead) {
  let stack: CursorFrame[];
  let factor: ExactRational;
  let pinnedServings: number | null;
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, input.structure);
    if (cursor.revision !== input.revision) {
      return { profile: 'recipe-work-page-stale' as const, structure: input.structure,
        revision: input.revision, cursorRevision: cursor.revision };
    }
    if (input.servings !== undefined && input.servings !== cursor.servings) {
      throw new WorkReadInvalid('Servings differ from the pinned recipe page');
    }
    stack = cursor.stack.map(frame => ({ ...frame }));
    factor = cursor.factor;
    pinnedServings = cursor.servings;
  } else {
    const measures = input.measures ?? [];
    if (measures.length > STRUCTURE_LIMITS.measures) {
      throw new WorkReadUnavailable('Recipe measures exceed 64');
    }
    stack = [{ parent: input.structure }];
    factor = servingsFactor(measures, input.servings);
    pinnedServings = input.servings ?? null;
  }
  let parentReads = 0;
  let emptyReads = 0;
  let dataReads = 0;
  let pagesRead = 0;
  const charge = (kind: 'parent' | 'empty' | 'data') => {
    if (kind === 'parent') parentReads += 1;
    else if (kind === 'empty') emptyReads += 1;
    else dataReads += 1;
    if (parentReads > STRUCTURE_LIMITS.maxDepth || emptyReads > STRUCTURE_LIMITS.maxDepth + 1 || dataReads > 1) {
      throw new WorkReadLimit('Recipe page exceeds its read bound');
    }
  };
  for (let index = 1; index < stack.length; index += 1) {
    charge('parent');
    const found = await input.readParent(stack[index]!.parent);
    pagesRead += found.pagesRead;
    const record = found.record;
    if (!record || record.state !== 'active' || record.role !== 'group'
      || record.parent !== stack[index - 1]!.parent) {
      throw new WorkReadUnavailable('Recipe cursor parent is not in this revision');
    }
  }
  const taken: OccurrenceRecord[] = [];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const page = await input.readChildren({ parent: frame.parent, ...(frame.after ? { after: frame.after } : {}),
      limit: RECIPE_WORK_PAGE_OCCURRENCES });
    pagesRead += page.pagesRead;
    if (page.occurrences.length === 0) {
      charge('empty');
      stack.pop();
      continue;
    }
    charge('data');
    const batch = page.occurrences.slice(0, RECIPE_WORK_PAGE_OCCURRENCES);
    let consumed = 0;
    let descended = false;
    for (const item of batch) {
      if (!item.segmentKey || !item.orderKey || item.parent !== frame.parent) {
        throw new WorkReadUnavailable('Recipe occurrence has no order');
      }
      consumed += 1;
      taken.push(item);
      frame.after = orderTreeKey({ parent: item.parent, segmentKey: item.segmentKey, orderKey: item.orderKey });
      if (item.state === 'active' && item.role === 'group') {
        if (stack.length > STRUCTURE_LIMITS.maxDepth) {
          throw new WorkReadUnavailable('Recipe sections exceed depth 16');
        }
        stack.push({ parent: item.occurrence });
        descended = true;
        break;
      }
      if (taken.length >= RECIPE_WORK_PAGE_OCCURRENCES) break;
    }
    const hasMore = page.next != null || page.occurrences.length > RECIPE_WORK_PAGE_OCCURRENCES;
    if (!descended && consumed === batch.length && !hasMore) stack.pop();
    break;
  }
  const occurrences = taken.filter(item => item.state === 'active');
  const next = stack.length > 0 ? encodeCursor({ v: 1, structure: input.structure, revision: input.revision,
    servings: pinnedServings, factor, stack }) : undefined;
  const result = { profile: 'recipe-work-page-v1' as const, structure: input.structure, revision: input.revision,
    occurrences, ...(input.cursor ? {} : { measures: [...(input.measures ?? [])] }),
    ingredients: scaled(occurrences, factor), ...(next ? { next } : {}),
    cost: { pages: parentReads + emptyReads + dataReads, pagesRead, occurrences: occurrences.length } };
  if (Buffer.byteLength(JSON.stringify(result)) > RECIPE_WORK_PAGE_BYTES) {
    throw new WorkReadLimit('Recipe page exceeds 1 MiB');
  }
  return result;
}

/** One selected Recipe revision, at most {@link RECIPE_WORK_PAGE_OCCURRENCES} occurrences. */
export async function readRecipeWorkPage(session: WorkReadSession, work: string, servings?: number, cursor?: string) {
  if (servings !== undefined && (!Number.isInteger(servings) || servings < 1 || servings > 100)) {
    throw new WorkReadInvalid('Servings must be a whole number from 1 to 100');
  }
  const basis = await readWorkBasis(session, work);
  // Work basis already fences visibility. A non-Recipe cannot acquire a Recipe view.
  const type = await session.deps.environment.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/Recipe> . } }`);
  if (!type.boolean) return null;
  const structure = await compositionForMainVersion(session.deps.environment, basis.card.mainVersion);
  if (!structure) return null;
  const header = await readCompositionHeader(session.deps.environment, structure);
  if (!header || header.profile !== 'recipe-composition' || header.owner !== work
    || header.component !== basis.card.mainVersion) {
    throw new WorkReadUnavailable('Recipe Structure differs from selected Work');
  }
  const measured = cursor ? null : await readStructureMeasures(session.deps.environment, { structure, revision: header.head });
  const env = session.deps.environment;
  const composition = (query: { parent?: string; occurrence?: string; after?: string; limit: number }) =>
    readCompositionPage(env, { structure, revision: header.head,
      ...(query.parent ? { parent: query.parent } : {}),
      ...(query.occurrence ? { occurrence: query.occurrence } : {}),
      ...(query.after ? { after: query.after } : {}),
      limit: query.limit, canReadTarget: async () => false });
  const page = await readRecipeHierarchyPage({ structure, revision: header.head,
    ...(servings !== undefined ? { servings } : {}),
    ...(measured ? { measures: measured.measures } : {}),
    ...(cursor ? { cursor } : {}),
    readChildren: async query => {
      const result = await composition({ parent: query.parent, ...(query.after ? { after: query.after } : {}),
        limit: query.limit });
      return { occurrences: result.occurrences, next: result.next, pagesRead: result.cost.pagesRead };
    },
    readParent: async occurrence => {
      try {
        const result = await composition({ occurrence, limit: 1 });
        return { record: result.occurrences[0] ?? null, pagesRead: result.cost.pagesRead };
      } catch (error) {
        if (error instanceof CompositionUnavailable) {
          throw new WorkReadUnavailable('Recipe cursor parent is not in this revision');
        }
        throw error;
      }
    } });
  if (page.profile === 'recipe-work-page-stale') {
    await fenceWorkBasis(session, basis);
    return page;
  }
  const result = measured ? { ...page, cost: { ...page.cost, pages: page.cost.pages + 1,
    pagesRead: page.cost.pagesRead + measured.cost.pagesRead } } : page;
  if (Buffer.byteLength(JSON.stringify(result)) > RECIPE_WORK_PAGE_BYTES) {
    throw new WorkReadLimit('Recipe page exceeds 1 MiB');
  }
  await fenceWorkBasis(session, basis);
  return result;
}
