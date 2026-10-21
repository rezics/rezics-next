import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { ExactInstructionSelector } from '../modules/structure/selection.ts';
import { isAdoptedInstruction, readRecipeInstructions } from '../modules/recipe/instructions.ts';
import { readContentDerivations, type DisclosedDerivation } from '../modules/content-publication/derivation.ts';
import { createHash } from 'node:crypto';
import type { Static, TSchema } from 'typebox';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { changeAdmittedComposition, changeAdmittedStructureMeasures }
  from '../modules/structure/change-admitted.ts';
import { CompositionConflict, InvalidCompositionChange, StaleCompositionHead }
  from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readCompositionPage, readStructureMeasures, selectWorkCompositionRevision } from '../modules/structure/read.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable }
  from '../modules/structure/tree.ts';
import { ingredientTextParts, InvalidStructureObject, RecipeMeasure, STRUCTURE_LIMITS, OccurrenceRecord }
  from '../modules/structure/format.ts';
import { checkRecipeMeasureReferences } from '../modules/recipe/fact-projection.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { AdmissionDenied, type VerifiedPrincipal } from '../modules/access/admission.ts';
import { DisclosureUnavailable } from '../modules/disclosure/read.ts';
import { structureRevisionDisclosureVisible } from '../modules/work/read-header.ts';
import { structureProfileFor } from '../modules/structure/profiles.ts';
import { calculateNutrition, scaleIngredients } from '../modules/recipe/operations.ts';
import { exactRational, InexactQuantity } from '../modules/recipe/quantity.ts';
import { importRecipe, recipeSourceSupportCandidates, type RecipeImport } from '../modules/recipe/importer.ts';
import { cancelRecipeFileBody, MAX_RECIPE_FILE_BYTES, parseRecipeFile, readRecipeFileBytes,
  RecipeFileInvalid, RecipeFileTooLarge } from '../modules/recipe/file-intake.ts';
import { RecipeSourceConversionInvalid, RecipeSourceConversionUnavailable,
  type RecipeSourceConversion }
  from '../modules/recipe/source-conversion.ts';
import { sourceFieldOccurrence } from '../modules/source/support-attach.ts';
import { FieldWithdrawalConflict, FieldWithdrawalInvalid, FieldWithdrawalUnavailable }
  from '../modules/source/withdrawal.ts';
import { exportRecipe, RecipeExportLimit, RECIPE_EXPORT_OCCURRENCE_LIMIT } from '../modules/recipe/export.ts';
import { readRecipeExportPage, RECIPE_EXPORT_PAGE_SIZE } from '../modules/recipe/export-page.ts';
import { readRecipeWorkPage, RECIPE_WORK_PAGE_CURSOR_MAX } from '../modules/recipe/work-page.ts';
import { readImportedExportBases } from '../modules/rights/read-imported.ts';
import { workRead, WorkReadUnavailable, type WorkReadSession } from '../modules/work/read-session.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { groupUuid } from './shared.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const rational = t.Object({ numerator: t.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
  denominator: t.Integer({ minimum: 1, maximum: 1_000_000_000_000 }) }, { additionalProperties: false });
const write = t.Object({ receipt: t.String(), replayed: t.Boolean(), structure: ref,
  revision: t.Optional(ref), occurrences: t.Optional(t.Array(ref)),
  cost: t.Optional(t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(),
    placementsWritten: t.Integer(), segmentsWritten: t.Integer(), rebalanced: t.Integer() })),
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }) });
const problems = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500), 503: problemResult(503) };
const nutritionBody = t.Object({ basis: t.Union([t.Literal('per-serving'), t.Literal('whole-recipe')]),
  inputs: t.Array(t.Object({
    coverage: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')]),
    values: t.Array(t.Object({ nutrient: t.String({ minLength: 1, maxLength: 2048 }),
      unit: t.String({ minLength: 1, maxLength: 2048 }), amount: rational },
    { additionalProperties: false }), { maxItems: 64 }) }, { additionalProperties: false }), { maxItems: 512 }) },
{ additionalProperties: false });
const nativeNutrientMeasure = t.Object({ ...RecipeMeasure.properties,
  kind: t.Literal('nutrient'),
  ...t.Required(t.Pick(RecipeMeasure, ['nutrient', 'unit'])).properties,
}, { additionalProperties: false });
const storedNutritionBody = t.Object({
  expectedHead: ref, actingSubject: ref,
  yield: t.Object({ value: rational, unit: t.Optional(t.String({ format: 'uri', maxLength: 2048 })),
    unitText: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
    coverage: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')]),
    provenance: t.Union([t.Literal('declared'), t.Literal('source-stated')]),
    evidence: t.Optional(t.String({ format: 'uri', maxLength: 2048 })) }, { additionalProperties: false }),
  servings: t.Optional(t.Object({ value: rational,
    coverage: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')]),
    provenance: t.Union([t.Literal('declared'), t.Literal('source-stated')]),
    evidence: t.Optional(t.String({ format: 'uri', maxLength: 2048 })) }, { additionalProperties: false })),
  /** Omitted keeps the nutrient measures stored at `expectedHead`; supplied replaces them. */
  nutrition: t.Optional(t.Object({ basis: t.Union([t.Literal('per-serving'), t.Literal('whole-recipe')]),
    inputs: t.Array(t.Object({
      coverage: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')]),
      values: t.Array(t.Object({ nutrient: t.String({ format: 'uri', maxLength: 2048 }),
        unit: t.String({ format: 'uri', maxLength: 2048 }), amount: rational },
      { additionalProperties: false }), { maxItems: 64 }) }, { additionalProperties: false }),
    { maxItems: 512 }) }, { additionalProperties: false })),
  /** Omitted preserves nutrients; [] clears them. Native rows and calculation inputs are exclusive. */
  nutrients: t.Optional(t.Array(nativeNutrientMeasure, { maxItems: STRUCTURE_LIMITS.measures })),
}, { additionalProperties: false });
const timing = t.Object({ value: rational, unit: t.Optional(t.String({ format: 'uri', maxLength: 2048 })),
  unitText: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  coverage: t.Optional(t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('unknown')])),
  provenance: t.Optional(t.Union([t.Literal('declared'), t.Literal('source-stated')])),
  evidence: t.Optional(t.String({ format: 'uri', maxLength: 2048 })) }, { additionalProperties: false });
/** Each key omitted keeps the stored timing; `null` clears it; an object replaces it. */
const timingsBody = t.Object({ expectedHead: ref, actingSubject: ref,
  preparation: t.Optional(t.Nullable(timing)), cooking: t.Optional(t.Nullable(timing)),
  total: t.Optional(t.Nullable(timing)) }, { additionalProperties: false });
const timingKinds = [['preparation', 'preparation-duration'], ['cooking', 'cooking-duration'],
  ['total', 'total-duration']] as const;
