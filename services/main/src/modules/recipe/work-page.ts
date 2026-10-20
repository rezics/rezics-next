import { readHierarchyPage, type StructureWalkFrame } from '../structure/reading-order.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { fenceWorkBasis, readWorkBasis, structureRevisionDisclosureVisible } from '../work/read-header.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable }
  from '../work/read-session.ts';
import { CompositionUnavailable, compositionForMainVersion, readCompositionHeader }
  from '../structure/graph.ts';
import { readCompositionPage, readStructureMeasures, selectWorkCompositionRevision } from '../structure/read.ts';
import { STRUCTURE_LIMITS, type OccurrenceRecord, type RecipeMeasure } from '../structure/format.ts';
import { scaleIngredients } from './operations.ts';
import { exactRational, InexactQuantity, scaleExact, type ExactRational } from './quantity.ts';
import { compositionTargetReader } from '../composition/disclosure-read.ts';
import { structureProfileFor } from '../structure/profiles.ts';
import { isAdoptedInstruction, readRecipeInstructions } from './instructions.ts';

/** Occurrences returned by one Recipe work-page call. */
export const RECIPE_WORK_PAGE_OCCURRENCES = 100;
/** Per-page JSON ceiling. The aggregate hierarchy is not buffered, so this applies to one call. */
export const RECIPE_WORK_PAGE_BYTES = 1_048_576;
/** Opaque cursor, including its mac. Long enough for a depth-limited parent stack. */
export const RECIPE_WORK_PAGE_CURSOR_MAX = 8192;
/**
 * Reads in one call: one measure-manifest read, one re-read of each cursor
 * ancestor (at most {@link STRUCTURE_LIMITS.maxDepth}), and at most maxDepth + 1
 * child composition pages. Those child pages are spent filling depth-first
 * across sections, or confirming a frame is exhausted. That is
 * `1 + maxDepth + (maxDepth + 1)`.
 */
export const RECIPE_WORK_PAGE_READ_BOUND = 2 * STRUCTURE_LIMITS.maxDepth + 2;

/** Deepest cursor stack: the Structure root plus one frame per nesting level. */
const MAX_STACK = STRUCTURE_LIMITS.maxDepth + 1;
/**
 * Separates Recipe page cursors from the Fuseki maintenance capability.
 * The capability is the HMAC key Main and the relay already share; the derived
 * key is not that bearer and stays the same across processes.
 */
const RECIPE_CURSOR_DOMAIN = 'rezics-recipe-work-page-cursor-v1';

function recipeCursorKey(): Buffer {
  const capability = Bun.env.FUSEKI_MAINTENANCE_TOKEN;
  if (typeof capability !== 'string' || !/^[0-9a-f]{64}$/.test(capability)) {
    throw new WorkReadUnavailable('Recipe cursor signing secret is unavailable');
  }
  return createHmac('sha256', Buffer.from(capability, 'hex')).update(RECIPE_CURSOR_DOMAIN).digest();
}

type CursorFrame = StructureWalkFrame;
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
  return createHmac('sha256', recipeCursorKey()).update(body).digest('base64url');
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
 * One depth-first page of a pinned Recipe revision. The walk crosses sections
 * until {@link RECIPE_WORK_PAGE_OCCURRENCES} occurrences or {@link RECIPE_WORK_PAGE_READ_BOUND}.
 * Every page returns the measure manifest. A continuation keeps the servings factor
 * stored in the cursor and still reads that manifest once for the response.
 */
