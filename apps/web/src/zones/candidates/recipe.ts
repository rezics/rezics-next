import type { SubjectRead } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import definitions from '../../kernel/recorded/definitions-release.json';
import recipeStarter from '../../../../../packages/definitions/presentation/recipe/zone.json';
import type { ZonePageResponse, ZonePublic } from '../appearance';

const release = definitions.release as Release;
const properties = release.properties as Record<string, { datatype: string }>;
const types = release.types as Record<string, { bases: string[] }>;

export const RECIPE_ZONE_IDS = {
  admitted: '0193c000-0006-7000-8000-000000000000',
  empty: '0193c000-0006-7000-8000-000000000001',
  sparse: '0193c000-0006-7000-8000-000000000002',
  closed: '0193c000-0006-7000-8000-000000000003',
  unavailable: '0193c000-0006-7000-8000-000000000004',
  private: '0193c000-0006-7000-8000-000000000005',
  missing: '0193c000-0006-7000-8000-000000000006',
} as const;

export type RecipeCandidateState = keyof typeof RECIPE_ZONE_IDS;

export const RECIPE_SUBJECT_IDS = {
  apricotToast: '0193c100-0006-7000-8000-000000000001',
  harborOats: '0193c100-0006-7000-8000-000000000002',
  rainyLentils: '0193c100-0006-7000-8000-000000000003',
  sparsePorridge: '0193c100-0006-7000-8000-000000000004',
} as const;

type Subject = SubjectRead['subject'];
type Statement = Subject['statements'][string][number];

export type RecipeCandidate = {
  id: string;
  type: 'schema:Recipe';
  labels: { en: string };
  ingredientNotes: string[];
  method: string[];
  facts: Record<string, unknown[]>;
};

const minute = 'http://www.wikidata.org/entity/Q7727';

const recipe = (
  id: string,
  name: string,
  ingredients: string[],
  method: string[],
  cookMinutes?: number,
  servings?: number,
): RecipeCandidate => ({
  id,
  type: 'schema:Recipe',
  labels: { en: name },
  ingredientNotes: ingredients,
  method,
  facts: {
    'schema:name': [name],
    ...(cookMinutes === undefined ? {} : { 'schema:cookTime': [{ amount: `+${cookMinutes}`, unit: minute }] }),
    ...(servings === undefined ? {} : { 'schema:recipeYield': [{ amount: `+${servings}`, unit: '1' }] }),
    ...(ingredients.length === 0
      ? {}
      : {
          'schema:recipeIngredient': ingredients.map((text) => ({
            text,
            language: 'en',
          })),
        }),
    ...(method.length === 0
      ? {}
      : {
          'schema:recipeInstructions': [
            {
              language: 'en',
              document: {
                root: { props: {} },
                content: method.map((text, index) => ({
                  type: 'Text',
                  props: { id: `step-${index + 1}`, text },
                })),
              },
            },
          ],
        }),
  },
});

export const RECIPE_SUBJECTS: readonly RecipeCandidate[] = [
  recipe(
    RECIPE_SUBJECT_IDS.apricotToast,
    'Apricot Window-Pan Toast',
    ['2 slices country bread', '3 ripe apricots, halved', '1 teaspoon orange zest'],
    [
      'Toast the bread until its edges are crisp.',
      'Warm the apricots cut-side down in a covered pan until soft, then spoon them over the toast and finish with orange zest.',
    ],
    12,
    2,
  ),
  recipe(
    RECIPE_SUBJECT_IDS.harborOats,
    'Harbor-Morning Oat Cups',
    ['1 cup rolled oats', '1 ripe pear, diced', '2 tablespoons pumpkin seeds'],
    [
      'Stir the oats and diced pear together with enough water to hold the mixture.',
      'Divide into small oven-safe cups, scatter the seeds over the top, and bake until the centers are just set.',
    ],
    24,
    3,
  ),
  recipe(
    RECIPE_SUBJECT_IDS.rainyLentils,
    'Rainy-Day Lentil Pot',
    ['1 cup green lentils', '1 small onion, diced', '1 can crushed tomatoes', 'A handful of chopped parsley'],
    [
      'Soften the onion in a covered pot with a splash of water.',
      'Add lentils, tomatoes, and enough water to cover; simmer until the lentils are tender, then fold through parsley.',
    ],
    38,
    4,
  ),
];

const sparseRecipe = recipe(RECIPE_SUBJECT_IDS.sparsePorridge, 'Rain-on-the-Window Porridge', [], []);

export const RECIPE_PREVIEW_LABEL =
  'Candidate · development preview, gated and deferred. Fictional recipes; no live catalogue or official-site claim.';

type StarterNode = { type: string; props: Record<string, unknown> };
type StarterDocument = { root: unknown; content: StarterNode[] };

const starterPage = recipeStarter.pages.find(({ route }) => route === '');
const starterDocument = starterPage?.document as StarterDocument | undefined;
const starterStack = starterDocument?.content[0];
const starterChildren = starterStack?.props.children as StarterNode[] | undefined;

