import recipeStarter from '../../../../../packages/definitions/presentation/recipe/zone.json';
import type { ZonePageResponse, ZonePublic } from '../appearance';

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
} as const;

type RecipeFact = { datatype: string; content: unknown };
type RecipeStatement = {
  id: string;
  rank: 'normal';
  property: { id: string; data_type: string };
  value: { type: 'value'; content: unknown };
  qualifiers: [];
  references: [];
};

export type RecipeCandidate = {
  id: string;
  type: 'schema:Recipe';
  labels: { en: string };
  descriptions: { en: string };
  aliases: Record<string, never>;
  facts: Record<string, RecipeFact[]>;
  ingredientNotes: string[];
  method: string[];
};

const minute = 'http://www.wikidata.org/entity/Q7727';

const recipe = (
  id: string,
  name: string,
  description: string,
  ingredientNotes: string[],
  method: string[],
  cookMinutes?: number,
  servings?: number,
): RecipeCandidate => ({
  id,
  type: 'schema:Recipe',
  labels: { en: name },
  descriptions: { en: description },
  aliases: {},
  facts: {
    'schema:name': [{ datatype: 'string', content: name }],
    ...(cookMinutes === undefined
      ? {}
      : {
          'schema:cookTime': [
            {
              datatype: 'quantity',
              content: { amount: `+${cookMinutes}`, unit: minute },
            },
          ],
        }),
    ...(servings === undefined
      ? {}
      : {
          'schema:recipeYield': [
            {
              datatype: 'quantity',
              content: { amount: `+${servings}`, unit: '1' },
            },
          ],
        }),
    ...(ingredientNotes.length === 0
      ? {}
      : {
          'schema:recipeIngredient': ingredientNotes.map((text) => ({
            datatype: 'monolingualtext',
            content: { text, language: 'en' },
          })),
        }),
    ...(method.length === 0
      ? {}
      : {
          'schema:recipeInstructions': [
            {
              datatype: 'document',
              content: {
                language: 'en',
                document: {
                  root: { props: {} },
                  content: method.map((text, index) => ({
                    type: 'Text',
                    props: { id: `step-${index + 1}`, text },
                  })),
                },
              },
            },
          ],
        }),
  },
  ingredientNotes,
  method,
});

export const RECIPE_SUBJECTS: readonly RecipeCandidate[] = [
  recipe(
    RECIPE_SUBJECT_IDS.apricotToast,
    'Apricot Window-Pan Toast',
    'A fictional, crisp-edged breakfast with warm fruit and a little orange zest.',
    [
      '2 slices country bread',
      '3 ripe apricots, halved',
      '1 teaspoon orange zest',
    ],
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
    'A fictional baked oat cup with pear, toasted seeds, and a soft center.',
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
    'A fictional one-pot supper with green lentils, tomato, and a bright herb finish.',
    [
      '1 cup green lentils',
      '1 small onion, diced',
      '1 can crushed tomatoes',
      'A handful of chopped parsley',
    ],
    [
      'Soften the onion in a covered pot with a splash of water.',
      'Add lentils, tomatoes, and enough water to cover; simmer until the lentils are tender, then fold through parsley.',
    ],
    38,
    4,
  ),
];

const sparseRecipe = recipe(
  RECIPE_SUBJECT_IDS.apricotToast,
  'Apricot Window-Pan Toast',
  'A fictional recipe with a name and no recorded optional facts.',
  [],
  [],
);

export const RECIPE_PREVIEW_LABEL =
  'Development preview · fictional recipes; no live catalogue or official-site claim.';

type StarterNode = { type: string; props: Record<string, unknown> };
type StarterDocument = { root: unknown; content: StarterNode[] };

const starterPage = recipeStarter.pages.find(({ route }) => route === '');
const starterDocument = starterPage?.document as StarterDocument | undefined;
const starterStack = starterDocument?.content[0];
const starterChildren = starterStack?.props.children as
  StarterNode[] | undefined;