export async function readRecipeHierarchyPage(input: {
  structure: string;
  revision: string;
  servings?: number;
  measures?: readonly RecipeMeasure[];
  /** One manifest read for this page. Used by the route; unit fixtures may pass `measures` instead. */
  readMeasures?: () => Promise<{ measures: readonly RecipeMeasure[]; pagesRead: number }>;
  cursor?: string;
} & RecipeHierarchyRead) {
  let stack: StructureWalkFrame[];
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
    stack = [{ parent: input.structure }];
    pinnedServings = input.servings ?? null;
    factor = exactRational(1n, 1n);
  }
  let measures = [...(input.measures ?? [])];
  let measureReads = 0;
  let pagesRead = 0;
  if (input.readMeasures) {
    const measured = await input.readMeasures();
    measures = [...measured.measures];
    measureReads = 1;
    pagesRead += measured.pagesRead;
  }
  if (measures.length > STRUCTURE_LIMITS.measures) {
    throw new WorkReadUnavailable('Recipe measures exceed 64');
  }
  if (!input.cursor) factor = servingsFactor(measures, input.servings);
  const walked = await readHierarchyPage({ structure: input.structure,
    profile: structureProfileFor('recipe-composition'), stack,
    limit: RECIPE_WORK_PAGE_OCCURRENCES, childReadLimit: STRUCTURE_LIMITS.maxDepth + 1,
    readChildren: input.readChildren, readParent: input.readParent });
  const { occurrences, parentReads, emptyReads, dataReads } = walked;
  pagesRead += walked.pagesRead;
  const next = stack.length > 0 ? encodeCursor({ v: 1, structure: input.structure, revision: input.revision,
    servings: pinnedServings, factor, stack }) : undefined;
  let ingredients: ReturnType<typeof scaled>;
  let displayedMeasures: RecipeMeasure[];
  try {
    ingredients = scaled(occurrences, factor);
    // These are repeated observations, not ingredient totals. Keep each source
    // measure and its qualification; only whole-recipe nutrients follow servings.
    displayedMeasures = measures.map(measure => {
      if (measure.kind !== 'nutrient' || measure.basis !== 'whole-recipe'
        || factor.numerator === factor.denominator) return measure;
      const value = scaleExact(exactRational(BigInt(measure.value.numerator), BigInt(measure.value.denominator)), factor);
      return { ...measure, value: { numerator: Number(value.numerator), denominator: Number(value.denominator) } };
    });
  } catch (error) {
    if (error instanceof InexactQuantity) throw new WorkReadLimit('Scaled Recipe quantity exceeds its exact bound');
    throw error;
  }
  const result = { profile: 'recipe-work-page-v1' as const, structure: input.structure, revision: input.revision,
    occurrences, measures: displayedMeasures, ingredients, ...(next ? { next } : {}),
    cost: { pages: measureReads + parentReads + emptyReads + dataReads, pagesRead,
      occurrences: occurrences.length } };
  if (Buffer.byteLength(JSON.stringify(result)) > RECIPE_WORK_PAGE_BYTES) {
    throw new WorkReadLimit('Recipe page exceeds 1 MiB');
  }
  return result;
}

/** A private preview follows the live mapping and head, unlike a pinned public publication. */
export async function readRecipePreviewGrant(session: WorkReadSession, work: string) {
  return session.canPreviewWork(work);
}

export async function readRecipePreviewStructure(session: WorkReadSession, mainVersion: string) {
  const readStructure = () => compositionForMainVersion(session.deps.environment, mainVersion);
  const structure = await readStructure();
  session.observeDependency(`recipe-structure-mapping:${mainVersion}`, structure, readStructure);
  if (!structure) return null;
  const readHeader = () => readCompositionHeader(session.deps.environment, structure);
  const header = await readHeader();
  session.observeDependency(`recipe-structure-header:${structure}`, header, readHeader);
  return { structure, header };
}