function homeDocument(stateCopy: string): StarterDocument {
  if (!starterDocument || !starterStack || !starterChildren) throw new Error('The Recipe starter home is missing.');
  const heading = starterChildren.find(({ type, props }) => type === 'Heading' && props.id === 'title');
  const intro = starterChildren.find(({ type, props }) => type === 'Text' && props.id === 'intro');
  const list = starterChildren.find(({ type }) => type === 'TypeList');
  const slots = starterChildren.filter(({ type }) => type === 'Slot');
  if (!heading || !intro || !list || slots.length !== 4) throw new Error('The Recipe starter home changed shape.');

  return {
    ...starterDocument,
    content: [
      {
        ...starterStack,
        props: {
          ...starterStack.props,
          children: [heading, { type: 'Text', props: { id: 'preview-note', text: stateCopy } }, intro, list, ...slots],
        },
      },
    ],
  };
}

export const RECIPE_HOME_DOCUMENTS = {
  admitted: homeDocument(RECIPE_PREVIEW_LABEL),
  empty: homeDocument(`${RECIPE_PREVIEW_LABEL} This read is ready and has no matching recipes.`),
  sparse: homeDocument(`${RECIPE_PREVIEW_LABEL} One fictional recipe is shown with its optional facts absent.`),
} as const;

export const RECIPE_HOME_COPY = {
  admitted: RECIPE_SUBJECTS,
  empty: [],
  sparse: [sparseRecipe],
} as const satisfies Record<'admitted' | 'empty' | 'sparse', readonly RecipeCandidate[]>;

function recipeStatements(candidate: RecipeCandidate): Subject['statements'] {
  const statements: Subject['statements'] = {};
  for (const [property, values] of Object.entries(candidate.facts)) {
    statements[property] = values.map((content, index) => ({
      id: `${candidate.id}:${property}:${index + 1}`,
      rank: 'normal',
      property: { id: property, data_type: properties[property]!.datatype },
      value: { type: 'value', content },
      qualifiers: [],
      references: [],
      rezics: { release: definitions.digest, revision: 1 },
    })) as Statement[];
  }
  return statements;
}

export function recipeCandidate(id: string): RecipeCandidate | undefined {
  return [...RECIPE_SUBJECTS, sparseRecipe].find((candidate) => candidate.id === id);
}

function candidateLabel(candidate: RecipeCandidate, languages: readonly string[] = []) {
  const labels = candidate.labels as Record<string, string>;
  for (const language of languages) {
    const exact = labels[language];
    if (exact) return { value: exact, language };
    const primary = language.split('-')[0];
    const fallback = primary ? labels[primary] : undefined;
    if (fallback) return { value: fallback, language: primary! };
  }
  return { value: candidate.labels.en, language: 'en' };
}

export function recipeSubjectRead(candidate: RecipeCandidate, languages: readonly string[] = []): SubjectRead {
  const subject: Subject = {
    id: candidate.id,
    type: candidate.type,
    revision: 1,
    release: definitions.digest,
    context: PAGE_GLOBAL_CONTEXT,
    resolution: {},
    relationCounts: {},
    labels: candidate.labels,
    descriptions: {},
    aliases: {},
    statements: recipeStatements(candidate),
    sourceRecords: [],
  };
  const types = [candidate.type, ...typesById(candidate.type)];
  return {
    subject,
    summary: {
      id: candidate.id,
      type: candidate.type,
      types,
      creativeWork: types.includes('schema:CreativeWork'),
      label: candidateLabel(candidate, languages),
      cover: null,
    },
    related: {},
    account: null,
  };
}

function typesById(id: string): string[] {
  const found = new Set<string>();
  const pending = [...(types[id]?.bases ?? [])];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...(types[next]?.bases ?? []));
  }
  return [...found];
}

function searchHit(candidate: RecipeCandidate, languages: readonly string[]) {
  const { summary } = recipeSubjectRead(candidate, languages);
  return {
    id: candidate.id,
    type: candidate.type,
    labels: candidate.labels,
    summary,
  };
}

export function recipeZone(state: RecipeCandidateState): ZonePublic {
  return {
    id: RECIPE_ZONE_IDS[state],
    revision: '1',
    labels: recipeStarter.labels,
    primaryLanguage: 'en',
    visibility: state === 'private' ? 'private' : 'public',
    appearance: {},
    navigation: [{ route: '' }],
  };
}

export function recipeHomeResponse(
  state: 'admitted' | 'empty' | 'sparse',
  languages: readonly string[] = [],
): ZonePageResponse {
  const document = RECIPE_HOME_DOCUMENTS[state] as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: null });
  const subjects = RECIPE_HOME_COPY[state].map((candidate) => searchHit(candidate, languages));
  const reads = Object.fromEntries(
    Object.keys(plan.reads).map((key) => [
      key,
      {
        status: 200,
        body: { subjects, next: null, as_of: '2026-10-26T00:00:00.000Z' },
      },
    ]),
  );
  return {
    profile: 'schema:Recipe',
    template: { scope: 'route', key: '' },
    document,
    reads,
    zone: recipeZone(state),
  };
}
