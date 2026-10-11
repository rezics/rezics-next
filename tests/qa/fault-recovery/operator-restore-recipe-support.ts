import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { compositionRoutes } from '../../../services/main/src/routes/compositions.ts';
import { recipeRoutes } from '../../../services/main/src/routes/recipes.ts';
import { workRoutes } from '../../../services/main/src/routes/works.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';

export type RecipeApiRequest = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) => Promise<Response>;

export interface RecipeApiGrant {
  (scope: string, action: string): Promise<void>;
}

export interface BeforeCutRecipeSeedContext {
  request: RecipeApiRequest;
  actor: string;
  grant: RecipeApiGrant;
}

export interface RecipeSeed {
  work: string;
  mainVersion: string;
  structure: string;
  initialRevision: string;
  ingredientOccurrences: [string, string];
  stepOccurrence: string;
  ingredients: [IngredientQualifier, IngredientQualifier];
  step: StepQualifier;
}

export interface MembershipCompletionProof {
  dataEpoch: string;
  revision: 'ordered-membership-v1';
}

export type IngredientQualifier = Extract<
  NonNullable<OccurrenceRecord['qualifier']>,
  { type: 'ingredient-line' }
>;
export type StepQualifier = Extract<
  NonNullable<OccurrenceRecord['qualifier']>,
  { type: 'recipe-step' }
>;

export function shortId(uri: string): string {
  return uri.split('/').at(-1)!;
}

export function createRecipeApiRequest(
  fuseki: FusekiClient,
  work: MainWorkDependencies,
  token: () => Promise<string>,
): RecipeApiRequest {
  const app = new Elysia()
    .use(workRoutes(fuseki, work))
    .use(compositionRoutes(fuseki, work))
    .use(recipeRoutes(fuseki, work));

  return async (method, path, body, idempotencyKey = randomUUID()) => {
    const headers = new Headers({ authorization: `Bearer ${await token()}` });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      headers.set('idempotency-key', idempotencyKey);
      init.body = JSON.stringify(body);
    }
    return app.handle(new Request(new URL(path, 'http://main.local'), init));
  };
}

export async function recipeApiJson<T>(
  response: Response,
  expectedStatus: number,
): Promise<T> {
  const value = await response.json().catch(() => undefined);
  if (response.status !== expectedStatus) {
    throw new Error(
      `Recipe fixture API returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

export async function seedRecipeBeforeCut(
  context: BeforeCutRecipeSeedContext,
): Promise<RecipeSeed> {
  const work = await recipeApiJson<{ work: string; mainVersion: string }>(
    await context.request(
      'POST',
      '/v1/works',
      {
        profile: 'metadata-only-v1',
        authoring: 'own-work',
        title: 'Restored flour recipe',
        language: 'en',
        semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: context.actor,
      },
      `recipe-work-${randomUUID()}`,
    ),
    201,
  );
  await context.grant(`work:edit:${work.work}`, 'recipe.edit');
  await context.grant(`work:edit:${work.work}`, 'work.edit');
  await context.grant(`work:read:${work.work}`, 'work.read');

  const composition = await recipeApiJson<{ structure: string; revision: string }>(
    await context.request(
      'POST',
      '/v1/compositions',
      {
        profile: 'recipe-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: context.actor,
      },
      `recipe-composition-${randomUUID()}`,
    ),
    201,
  );

  const ingredients: [IngredientQualifier, IngredientQualifier] = [
    {
      type: 'ingredient-line',
      originalText: { value: '1 1/2 cups flour', language: 'en' },
      amountLexical: '1 1/2',
      amount: { numerator: 3, denominator: 2 },
      unitText: 'cups',
      optional: false,
      scaling: 'linear',
      substituteFor: [],
      parseStatus: 'parsed',
    },
    {
      type: 'ingredient-line',
      originalText: { value: '1/4 teaspoon salt', language: 'en' },
      amountLexical: '1/4',
      amount: { numerator: 1, denominator: 4 },
      unitText: 'teaspoon',
      optional: false,
      scaling: 'linear',
      substituteFor: [],
      parseStatus: 'parsed',
    },
  ];
  const lineChange = await recipeApiJson<{ revision: string; occurrences: string[] }>(
    await context.request(
      'POST',
      `/v1/compositions/${shortId(composition.structure)}/changes`,
      {
        profile: 'recipe-composition',
        expectedHead: composition.revision,
        actingSubject: context.actor,
        operations: ingredients.map((qualifier, index) => ({
          op: 'insert',
          parent: composition.structure,
          position: 'last',
          role: 'ingredient',
          sourceKey: `initial-ingredient-${index + 1}`,
          qualifier,
        })),
      },
      `recipe-lines-${randomUUID()}`,
    ),
    200,
  );
  if (lineChange.occurrences.length !== 2) {
    throw new Error('Recipe seed did not create two ingredient occurrences');
  }

  const step: StepQualifier = {
    type: 'recipe-step',
    instructionText: { value: 'Whisk the flour and salt together.', language: 'en' },
    usesIngredient: [lineChange.occurrences[0]!],
    media: [],
    scaling: 'linear',
  };
  const stepChange = await recipeApiJson<{ revision: string; occurrences: string[] }>(
    await context.request(
      'POST',
      `/v1/compositions/${shortId(composition.structure)}/changes`,
      {
        profile: 'recipe-composition',
        expectedHead: lineChange.revision,
        actingSubject: context.actor,
        operations: [
          {
            op: 'insert',
            parent: composition.structure,
            position: 'last',
            role: 'step',
            sourceKey: 'initial-step',
            qualifier: step,
          },
        ],
      },
      `recipe-step-${randomUUID()}`,
    ),
    200,
  );
  if (stepChange.occurrences.length !== 1) {
    throw new Error('Recipe seed did not create its step occurrence');
  }

  return {
    work: work.work,
    mainVersion: work.mainVersion,
    structure: composition.structure,
    initialRevision: stepChange.revision,
    ingredientOccurrences: [lineChange.occurrences[0]!, lineChange.occurrences[1]!],
    stepOccurrence: stepChange.occurrences[0]!,
    ingredients,
    step,
  };
}

export async function readMembershipCompletionProof(
  fuseki: Pick<FusekiClient, 'query'>,
): Promise<MembershipCompletionProof | undefined> {
  const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?proof WHERE { GRAPH <urn:rezics:graph:template-index> {
      <urn:rezics:membership-preparation> rv:membershipCompletedForm ?proof
    } }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new Error('Native membership completion proof is ambiguous');
  if (rows.length === 0) return undefined;
  const value = rows[0]?.proof?.value;
  if (typeof value !== 'string') throw new Error('Native membership completion proof is unavailable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Native membership completion proof is malformed');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('dataEpoch' in parsed) ||
    typeof parsed.dataEpoch !== 'string' ||
    !('revision' in parsed) ||
    parsed.revision !== 'ordered-membership-v1'
  ) {
    throw new Error('Native membership completion proof has an unsupported form');
  }
  return { dataEpoch: parsed.dataEpoch, revision: 'ordered-membership-v1' };
}
