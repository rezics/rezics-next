import { Elysia, t } from 'elysia';
import { createHash } from 'node:crypto';
import type { Static } from 'typebox';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { changeAdmittedComposition, changeAdmittedStructureMeasures }
  from '../modules/structure/change-admitted.ts';
import { CompositionConflict, InvalidCompositionChange, StaleCompositionHead }
  from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readCompositionPage, readStructureMeasures } from '../modules/structure/read.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable }
  from '../modules/structure/tree.ts';
import { RecipeMeasure, STRUCTURE_LIMITS, OccurrenceRecord }
  from '../modules/structure/format.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { AdmissionDenied } from '../modules/access/admission.ts';
import { structureProfileFor } from '../modules/structure/profiles.ts';
import { calculateNutrition, scaleIngredients } from '../modules/recipe/operations.ts';
import { exactRational, InexactQuantity } from '../modules/recipe/quantity.ts';
import { importRecipe, recipeSourceSupportCandidates } from '../modules/recipe/importer.ts';
import { RecipeSourceConversionInvalid, RecipeSourceConversionUnavailable,
  type RecipeSourceConversion }
  from '../modules/recipe/source-conversion.ts';
import { sourceFieldOccurrence } from '../modules/source/support-attach.ts';
import { FieldWithdrawalConflict, FieldWithdrawalInvalid, FieldWithdrawalUnavailable }
  from '../modules/source/withdrawal.ts';
import { exportRecipe, RecipeExportLimit } from '../modules/recipe/export.ts';
import { readRecipeWorkPage } from '../modules/recipe/work-page.ts';
import { workRead } from '../modules/work/read-session.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
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

export const openApiOperations = {
  '/v1/recipes/works/{id}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/recipes/{id}/measures': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true }, get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/{id}/timings': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/recipes/{id}/scalings': { post: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/{id}/imports': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/recipes/{id}/exports/schema-org': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/recipes/nutrition': { post: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
} as const;

function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function routeError(error: unknown): Response {
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_recipe_change', error.message);
  if (error instanceof InexactQuantity) return problem(400, 'invalid_recipe_quantity', error.message);
  if (error instanceof RecipeSourceConversionInvalid || error instanceof FieldWithdrawalInvalid) {
    return problem(400, 'invalid_recipe_source_support', error.message);
  }
  if (error instanceof FieldWithdrawalConflict) return problem(409, 'recipe_source_support_conflict', error.message);
  if (error instanceof RecipeSourceConversionUnavailable || error instanceof FieldWithdrawalUnavailable) {
    return problem(503, 'recipe_source_support_unavailable', error.message);
  }
  if (error instanceof RecipeExportLimit) return problem(413, 'recipe_export_too_large', error.message);
  if (error instanceof CompositionUnavailable) return problem(404, 'recipe_unavailable', 'Recipe is unavailable');
  if (error instanceof StaleCompositionHead || error instanceof CompositionConflict) {
    return problem(409, 'recipe_conflict', error.message);
  }
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) {
    return problem(503, 'recipe_unavailable', 'Recipe history is unavailable');
  }
  return commandError(error);
}

async function readPage(work: MainWorkDependencies, request: Request, input: {
  structure: string; actingSubject: string; revision?: string; parent?: string; after?: string; limit: number;
}) {
  await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
  const principal = await work.account.verify(request, ['work:read']);
  const header = await readCompositionHeader(work.environment, input.structure);
  if (!header || header.profile !== 'recipe-composition'
    || !await work.access.canReadWork(principal, input.actingSubject, header.owner)) {
    throw new CompositionUnavailable('Recipe is unavailable');
  }
  return readCompositionPage(work.environment, { structure: input.structure,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
    limit: input.limit, canReadTarget: target => NATIVE_ID.test(target)
      ? work.access.canReadWork(principal, input.actingSubject, target) : Promise.resolve(false) });
}

async function allOccurrences(work: MainWorkDependencies, request: Request, structure: string,
  actingSubject: string, revision: string): Promise<{ records: OccurrenceRecord[];
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
      if (records.length > 4096) throw new CompositionConflict('recipe calculation exceeds 4096 occurrences');
    } while (after);
  }
  return { records, pages, pagesRead };
}