const importBody = t.Object({ sourceObservation: ref, expectedHead: ref, actingSubject: ref },
  { additionalProperties: false });
const recipeFileImportResponse = t.Object({ structure: ref, revision: ref, sourceObservation: ref,
  residualDigest: t.String({ pattern: '^[0-9a-f]{64}$' }), replayed: t.Boolean(),
  receipts: t.Array(t.String()), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }, { additionalProperties: false }) },
{ additionalProperties: false });
const recipeExportStep = t.Object({ '@type': t.Literal('HowToStep'), text: t.String(), inLanguage: t.Optional(t.String()),
  sourceKey: t.Optional(t.String()) }, { additionalProperties: false });
function recipeExportInstruction(depth = 0): TSchema {
  if (depth >= 16) return recipeExportStep;
  return t.Union([recipeExportStep, t.Object({ '@type': t.Literal('HowToSection'), name: t.String(),
    inLanguage: t.Optional(t.String()),
    itemListElement: t.Array(recipeExportInstruction(depth + 1), { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
    sourceKey: t.Optional(t.String()) }, { additionalProperties: false })]);
}
const exportRights = t.Array(t.Object({ basisKind: t.String(), basisRef: t.Nullable(t.String()),
  licenseExpression: t.Nullable(t.String()), notice: t.Nullable(t.String()), obligations: t.Array(t.String()),
  useScope: t.String(), result: t.String(), memberOrdinals: t.Array(t.Integer()) }, { additionalProperties: false }));
const recipeExportResponse = t.Object({
  rights: t.Optional(exportRights),
  profile: t.Literal('recipe-schema-org-export-v1'),
  structure: ref,
  revision: ref,
  recipe: t.Object({
    '@context': t.Literal('https://schema.org'),
    '@type': t.Literal('Recipe'),
    recipeIngredient: t.Array(t.Union([t.String(), t.Object({
      '@type': t.Literal('PropertyValue'), text: t.String({ maxLength: 1000 }),
      name: t.Optional(t.String({ maxLength: 1000 })), value: t.Optional(t.String()),
      maxValue: t.Optional(t.String()),
      amountLexical: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      textParts: t.Optional(ingredientTextParts), optional: t.Optional(t.Literal(true)),
      parseStatus: t.Union([t.Literal('parsed'), t.Literal('partial'), t.Literal('unparsed')]),
      unitCode: t.Optional(t.String()), unitText: t.Optional(t.String()), inLanguage: t.String(),
    }, { additionalProperties: false })]), { maxItems: 2 * RECIPE_EXPORT_OCCURRENCE_LIMIT }),
    recipeInstructions: t.Array(recipeExportInstruction(), { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
  }, { additionalProperties: false }),
  residuals: t.Array(t.Object({ sourceKey: t.Nullable(t.String()), text: t.String(),
    parseStatus: t.Union([t.Literal('partial'), t.Literal('unparsed')]),
    residual: t.Nullable(t.String()) }, { additionalProperties: false }),
  { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
  losses: t.Optional(t.Array(t.Object({ occurrence: ref, pointer: t.String(), code: t.Union([
    t.Literal('instruction-form-unsupported'), t.Literal('reference-not-representable'),
    t.Literal('derivation-not-representable'), t.Literal('measurement-not-representable'),
  ]) }, { additionalProperties: false }))),
  sourceObservations: t.Array(t.String(), { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
  importability: t.Union([
    t.Object({ status: t.Literal('importable') }, { additionalProperties: false }),
    t.Object({ status: t.Literal('not-importable'), code: t.Literal('recipe_not_importable'),
      limit: t.Union([t.Literal('occurrences'), t.Literal('bytes'), t.Literal('depth'), t.Literal('section-depth')]),
      measured: t.Integer({ minimum: 0 }), allowed: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    t.Object({ status: t.Literal('not-importable'), code: t.Literal('recipe_unit_not_registered'),
      unit: t.String() }, { additionalProperties: false }),
  ]),
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() },
    { additionalProperties: false }),
  cost: t.Object({ pages: t.Integer(), pagesRead: t.Integer(), occurrences: t.Integer() },
    { additionalProperties: false }),
}, { additionalProperties: false });

const instructionRead = t.Object({ occurrence: ref,
  reference: t.Object({ target: t.String(), selector: ExactInstructionSelector }),
  status: t.Union([t.Literal('available'), t.Literal('unavailable')]),
  document: t.Optional(t.Any()), text: t.Optional(t.String()), mediaUse: t.Optional(t.String()) },
{ additionalProperties: false });
const nativeRecipeExport = t.Object({ format: t.Literal('native'), structure: ref, revision: ref,
  rights: t.Optional(exportRights),
  occurrences: t.Array(OccurrenceRecord, { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
  measures: t.Array(RecipeMeasure, { maxItems: STRUCTURE_LIMITS.measures }),
  contents: t.Array(t.Object({ reference: t.Object({ target: t.String(), selector: ExactInstructionSelector }),
    document: t.Optional(t.Any()), body: t.Optional(t.String()) }, { additionalProperties: false }),
  { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
  // Content owns its independently versioned derivation records and opaque projection payloads.
  derivations: t.Array(t.Any(), { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT * 20 }),
  instructions: t.Array(instructionRead, { maxItems: RECIPE_EXPORT_OCCURRENCE_LIMIT }),
  losses: t.Array(t.Any(), { maxItems: 0 }),
}, { additionalProperties: false });
const recipeExportPageResponse = t.Object({ profile: t.Literal('recipe-export-page-v1'),
  structure: ref, revision: ref, parent: ref, next: t.Nullable(t.String()),
  occurrences: t.Array(OccurrenceRecord, { maxItems: RECIPE_EXPORT_PAGE_SIZE }),
  instructions: t.Array(instructionRead, { maxItems: RECIPE_EXPORT_PAGE_SIZE }),
  contents: t.Array(t.Object({ reference: t.Object({ target: t.String(), selector: ExactInstructionSelector }),
    document: t.Optional(t.Any()), body: t.Optional(t.String()) }, { additionalProperties: false }), { maxItems: RECIPE_EXPORT_PAGE_SIZE }),
  parts: t.Array(t.Object({ occurrence: ref, parent: ref, group: t.Boolean(), adopted: t.Boolean(),
    ingredient: t.Optional(t.Record(t.String(), t.Unknown())), instructions: t.Array(t.Record(t.String(), t.Unknown())),
    residuals: t.Array(t.Unknown()), sourceObservations: t.Array(t.String()),
    losses: t.Array(t.Object({ occurrence: ref, code: t.String(), pointer: t.String() })),
    unsupportedUnit: t.Optional(t.String()) }, { additionalProperties: false }), { maxItems: RECIPE_EXPORT_PAGE_SIZE }),
  measures: t.Array(RecipeMeasure, { maxItems: STRUCTURE_LIMITS.measures }), rights: exportRights,
  importLimits: t.Object({ bytes: t.Integer(), occurrences: t.Integer(), depth: t.Integer() }),
  cost: t.Object({ pagesRead: t.Integer(), occurrences: t.Integer() }) }, { additionalProperties: false });
const exportContinuationQuery = { page: t.Optional(t.Boolean()), parent: t.Optional(ref),
  after: t.Optional(t.String({ maxLength: 2048 })) };
const selectedRecipeExport = t.Union([recipeExportPageResponse, nativeRecipeExport,
  t.Omit(recipeExportResponse, ['sourcePosition', 'cost'])]);

export const openApiOperations = {
  '/v1/recipes/works/{id}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/recipes/{id}/measures': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true }, get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/{id}/timings': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/recipes/{id}/scalings': { post: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/{id}/imports': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/recipes/{id}/file-imports': { post: { rateLimitFamily: 'upload', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/recipes/{id}/exports/schema-org': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/{id}/export': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/nutrition': { post: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
} as const;

function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

class RecipeImportPending extends Error {}

function checkMeasureReferences(measures: readonly RecipeMeasure[]): void {
  try { checkRecipeMeasureReferences(measures); }
  catch (error) {
    if (error instanceof InvalidStructureObject) throw new InvalidCompositionChange(error.message);
    throw error;
  }
}

function routeError(error: unknown): Response {
  if (error instanceof RecipeImportPending) {
    return problem(503, 'recipe_import_pending', 'Recipe import is pending');
  }
  if (error instanceof RecipeFileInvalid) return problem(422, 'invalid_recipe_file', error.message);
  if (error instanceof RecipeFileTooLarge) return problem(413, 'recipe_file_too_large', 'Recipe file exceeds 256 KiB');
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_recipe_change', error.message);
  if (error instanceof InexactQuantity) return problem(400, 'invalid_recipe_quantity', error.message);
  if (error instanceof RecipeSourceConversionInvalid || error instanceof FieldWithdrawalInvalid) {
    return problem(400, 'invalid_recipe_source_support', error.message);
  }
  if (error instanceof FieldWithdrawalConflict) return problem(409, 'recipe_source_support_conflict', error.message);
  if (error instanceof RecipeSourceConversionUnavailable || error instanceof FieldWithdrawalUnavailable) {
    return problem(503, 'recipe_source_support_unavailable', error.message);
  }
  if (error instanceof DisclosureUnavailable) return problem(503, 'recipe_unavailable', 'Recipe disclosure is unavailable');
  if (error instanceof RecipeExportLimit) return problem(413, 'recipe_export_too_large', error.message);
  if (error instanceof CompositionUnavailable) return problem(404, 'recipe_unavailable', 'Recipe is unavailable');
  if (error instanceof StaleCompositionHead || error instanceof CompositionConflict) {
    return problem(409, 'recipe_conflict', error.message);
  }
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) {
    return problem(503, 'recipe_unavailable', 'Recipe history is unavailable');
  }
  return workReadError(error);
}

async function withAuthorizedRecipeRevision<T>(work: MainWorkDependencies, request: Request, input: {
  structure: string; actingSubject: string; revision?: string; parent?: string; after?: string; limit: number;
}, read: (principal: VerifiedPrincipal, revision: string, session: WorkReadSession) => Promise<T>): Promise<T> {
  await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
  await work.account.verify(request, ['work:read']);
  return workRead(work, request, { actingSubject: input.actingSubject, localBasis: true }, async session => {
    const principal = session.principal!;
    const header = await readCompositionHeader(work.environment, input.structure);
    if (!header || header.profile !== 'recipe-composition'
      || !await work.access.canReadWork(principal, input.actingSubject, header.owner)) {
      throw new CompositionUnavailable('Recipe is unavailable');
    }
    const revision = await selectWorkCompositionRevision(session, header, input.revision);
    const visible = () => structureRevisionDisclosureVisible(session,
      { work: header.owner, structure: input.structure, revision });
    if (!await visible()) throw new CompositionUnavailable('Recipe is unavailable');
    const result = await read(principal, revision, session);
    if (!await visible()) throw new CompositionUnavailable('Recipe is unavailable');
    return result;
  });
}

async function readPage(work: MainWorkDependencies, request: Request, input: {
  structure: string; actingSubject: string; revision?: string; parent?: string; after?: string; limit: number;
}) {
  return withAuthorizedRecipeRevision(work, request, input, (principal, revision) =>
    readCompositionPage(work.environment, { structure: input.structure, revision,
      ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
      limit: input.limit, canReadTarget: target => NATIVE_ID.test(target)
        ? work.access.canReadWork(principal, input.actingSubject, target) : Promise.resolve(false),
      canReadOccurrence: record => Promise.resolve(isAdoptedInstruction(record)) }));
}

async function allOccurrences(work: MainWorkDependencies, request: Request, structure: string,
  actingSubject: string, revision: string,
  limitError: new (message: string) => Error = CompositionConflict,
  limitMessage = `recipe calculation exceeds ${RECIPE_EXPORT_OCCURRENCE_LIMIT} occurrences`): Promise<{ records: OccurrenceRecord[];
    pages: number; pagesRead: number }> {
  const records: OccurrenceRecord[] = [];
  let pages = 0;
  let pagesRead = 0;
  const parents = [structure];
  for (let i = 0; i < parents.length; i++) {
    let after: string | undefined;
    do {
      const page = await readPage(work, request, { structure, actingSubject,
        revision, parent: parents[i], ...(after ? { after } : {}), limit: 100 });
      pages++;
      pagesRead += page.cost.pagesRead;
      records.push(...page.occurrences);
      after = page.next ?? undefined;
      for (const occurrence of page.occurrences) {
        if (occurrence.state === 'active' && occurrence.role === 'group') parents.push(occurrence.occurrence);
      }
      if (records.length > RECIPE_EXPORT_OCCURRENCE_LIMIT) throw new limitError(limitMessage);
    } while (after);
  }
  await withAuthorizedRecipeRevision(work, request, { structure, actingSubject, revision, limit: 1 },
    async () => undefined);
  return { records, pages, pagesRead };
}

const durationKinds: ReadonlySet<string> = new Set(timingKinds.map(([, kind]) => kind));

interface RecipeImportWrite {
  expectedHead: string;
  receipts: string[];
  sourcePosition?: { datasetId: 'product'; dataEpoch: string; sequence: string };
  importedOccurrences: Map<string, string>;
}

/** Shared idempotent Structure writes for both retained observations and direct Recipe files. */
async function writeRecipeImport(work: MainWorkDependencies, request: Request, input: {
  structure: string; expectedHead: string; actingSubject: string;
  idempotencyKey: string; parsed: RecipeImport;
}): Promise<RecipeImportWrite> {
  let expectedHead = input.expectedHead;
  const receipts: string[] = [];
  let sourcePosition: RecipeImportWrite['sourcePosition'];
  const groups = new Map<number, string>();
  const importedOccurrences = new Map<string, string>();
  const parentOf = (section: number) => {
    if (section < 0) return input.structure;
    const parent = groups.get(section);
    if (!parent) throw new CompositionCorrupt('recipe import parent is unavailable');
    return parent;
  };
  const stepOperation = (item: RecipeImport['steps'][number]) => ({ op: 'insert' as const,
    parent: parentOf(item.section), position: 'last' as const, role: 'step' as const,
    qualifier: { type: 'recipe-step' as const,
      instructionText: { value: item.text, language: item.language },
      usesIngredient: [], media: [], scaling: 'linear' as const }, sourceKey: item.sourceKey });
  // Flat imports retain their existing write/replay batches. Nested or interleaved
  // layout needs preorder writes so a step keeps its position among sibling groups.
  const orderedLayout = input.parsed.sections.some(section => section.parent >= 0
    || input.parsed.steps.some(step => step.section === section.parent && step.order < section.order));
  const instructions = [
    ...input.parsed.sections.map((section, index) => ({ kind: 'group' as const, index,
      parent: section.parent, order: section.order, sourceKey: section.sourceKey })),
    ...(orderedLayout ? input.parsed.steps.map(step => ({ kind: 'step' as const, step,
      parent: step.section, order: step.order, sourceKey: step.sourceKey })) : []),
  ].sort((left, right) => left.order - right.order);
  for (let offset = 0, batchIndex = 0; offset < instructions.length; batchIndex++) {
    const pending = instructions.slice(offset, offset + 16);
    // Structure assigns occurrence IDs; children wait for their parent's receipt.
    const unresolved = pending.findIndex(item => item.parent >= 0 && !groups.has(item.parent));
    const batch = unresolved < 0 ? pending : pending.slice(0, unresolved);
    if (!batch.length) throw new CompositionCorrupt('recipe import parent is unavailable');
    const result = await changeAdmittedComposition(work.environment, work.account, work.access,
      request, { structure: input.structure, expectedHead, actingSubject: input.actingSubject,
        idempotencyKey: `${input.idempotencyKey}.groups.${batchIndex}`,
        operations: batch.map(item => item.kind === 'step' ? stepOperation(item.step) : ({
          op: 'insert' as const, parent: parentOf(item.parent),
          position: 'last' as const, role: 'group' as const,
          label: { value: input.parsed.sections[item.index]!.label,
            language: input.parsed.sections[item.index]!.language },
          sourceKey: item.sourceKey })) });
    if (!result.revision) throw new RecipeImportPending();
    const remember = (index: number, occurrence: string) => {
      const item = batch[index]!;
      if (item.kind === 'group') groups.set(item.index, occurrence);
      else importedOccurrences.set(item.sourceKey, occurrence);
    };
    if (result.occurrences?.length === batch.length) {
      result.occurrences.forEach((occurrence, index) => remember(index, occurrence));
    } else {
      const { records } = await allOccurrences(work, request, input.structure,
        input.actingSubject, result.revision);
      for (const [index, item] of batch.entries()) {
        const matches = records.filter(record => record.state === 'active' && record.role === item.kind
          && record.parent === parentOf(item.parent) && record.sourceKey === item.sourceKey);
        if (matches.length !== 1) throw new CompositionCorrupt('recipe import occurrence is unavailable');
        remember(index, matches[0]!.occurrence);
      }
    }
    offset += batch.length;
    expectedHead = result.revision;
    receipts.push(result.receipt);
    sourcePosition = { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence };
  }
  const operations = [
    ...input.parsed.ingredients.map(item => ({ op: 'insert' as const, parent: input.structure,
      position: 'last' as const, role: 'ingredient' as const,
      qualifier: { ...item.qualifier,
        ...(item.qualifier.parseStatus !== 'parsed'
          ? { residual: `sha256:${input.parsed.residual}` } : {}) },
      sourceKey: item.sourceKey })),
    ...(orderedLayout ? [] : input.parsed.steps.map(stepOperation)),
  ];
  for (let offset = 0; offset < operations.length; offset += 16) {
    const result = await changeAdmittedComposition(work.environment, work.account, work.access,
      request, { structure: input.structure, expectedHead, actingSubject: input.actingSubject,
        idempotencyKey: `${input.idempotencyKey}.content.${offset / 16}`,
        operations: operations.slice(offset, offset + 16) });
    if (!result.revision) throw new RecipeImportPending();
    if (result.occurrences?.length === Math.min(16, operations.length - offset)) {
      result.occurrences.forEach((occurrence, index) => {
        importedOccurrences.set(operations[offset + index]!.sourceKey, occurrence);
      });
    }
    expectedHead = result.revision;
    receipts.push(result.receipt);
    sourcePosition = { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence };
  }
  return { expectedHead, receipts, sourcePosition, importedOccurrences };
}

/**
 * The measures stored at `head`, for an edit that keeps what it does not supply. The caller's
 * authority over this exact Recipe is proved first, through the same Access policy the write is
 * admitted under (`recipe.edit` on `work:edit:<owner>` as `actingSubject`), so nothing stored, and no
 * error derived from it, reaches anyone who may not edit the Recipe. The write revalidates it.
 */
async function storedMeasures(work: MainWorkDependencies, request: Request, structure: string,
  actingSubject: string, head: string): Promise<RecipeMeasure[]> {
  await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
  const principal = await work.account.verify(request, ['work:edit']);
  const header = await readCompositionHeader(work.environment, structure);
  if (!header || header.profile !== 'recipe-composition') throw new CompositionUnavailable('Recipe is unavailable');
  const profile = structureProfileFor('recipe-composition');
  if (!work.access.assertAuthority) throw new AdmissionDenied('Recipe edit authority is unavailable');
  await work.access.assertAuthority({ principal, actingSubject, action: profile.editAction,
    scope: `${profile.editScopePrefix}${header.owner}` });
  return (await readStructureMeasures(work.environment, { structure, revision: head })).measures;
}

export function recipeRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  if (work.structureObjects) (work.environment as typeof work.environment
    & { structureObjects?: typeof work.structureObjects }).structureObjects = work.structureObjects;
  return new Elysia()
    .get('/v1/recipes/works/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref),
        revision: t.Optional(ref),
        servings: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: RECIPE_WORK_PAGE_CURSOR_MAX })) },
      { additionalProperties: false }),
      detail: { security: [{}, { bearerAuth: [] }] },
      response: transportResponses(openApiOperations["/v1/recipes/works/{id}"].get, { 200: t.Nullable(t.Object({ profile: t.Literal('recipe-work-page-v1'), structure: ref,
        revision: ref, occurrences: t.Array(OccurrenceRecord),
        measures: t.Array(RecipeMeasure),
        instructions: t.Optional(t.Array(instructionRead)),
        ingredients: t.Array(t.Object({ occurrence: ref, originalText: t.String(),
          sourceLexical: t.Optional(t.String()), amount: t.Optional(rational),
          amountUpper: t.Optional(rational), unitText: t.Optional(t.String()), scaled: t.Boolean(),
          reason: t.Optional(t.Union([t.Literal('unparsed'), t.Literal('non-linear'),
            t.Literal('not-scalable')])),
          line: t.String({ maxLength: 2000 }),
          alternateLine: t.Optional(t.String({ maxLength: 2000 })),
          alternateSystem: t.Optional(t.Union([t.Literal('us'), t.Literal('metric')])),
          hint: t.Optional(t.String({ maxLength: 1000 })),
          judgment: t.Optional(t.Union([t.Literal('seasoning'), t.Literal('leavening')])) },
        { additionalProperties: false })),
        next: t.Optional(t.String({ minLength: 1, maxLength: RECIPE_WORK_PAGE_CURSOR_MAX })),
        cost: t.Object({ pages: t.Integer(), pagesRead: t.Integer(), occurrences: t.Integer() }) })),
      ...workReadProblems,
      409: t.Union([problemResult(409), t.Object({ profile: t.Literal('recipe-work-page-stale'),
        structure: ref, revision: ref, cursorRevision: ref }, { additionalProperties: false })]) }, 'GET') },
    async ({ request, params, query }) => {
      try {
        const body = await workRead(work, request, { actingSubject: query.actingSubject },
          session => readRecipeWorkPage(session, `https://rezics.com/id/${params.id}`, query.servings, query.cursor, query.revision));
        const stale = body !== null && typeof body === 'object' && 'profile' in body
          && body.profile === 'recipe-work-page-stale';
        return Response.json(body, { status: stale ? 409 : 200, headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return workReadError(error); }
    })
    .post('/v1/recipes/:id/measures', { params: t.Object({ id: groupUuid }),
      body: storedNutritionBody, response: transportResponses(openApiOperations["/v1/recipes/{id}/measures"].post, { 200: write, 202: problemResult(202), ...problems }, 'POST') },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: Static<typeof storedNutritionBody> }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        if (body.nutrition !== undefined && body.nutrients !== undefined) {
          return problem(400, 'invalid_recipe_measure', 'Supply native nutrients or nutrition calculation inputs');
        }
        if (!body.yield.unit && !body.yield.unitText) {
          return problem(400, 'invalid_recipe_measure', 'Yield requires a unit or unitText');
        }
        if (body.servings?.value.numerator === 0) {
          return problem(400, 'invalid_recipe_measure', 'Servings must be positive');
        }
        const structure = `https://rezics.com/id/${params.id}`;
        const stored = await storedMeasures(work, request, structure, body.actingSubject, body.expectedHead);
        const nutrition = body.nutrition ? calculateNutrition(body.nutrition.inputs.map(input => ({
          coverage: input.coverage, values: input.values.map(value => ({
            nutrient: value.nutrient, unit: value.unit,
            amount: { numerator: BigInt(value.amount.numerator),
              denominator: BigInt(value.amount.denominator) },
          })),
        })), body.nutrition.basis) : null;
        const kept = stored.filter(item => durationKinds.has(item.kind)
          || !nutrition && body.nutrients === undefined && item.kind === 'nutrient');
        const reduced = (value: { numerator: number; denominator: number }) => {
          const result = exactRational(BigInt(value.numerator), BigInt(value.denominator));
          return { numerator: Number(result.numerator), denominator: Number(result.denominator) };
        };
        const measures: RecipeMeasure[] = [
          { kind: 'yield', value: reduced(body.yield.value), basis: 'whole-recipe',
            coverage: body.yield.coverage, provenance: body.yield.provenance,
            ...(body.yield.unit ? { unit: body.yield.unit } : {}),
            ...(body.yield.unitText ? { unitText: body.yield.unitText } : {}),
            ...(body.yield.evidence ? { evidence: body.yield.evidence } : {}) },
          ...(body.servings ? [{ kind: 'servings' as const, value: reduced(body.servings.value),
            unitText: 'servings', basis: 'whole-recipe' as const, coverage: body.servings.coverage,
            provenance: body.servings.provenance,
            ...(body.servings.evidence ? { evidence: body.servings.evidence } : {}) }] : []),
          ...(nutrition?.nutrients.map(item => ({ kind: 'nutrient' as const,
            nutrient: item.nutrient, unit: item.unit,
            value: { numerator: Number(item.amount.numerator), denominator: Number(item.amount.denominator) },
            basis: nutrition.basis, coverage: nutrition.coverage,
            provenance: 'computed' as const })) ?? []),
          ...(body.nutrients ?? []),
          ...kept,
        ];
        if (measures.length > STRUCTURE_LIMITS.measures) {
          return problem(400, 'invalid_recipe_measure', 'Recipe has too many distinct measures');
        }
        checkMeasureReferences(measures);
        const result = await changeAdmittedStructureMeasures(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey, measures });
        return Response.json({ structure: result.structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          ...(result.cost ? { cost: result.cost } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/recipes/:id/timings', { params: t.Object({ id: groupUuid }),
      body: timingsBody, response: transportResponses(openApiOperations["/v1/recipes/{id}/timings"].post, { 200: write, 202: problemResult(202), ...problems }, 'POST') },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: Static<typeof timingsBody> }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        if (timingKinds.every(([name]) => body[name] === undefined)) {
          return problem(400, 'invalid_recipe_measure', 'A timing edit names at least one timing');
        }
        const structure = `https://rezics.com/id/${params.id}`;
        const stored = await storedMeasures(work, request, structure, body.actingSubject, body.expectedHead);
        const measures: RecipeMeasure[] = [...stored];
        for (const [name, kind] of timingKinds) {
          const edit = body[name];
          if (edit === undefined) continue;
          const at = measures.findIndex(item => item.kind === kind);
          if (at >= 0) measures.splice(at, 1);
          if (edit === null) continue;
          if (!edit.unit && !edit.unitText) {
            return problem(400, 'invalid_recipe_measure', 'A timing requires a unit or unitText');
          }
          const value = exactRational(BigInt(edit.value.numerator), BigInt(edit.value.denominator));
          measures.push({ kind, value: { numerator: Number(value.numerator), denominator: Number(value.denominator) },
            basis: 'whole-recipe', coverage: edit.coverage ?? 'complete', provenance: edit.provenance ?? 'declared',
            ...(edit.unit ? { unit: edit.unit } : {}), ...(edit.unitText ? { unitText: edit.unitText } : {}),
            ...(edit.evidence ? { evidence: edit.evidence } : {}) });
        }
        if (measures.length > STRUCTURE_LIMITS.measures) {
          return problem(400, 'invalid_recipe_measure', 'Recipe has too many distinct measures');
        }
        checkMeasureReferences(measures);
        const result = await changeAdmittedStructureMeasures(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey, measures });
        return Response.json({ structure: result.structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          ...(result.cost ? { cost: result.cost } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/recipes/:id/measures', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/recipes/{id}/measures"].get, { 200: t.Object({ structure: ref, owner: ref, revision: ref,
        predecessor: t.Nullable(ref), measures: t.Array(RecipeMeasure),
        sourcePosition: t.Any(), cost: t.Any() }), ...authorizedReadProblems }, 'GET') },
    async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const result = await withAuthorizedRecipeRevision(work, request, { structure,
          actingSubject: query.actingSubject, ...(query.revision ? { revision: query.revision } : {}), limit: 1 },
        (_principal, revision) => readStructureMeasures(work.environment, { structure, revision }));
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/recipes/:id/scalings', { params: t.Object({ id: groupUuid }),
      body: t.Object({ actingSubject: ref, factor: rational }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/recipes/{id}/scalings"].post, { 200: t.Object({ structure: ref, revision: ref, factor: rational,
        ingredients: t.Array(t.Any()), sourcePosition: t.Any(),
        cost: t.Object({ pages: t.Integer(), pagesRead: t.Integer(), occurrences: t.Integer() }) }), ...problems }, 'POST') },
    async ({ request, params, body }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const page = await readPage(work, request, { structure, actingSubject: body.actingSubject, limit: 1 });
        const scanned = await allOccurrences(work, request, structure, body.actingSubject, page.revision);
        const ingredients = scaleIngredients(scanned.records, { numerator: BigInt(body.factor.numerator),
          denominator: BigInt(body.factor.denominator) }).map(item => ({ ...item,
          ...(item.amount ? { amount: { numerator: Number(item.amount.numerator),
            denominator: Number(item.amount.denominator) } } : {}),
          ...(item.amountUpper ? { amountUpper: { numerator: Number(item.amountUpper.numerator),
            denominator: Number(item.amountUpper.denominator) } } : {}) }));
        return Response.json({ structure, revision: page.revision, factor: body.factor, ingredients,
          sourcePosition: page.sourcePosition,
          cost: { pages: scanned.pages + 1, pagesRead: scanned.pagesRead + page.cost.pagesRead,
            occurrences: scanned.records.length } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/recipes/:id/exports/schema-org', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref), ...exportContinuationQuery }, { additionalProperties: false }),
      detail: { description: 'Export an exact Recipe revision. Use page=true for any size: retain revision, visit the root sibling pages using next as after, then each group parent in breadth-first order. Assemble recipe-export-page-v1 parts; Content derivations continue through their existing endpoint. Compact responses support up to 4096 occurrences.' },
      response: transportResponses(openApiOperations["/v1/recipes/{id}/exports/schema-org"].get, { 200: t.Union([recipeExportResponse, recipeExportPageResponse]), 413: problemResult(413), ...problems }, 'GET') },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject: string; revision?: string; page?: boolean; parent?: string; after?: string } }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        if (query.page && (query.parent || query.after) && !query.revision) return problem(400,
          'invalid_request', 'Recipe export continuation requires the selected revision');
        const header = await readPage(work, request, { structure, actingSubject: query.actingSubject,
          ...(query.revision ? { revision: query.revision } : {}), limit: 1 });
        if (query.page) return Response.json(await withAuthorizedRecipeRevision(work, request,
          { structure, actingSubject: query.actingSubject, revision: header.revision, limit: 1 },
          (_principal, revision, session) => readRecipeExportPage(session, { structure, revision,
            work: header.work, actingSubject: query.actingSubject, parent: query.parent, after: query.after })),
        { headers: { 'cache-control': 'private, no-store' } });
        const scanned = await allOccurrences(work, request, structure, query.actingSubject, header.revision,
          RecipeExportLimit, `Recipe export exceeds ${RECIPE_EXPORT_OCCURRENCE_LIMIT} occurrences`);
        const body = await withAuthorizedRecipeRevision(work, request, { structure,
          actingSubject: query.actingSubject, revision: header.revision, limit: 1 }, async (_principal, _revision, session) => ({
          profile: 'recipe-schema-org-export-v1', structure, rights: await readImportedExportBases(session, header.work, header.revision),
          revision: header.revision, ...exportRecipe(scanned.records, structure, [],
            (await readStructureMeasures(work.environment, { structure, revision: header.revision })).measures),
          sourcePosition: header.sourcePosition,
          cost: { pages: scanned.pages + 1, pagesRead: scanned.pagesRead + header.cost.pagesRead,
            occurrences: scanned.records.length } }));
        if (Buffer.byteLength(JSON.stringify(body)) > 1_048_576) throw new RecipeExportLimit('Recipe export exceeds 1 MiB');
        return Response.json(body, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/recipes/:id/export', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(ref), revision: t.Optional(ref),
        ...exportContinuationQuery,
        format: t.Optional(t.Union([t.Literal('native'), t.Literal('schema-org')])) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/recipes/{id}/export"].get, { 200: selectedRecipeExport, 413: problemResult(413), ...problems }, 'GET') },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject?: string; revision?: string; format?: 'native' | 'schema-org'; page?: boolean; parent?: string; after?: string } }) => {
      try {
        await work.account.verify(request, ['work:read']);
        if (!query.actingSubject) return problem(400, 'invalid_request', 'actingSubject is required');
        const actingSubject = query.actingSubject;
        if (query.page && (query.parent || query.after) && !query.revision) return problem(400,
          'invalid_request', 'Recipe export continuation requires the selected revision');
        const structure = `https://rezics.com/id/${params.id}`;
        const header = await readPage(work, request, { structure, actingSubject: query.actingSubject,
          ...(query.revision ? { revision: query.revision } : {}), limit: 1 });
        if (query.page) return Response.json(await withAuthorizedRecipeRevision(work, request,
          { structure, actingSubject, revision: header.revision, limit: 1 },
          (_principal, revision, session) => readRecipeExportPage(session, { structure, revision,
            work: header.work, actingSubject, parent: query.parent, after: query.after })),
        { headers: { 'cache-control': 'private, no-store' } });
        const scanned = await allOccurrences(work, request, structure, query.actingSubject, header.revision,
          RecipeExportLimit, `Recipe export exceeds ${RECIPE_EXPORT_OCCURRENCE_LIMIT} occurrences`);
        const body = await withAuthorizedRecipeRevision(work, request, { structure,
          actingSubject: query.actingSubject, revision: header.revision, limit: 1 }, async (_principal, _revision, session) => {
          const instructions = await readRecipeInstructions(session, scanned.records,
            { work: header.work, revision: header.revision, admitted: true });
          const rights = await readImportedExportBases(session, header.work, header.revision);
          const contents = [...new Map(instructions.flatMap(item => item.document || item.text !== undefined
            ? [[JSON.stringify(item.reference), { reference: item.reference,
              ...(item.document ? { document: item.document } : { body: item.text }) }] as const] : [])).values()];
          const derivations: DisclosedDerivation[] = [];
          const contentRevisions = [...new Set(contents.flatMap(item => item.reference.selector.grain === 'content'
            ? [item.reference.selector.revision] : []))];
            for (const revision of contentRevisions) {
              const store = work.contentAuthoring?.derivations;
              if (!store) throw new WorkReadUnavailable('Content derivations are unavailable');
              const inventory = () => store.page(revision, 20, null);
              const records = await inventory();
              session.observeDependency(`recipe-export-derivations:${revision}`, records, inventory);
              // The instruction body was disclosed above. An empty credit
              // inventory needs its own fence, without resolving that body again.
              if (!records.length) continue;
              const page = await readContentDerivations(session, revision);
              if (page.nextCursor) throw new RecipeExportLimit('Recipe derivations exceed the export bound');
              derivations.push(...page.items);
            }
          const body = query.format === 'native'
            ? { format: 'native', structure, revision: header.revision, rights, occurrences: scanned.records,
              measures: (await readStructureMeasures(work.environment, { structure, revision: header.revision })).measures,
              contents, derivations, instructions, losses: [] as ReturnType<typeof exportRecipe>['losses'] }
            : { profile: 'recipe-schema-org-export-v1', structure, revision: header.revision, rights,
              ...exportRecipe(scanned.records, structure, instructions,
                (await readStructureMeasures(work.environment, { structure, revision: header.revision })).measures) };
          if (query.format !== 'native') {
            for (const record of scanned.records) {
              const selectedRevision = record.selection?.mode === 'fixed-revision' ? record.selection.revision : undefined;
              if (record.selection?.mode === 'fixed-revision' && record.selection.selector?.grain === 'content'
                && derivations.some(item => item.output.selector.revision === selectedRevision)) {
                body.losses.push({ code: 'derivation-not-representable', occurrence: record.occurrence,
                  pointer: `/derivations/${derivations.findIndex(item => item.output.selector.revision === selectedRevision)}` });
              }
            }
          }
          if (Buffer.byteLength(JSON.stringify(body)) > 1_048_576) throw new RecipeExportLimit('Recipe export exceeds 1 MiB');
          return body;
        });
        return Response.json(body, { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/recipes/:id/file-imports', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, expectedHead: ref }, { additionalProperties: false }),
      parse: 'none',
      detail: { description: `Retain and import one local Schema.org Recipe JSON file, up to ${MAX_RECIPE_FILE_BYTES} bytes. JSON-LD must use the fixed Schema.org context; graph expansion and network access are disabled.`,
        requestBody: { required: true, content: {
          'application/json': { schema: { type: 'object', required: ['@type'],
            properties: { '@type': { const: 'Recipe' } }, additionalProperties: true } },
          'application/ld+json': { schema: { type: 'object', required: ['@type', '@context'],
            properties: { '@type': { const: 'Recipe' }, '@context': { const: 'https://schema.org' } },
            additionalProperties: true } },
        } } },
      response: transportResponses(openApiOperations["/v1/recipes/{id}/file-imports"].post, { 200: recipeFileImportResponse, 201: recipeFileImportResponse,
        ...problems, 413: problemResult(413), 422: problemResult(422) }, 'POST') },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject: string; expectedHead: string } }) => {
      try {
        const idempotencyKey = key(request);
        if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
        if (!work.sourceIntake || !work.access.activePrincipalId || !work.access.assertAuthority) {
          return problem(503, 'source_intake_unavailable', 'Source intake owner is unavailable');
        }
        await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:edit']);
        const structure = `https://rezics.com/id/${params.id}`;
        const header = await readCompositionHeader(work.environment, structure);
        const readable = await work.access.canReadWork(principal, query.actingSubject, header?.owner ?? structure);
        if (!header || header.profile !== 'recipe-composition' || !readable) {
          throw new CompositionUnavailable('Recipe is unavailable');
        }
        const profile = structureProfileFor(header.profile);
        await work.access.assertAuthority({ principal, actingSubject: query.actingSubject,
          action: profile.editAction, scope: `${profile.editScopePrefix}${header.owner}` });
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const intakeKey = `recipe-file-import:${idempotencyKey}`;
        let prior = await work.sourceIntake.replay(principalId, intakeKey);
        const bytes = await readRecipeFileBytes(request);
        const mediaType = request.headers.get('content-type') ?? '';
        const accepted = parseRecipeFile(bytes, mediaType);
        if (header.head !== query.expectedHead && !prior) {
          prior = await work.sourceIntake.replay(principalId, intakeKey);
          if (!prior) throw new StaleCompositionHead('expected composition head is stale');
        }
        const intent = createHash('sha256').update(JSON.stringify([
          structure, query.actingSubject,
        ])).digest('hex').slice(0, 32);
        const retained = await work.sourceIntake.submit(principalId, intakeKey, {
          provider: 'rezics', namespace: 'recipe-file', externalId: header.owner,
          sourceRevision: query.expectedHead, mediaType, retention: 'retained',
          rawBytesBase64: Buffer.from(bytes).toString('base64'),
          coverage: { scope: `recipe-file-import-v1:${intent}`, complete: true, omittedFields: [] },
          rightsEvidence: { basis: 'unknown', note: 'User supplied this Recipe file for the Work.' },
        });
        await work.sourceIntake.bindImportCustody(principalId, retained.observation.observation, {
          resourceId: header.owner, revisionId: query.expectedHead,
        });
        const parsed = importRecipe(accepted.source, retained.observation.observation);
        const written = await writeRecipeImport(work, request, { structure,
          expectedHead: query.expectedHead, actingSubject: query.actingSubject,
          idempotencyKey, parsed });
        if (!written.sourcePosition) throw new CompositionCorrupt('recipe import did not write a composition');
        return Response.json({ structure, revision: written.expectedHead,
          sourceObservation: retained.observation.observation, residualDigest: parsed.residual,
          receipts: written.receipts, sourcePosition: written.sourcePosition,
          replayed: retained.replayed }, { status: retained.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof RecipeFileInvalid) return problem(422, 'invalid_recipe_file', error.message);
        return routeError(error);
      } finally { cancelRecipeFileBody(request); }
    })
    .post('/v1/recipes/:id/imports', { params: t.Object({ id: groupUuid }),
      body: importBody, response: transportResponses(openApiOperations["/v1/recipes/{id}/imports"].post, { 200: t.Any(), 202: problemResult(202), ...problems }, 'POST') },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: Static<typeof importBody> }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        if (!work.sourceIntake || !work.access.activePrincipalId) {
          return problem(503, 'source_intake_unavailable', 'Source intake owner is unavailable');
        }
        const sourcePrincipal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(sourcePrincipal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const observationId = body.sourceObservation.split('/').at(-1)!;
        const observation = await work.sourceIntake.read(principalId, observationId);
        if (!observation?.rawBytesBase64) return problem(404, 'source_observation_unavailable',
          'A retained recipe source observation is required');
        let source: unknown;
        try {
          const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
          source = /json|ld\+json/i.test(observation.mediaType)
            ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
        } catch { return problem(400, 'invalid_recipe_source', 'Recipe source could not be parsed'); }
        let parsed;
        try { parsed = importRecipe(source, body.sourceObservation); }
        catch (error) { return problem(400, 'invalid_recipe_source',
          error instanceof Error ? error.message : 'Recipe source is invalid'); }
        if (!parsed.ingredients.length && !parsed.steps.length) {
          return problem(400, 'invalid_recipe_source', 'Recipe source has no importable lines or steps');
        }
        const structure = `https://rezics.com/id/${params.id}`;
        const candidates = recipeSourceSupportCandidates(source, parsed);
        const bindSupport = /^application\/(?:json|ld\+json)(?:;|$)/i.test(observation.mediaType)
          && observation.coverage.complete && observation.coverage.scope === 'complete-recipe';
        let conversion: RecipeSourceConversion | undefined;
        let ownerWork: string | undefined;
        let supportPrincipal = sourcePrincipal;
        if (bindSupport) {
          if (!work.recipeSourceConversions || !work.sourceFieldAttachments
            || !work.sourceFieldWithdrawals
            || !work.access.withWorkEditAuthority) {
            return problem(503, 'recipe_source_support_unavailable', 'Recipe source support owner is unavailable');
          }
          supportPrincipal = await work.account.verify(request, ['source:read', 'source:adopt', 'work:edit']);
          const owner = await readCompositionHeader(work.environment, structure);
          if (!owner || owner.profile !== 'recipe-composition') throw new CompositionUnavailable('Recipe is unavailable');
          ownerWork = owner.owner;
          await work.access.withWorkEditAuthority(supportPrincipal, body.actingSubject,
            owner.owner, async () => undefined);
          const converted = await work.recipeSourceConversions.convert(principalId, observationId);
          if (!converted) throw new RecipeSourceConversionUnavailable('Recipe conversion is unavailable');
          conversion = converted;
        }
        const written = await writeRecipeImport(work, request, { structure,
          expectedHead: body.expectedHead, actingSubject: body.actingSubject, idempotencyKey, parsed });
        const { expectedHead, receipts, sourcePosition, importedOccurrences } = written;
        const supports: string[] = [];
        if (conversion && work.sourceFieldAttachments) {
          const current = await readCompositionHeader(work.environment, structure);
          if (!current || current.profile !== 'recipe-composition') {
            throw new CompositionUnavailable('Recipe is unavailable');
          }
          const supportHead = current.head;
          if (candidates.some(candidate => !importedOccurrences.has(candidate.sourceKey))) {
            const { records } = await allOccurrences(work, request, structure, body.actingSubject, supportHead);
            for (const candidate of candidates) {
              if (importedOccurrences.has(candidate.sourceKey)) continue;
              const matches = records.filter(row => row.state === 'active'
                && row.sourceKey === candidate.sourceKey);
              if (matches.length !== 1) throw new CompositionConflict('Recipe support replay is ambiguous');
              importedOccurrences.set(candidate.sourceKey, matches[0]!.occurrence);
            }
          }
          for (const candidate of candidates) {
            const occurrence = importedOccurrences.get(candidate.sourceKey);
            if (!occurrence) throw new CompositionCorrupt('imported Recipe occurrence is unavailable');
            const supportKey = `recipe-support-${createHash('sha256').update(JSON.stringify([
              idempotencyKey, structure, observation.observation, candidate.sourceKey,
            ])).digest('hex')}`;
            const sourceOccurrence = sourceFieldOccurrence(observation.observation, 'recipe',
              candidate.sourceField, candidate.sourcePointer);
            const prior = await work.sourceFieldAttachments.supportByKey(principalId, supportKey);
            if (prior) {
              const supported = await work.sourceFieldWithdrawals!.read(principalId, prior);
              if (!supported || supported.target !== ownerWork || supported.slot !== candidate.slot
                || supported.occurrence !== occurrence || supported.context !== structure
                || supported.sourceRecord !== conversion.record
                || supported.conversion !== conversion.conversion
                || supported.sourceOccurrence !== sourceOccurrence) {
                throw new FieldWithdrawalConflict('Recipe support replay differs from imported child');
              }
              supports.push(prior);
              continue;
            }
            const attached = await work.sourceFieldAttachments.attach(supportPrincipal, principalId,
              supportKey, { profile: 'source-field-support-attachment-v1', target: ownerWork!,
                slot: candidate.slot, occurrence, context: structure, sourceRecord: conversion.record,
                conversion: conversion.conversion, grain: 'recipe', sourceField: candidate.sourceField,
                sourceOccurrence,
                sourcePointer: candidate.sourcePointer, expectedHead: supportHead,
                actingSubject: body.actingSubject });
            supports.push(attached.support);
          }
        }
        return Response.json({ structure, revision: expectedHead, sourceObservation: observation.observation,
          residualDigest: parsed.residual, receipts, sourcePosition,
          ...(conversion ? { conversion: conversion.conversion, supports,
            unboundSourceKeys: [...parsed.ingredients, ...parsed.steps]
              .filter(item => !candidates.some(candidate => candidate.sourceKey === item.sourceKey))
              .map(item => item.sourceKey) } : {}) },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/recipes/nutrition', { body: nutritionBody,
      response: transportResponses(openApiOperations["/v1/recipes/nutrition"].post, { 200: t.Any(), ...problems }, 'POST') }, async ({ request, body }: {
        request: Request; body: Static<typeof nutritionBody> }) => {
      try {
        await work.account.verify(request, ['work:read']);
        const inputs = body.inputs.map(input => ({ coverage: input.coverage,
          values: input.values.map(value => ({ nutrient: value.nutrient, unit: value.unit,
            amount: { numerator: BigInt(value.amount.numerator), denominator: BigInt(value.amount.denominator) } })) }));
        const result = calculateNutrition(inputs, body.basis);
        return Response.json({ ...result, nutrients: result.nutrients.map(item => ({
          ...item, amount: { numerator: Number(item.amount.numerator), denominator: Number(item.amount.denominator) },
        })) }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    });
}