function homeDocument(stateCopy: string): StarterDocument {
  if (!starterDocument || !starterStack || !starterChildren)
    throw new Error('The Recipe starter home is missing.');
  const heading = starterChildren.find(
    ({ type, props }) => type === 'Heading' && props.id === 'title',
  );
  const intro = starterChildren.find(
    ({ type, props }) => type === 'Text' && props.id === 'intro',
  );
  const list = starterChildren.find(({ type }) => type === 'TypeList');
  const slots = starterChildren.filter(({ type }) => type === 'Slot');
  if (!heading || !intro || !list || slots.length !== 4)
    throw new Error('The Recipe starter home changed shape.');

  return {
    ...starterDocument,
    content: [
      {
        ...starterStack,
        props: {
          ...starterStack.props,
          children: [
            heading,
            { type: 'Text', props: { id: 'preview-note', text: stateCopy } },
            intro,
            list,
            ...slots,
          ],
        },
      },
    ],
  };
}

export const RECIPE_HOME_DOCUMENTS = {
  admitted: homeDocument(RECIPE_PREVIEW_LABEL),
  empty: homeDocument(
    `${RECIPE_PREVIEW_LABEL} This read is ready and has no matching recipes.`,
  ),
  sparse: homeDocument(
    `${RECIPE_PREVIEW_LABEL} One fictional recipe is shown with its optional facts absent.`,
  ),
} as const;

export const RECIPE_HOME_COPY = {
  admitted: RECIPE_SUBJECTS,
  empty: [],
  sparse: [sparseRecipe],
} as const satisfies Record<
  'admitted' | 'empty' | 'sparse',
  readonly RecipeCandidate[]
>;

function statements(
  candidate: RecipeCandidate,
): Record<string, RecipeStatement[]> {
  return Object.fromEntries(
    Object.entries(candidate.facts).map(([property, facts]) => [
      property,
      facts.map((fact, index) => ({
        id: `${candidate.id}:${property}:${index + 1}`,
        rank: 'normal' as const,
        property: { id: property, data_type: fact.datatype },
        value: { type: 'value' as const, content: fact.content },
        qualifiers: [] as [],
        references: [] as [],
      })),
    ]),
  );
}

export function recipeSubjectRecord(candidate: RecipeCandidate) {
  return {
    id: candidate.id,
    type: candidate.type,
    labels: candidate.labels,
    descriptions: candidate.descriptions,
    aliases: candidate.aliases,
    statements: statements(candidate),
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
): ZonePageResponse {
  return {
    profile: 'schema:Recipe',
    template: { scope: 'route', key: '' },
    document: RECIPE_HOME_DOCUMENTS[state],
    reads: {
      works: { items: RECIPE_HOME_COPY[state].map(recipeSubjectRecord) },
    },
    zone: recipeZone(state),
  };
}

export function recipeSubject(
  id: string,
  state: 'admitted' | 'empty' | 'sparse',
): RecipeCandidate | undefined {
  const visible = RECIPE_HOME_COPY[state];
  const matching = visible.find((candidate) => candidate.id === id);
  if (!matching) return undefined;
  if (state === 'sparse') return sparseRecipe;
  return RECIPE_SUBJECTS.find((candidate) => candidate.id === id);
}

export function recipeSubjectResponse(
  candidate: RecipeCandidate,
  zone: ZonePublic,
): ZonePageResponse {
  const detail = candidate.method.length
    ? candidate.method.join('\n\n')
    : 'This preview has no preparation notes or optional facts for this recipe.';
  const document: StarterDocument = {
    root: { props: {} },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'recipe-detail',
          gap: 'md',
          children: [
            {
              type: 'Heading',
              props: {
                id: 'recipe-title',
                text: candidate.labels.en,
                level: 1,
              },
            },
            {
              type: 'Text',
              props: {
                id: 'recipe-description',
                text: candidate.descriptions.en,
              },
            },
            {
              type: 'Heading',
              props: {
                id: 'recipe-preparation-heading',
                text: 'Fictional preparation notes',
                level: 2,
              },
            },
            { type: 'Text', props: { id: 'recipe-preparation', text: detail } },
          ],
        },
      },
    ],
  };
  return {
    profile: 'schema:Recipe',
    template: { scope: 'type', key: 'schema:Recipe' },
    document,
    reads: { subject: recipeSubjectRecord(candidate) },
    zone,
    subject: candidate.id,
    views: ['overview'],
  };
}

export function recipeFact(
  candidate: RecipeCandidate,
  property: string,
): RecipeFact | undefined {
  return candidate.facts[property]?.[0];
}