const durationKinds: ReadonlySet<string> = new Set(timingKinds.map(([, kind]) => kind));

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
        servings: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: t.Nullable(t.Object({ profile: t.Literal('recipe-work-page-v1'), structure: ref,
        revision: ref, occurrences: t.Array(OccurrenceRecord), measures: t.Array(RecipeMeasure),
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
        cost: t.Object({ pages: t.Integer(), pagesRead: t.Integer(), occurrences: t.Integer() }) })),
      ...workReadProblems } }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, { actingSubject: query.actingSubject },
          session => readRecipeWorkPage(session, `https://rezics.com/id/${params.id}`, query.servings)),
        { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return workReadError(error); }
    })
    .post('/v1/recipes/:id/measures', { params: t.Object({ id: groupUuid }),
      body: storedNutritionBody, response: { 200: write, 202: problemResult(202), ...problems } },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: Static<typeof storedNutritionBody> }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        if (!body.yield.unit && !body.yield.unitText) {
          return problem(400, 'invalid_recipe_measure', 'Yield requires a unit or unitText');
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
          || !nutrition && item.kind === 'nutrient');
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
          ...kept,
        ];
        if (measures.length > STRUCTURE_LIMITS.measures) {
          return problem(400, 'invalid_recipe_measure', 'Recipe has too many distinct measures');
        }
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
      body: timingsBody, response: { 200: write, 202: problemResult(202), ...problems } },
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
      response: { 200: t.Object({ structure: ref, owner: ref, revision: ref,
        predecessor: t.Nullable(ref), measures: t.Array(RecipeMeasure),
        sourcePosition: t.Any(), cost: t.Any() }), ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await readPage(work, request, { structure, actingSubject: query.actingSubject,
          ...(query.revision ? { revision: query.revision } : {}), limit: 1 });
        const result = await readStructureMeasures(work.environment, { structure,
          ...(query.revision ? { revision: query.revision } : {}) });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/recipes/:id/scalings', { params: t.Object({ id: groupUuid }),
      body: t.Object({ actingSubject: ref, factor: rational }, { additionalProperties: false }),
      response: { 200: t.Object({ structure: ref, revision: ref, factor: rational,
        ingredients: t.Array(t.Any()), sourcePosition: t.Any(),
        cost: t.Object({ pages: t.Integer(), pagesRead: t.Integer(), occurrences: t.Integer() }) }), ...problems } },
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
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref) }, { additionalProperties: false }),
      response: { 200: t.Any(), 413: problemResult(413), ...problems } },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject: string; revision?: string } }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        const header = await readPage(work, request, { structure, actingSubject: query.actingSubject,
          ...(query.revision ? { revision: query.revision } : {}), limit: 1 });
        const scanned = await allOccurrences(work, request, structure, query.actingSubject, header.revision);
        return Response.json({ profile: 'recipe-schema-org-export-v1', structure,
          revision: header.revision, ...exportRecipe(scanned.records, structure),
          sourcePosition: header.sourcePosition,
          cost: { pages: scanned.pages + 1, pagesRead: scanned.pagesRead + header.cost.pagesRead,
            occurrences: scanned.records.length } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/recipes/:id/imports', { params: t.Object({ id: groupUuid }),
      body: importBody, response: { 200: t.Any(), 202: problemResult(202), ...problems } },
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
        let expectedHead = body.expectedHead;
        const receipts: string[] = [];
        let sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string } | undefined;
        const groupIndexes = parsed.sections.map((_, index) => index);
        const groups = new Map<number, string>();
        for (let offset = 0; offset < groupIndexes.length; offset += 16) {
          const batch = groupIndexes.slice(offset, offset + 16);
          const result = await changeAdmittedComposition(work.environment, work.account, work.access,
            request, { structure, expectedHead, actingSubject: body.actingSubject,
              idempotencyKey: `${idempotencyKey}.groups.${offset / 16}`,
              operations: batch.map(index => ({ op: 'insert' as const, parent: structure,
                position: 'last' as const, role: 'group' as const,
                label: { value: parsed.sections[index]!.label,
                  language: parsed.sections[index]!.language },
                sourceKey: parsed.sections[index]!.sourceKey })) });
          if (!result.revision) return problem(503, 'recipe_import_pending', 'Recipe import is pending');
          if (result.occurrences?.length === batch.length) {
            result.occurrences.forEach((occurrence, index) => groups.set(batch[index]!, occurrence));
          } else {
            const { records } = await allOccurrences(work, request, structure, body.actingSubject, result.revision);
            for (const index of batch) {
              const matches = records.filter(record => record.state === 'active' && record.role === 'group'
                && record.sourceKey === parsed.sections[index]!.sourceKey);
              if (matches.length !== 1) throw new CompositionCorrupt('recipe import group is unavailable');
              groups.set(index, matches[0]!.occurrence);
            }
          }
          expectedHead = result.revision; receipts.push(result.receipt);
          sourcePosition = { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence };
        }
        const operations = [
          ...parsed.ingredients.map(item => ({ op: 'insert' as const, parent: structure,
            position: 'last' as const, role: 'ingredient' as const,
            qualifier: { ...item.qualifier,
              ...(item.qualifier.parseStatus !== 'parsed'
                ? { residual: `sha256:${parsed.residual}` } : {}) },
            sourceKey: item.sourceKey })),
          ...parsed.steps.map(item => ({ op: 'insert' as const, parent: item.section >= 0
            ? groups.get(item.section) ?? structure : structure, position: 'last' as const,
            role: 'step' as const, qualifier: { type: 'recipe-step' as const,
              instructionText: { value: item.text, language: item.language },
              usesIngredient: [], media: [], scaling: 'linear' as const }, sourceKey: item.sourceKey })),
        ];
        const importedOccurrences = new Map<string, string>();
        for (let offset = 0; offset < operations.length; offset += 16) {
          const result = await changeAdmittedComposition(work.environment, work.account, work.access,
            request, { structure, expectedHead, actingSubject: body.actingSubject,
              idempotencyKey: `${idempotencyKey}.content.${offset / 16}`,
              operations: operations.slice(offset, offset + 16) });
          if (!result.revision) return problem(503, 'recipe_import_pending', 'Recipe import is pending');
          if (result.occurrences?.length === Math.min(16, operations.length - offset)) {
            result.occurrences.forEach((occurrence, index) => {
              importedOccurrences.set(operations[offset + index]!.sourceKey, occurrence);
            });
          }
          expectedHead = result.revision; receipts.push(result.receipt);
          sourcePosition = { datasetId: 'product', dataEpoch: result.dataEpoch, sequence: result.sequence };
        }
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
      response: { 200: t.Any(), ...problems } }, async ({ request, body }: {
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