/** One selected Recipe revision, at most {@link RECIPE_WORK_PAGE_OCCURRENCES} occurrences. */
export async function readRecipeWorkPage(session: WorkReadSession, work: string, servings?: number, cursor?: string,
  requestedRevision?: string) {
  if (servings !== undefined && (!Number.isInteger(servings) || servings < 1 || servings > 100)) {
    throw new WorkReadInvalid('Servings must be a whole number from 1 to 100');
  }
  const basis = await readWorkBasis(session, work);
  // Work basis already fences visibility. A non-Recipe cannot acquire a Recipe view.
  const readType = async () => !!(await session.deps.environment.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/Recipe> . } }`)).boolean;
  const isRecipe = await readType();
  session.observeDependency(`recipe-type:${work}`, isRecipe, readType);
  if (!isRecipe) { await fenceWorkBasis(session, basis); return null; }
  // A published Recipe follows its pin even when the reader can preview drafts.
  const hasPrivatePreview = !basis.structuredPublication && await readRecipePreviewGrant(session, work);
  if (!hasPrivatePreview && !basis.structuredPublication) {
    await fenceWorkBasis(session, basis);
    return null;
  }
  const selected = basis.structuredPublication;
  const preview = hasPrivatePreview ? await readRecipePreviewStructure(session, basis.card.mainVersion) : null;
  const structure = hasPrivatePreview ? preview?.structure : selected!.structure;
  if (!structure) { await fenceWorkBasis(session, basis); return null; }
  const header = hasPrivatePreview ? preview?.header : await readCompositionHeader(session.deps.environment, structure);
  if (!header || header.profile !== 'recipe-composition' || header.owner !== work
    || header.component !== basis.card.mainVersion
    || selected && selected.structureProfile !== `${RV}RecipeComposition`) {
    throw new WorkReadUnavailable('Recipe Structure differs from selected Work');
  }
  const revision = requestedRevision ?? (hasPrivatePreview ? header.head : selected!.structureRevision);
  if (requestedRevision) {
    // Explicit pins need the same live preview/publication authority as every
    // other Structure read before adopted dependencies can be hydrated.
    try { await selectWorkCompositionRevision(session, header, requestedRevision); }
    catch (error) {
      if (error instanceof CompositionUnavailable) throw new WorkReadMissing('Recipe is unavailable');
      throw error;
    }
  }
  if (!await structureRevisionDisclosureVisible(session, { work, workRevision: basis.card.revision,
    structure, revision })) {
    if (!hasPrivatePreview) {
      await fenceWorkBasis(session, basis);
      return null;
    }
    throw new WorkReadMissing('Recipe is unavailable');
  }
  const env = session.deps.environment;
  const canReadTarget = compositionTargetReader(session, structureProfileFor('recipe-composition'));
  const composition = (query: { parent?: string; occurrence?: string; after?: string; limit: number }) =>
    readCompositionPage(env, { structure, revision,
      ...(query.parent ? { parent: query.parent } : {}),
      ...(query.occurrence ? { occurrence: query.occurrence } : {}),
      ...(query.after ? { after: query.after } : {}),
      limit: query.limit, canReadTarget,
      canReadOccurrence: record => Promise.resolve(isAdoptedInstruction(record)) });
  const page = await readRecipeHierarchyPage({ structure, revision,
    ...(servings !== undefined ? { servings } : {}),
    ...(cursor ? { cursor } : {}),
    readMeasures: async () => {
      const measured = await readStructureMeasures(env, { structure, revision });
      return { measures: measured.measures, pagesRead: measured.cost.pagesRead };
    },
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
  const fence = async () => {
    await fenceWorkBasis(session, basis);
    if (!await structureRevisionDisclosureVisible(session, { work, workRevision: basis.card.revision,
      structure, revision })) throw new WorkReadMoved('Recipe Structure disclosure changed');
  };
  if (page.profile === 'recipe-work-page-stale') { await fence(); return page; }
  const result = { ...page, instructions: await readRecipeInstructions(session, page.occurrences, { work, revision, admitted: true }) };
  if (Buffer.byteLength(JSON.stringify(result)) > RECIPE_WORK_PAGE_BYTES) {
    throw new WorkReadLimit('Recipe page exceeds 1 MiB');
  }
  await fence();
  return result;
}
