import { t } from 'elysia';
import { resourceSummary } from '../media/summary-contract.ts';
import { resolvedTarget } from '../target/contract.ts';
import { typeDefinition } from '../types/contract.ts';
import { readId, readPosition, workHeader } from '../work/read-contract.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';

const closed = { additionalProperties: false } as const;
export const entityPageContext = t.Union([t.Literal(GLOBAL_CLASSIFICATION_CONTEXT), readId]);
export const sectionIds = [
  'statements',
  'relations',
  'contents',
  'releases',
  'credits',
  'ratings',
  'reviews',
  'discussion',
  'lists',
  'recipe',
  'prompt',
  'skill',
] as const;
export type SectionId = (typeof sectionIds)[number];
export const entitySection = t.Object(
  {
    id: t.Union([
      t.Literal('statements'),
      t.Literal('relations'),
      t.Literal('contents'),
      t.Literal('releases'),
      t.Literal('credits'),
      t.Literal('ratings'),
      t.Literal('reviews'),
      t.Literal('discussion'),
      t.Literal('lists'),
      t.Literal('recipe'),
      t.Literal('prompt'),
      t.Literal('skill'),
    ]),
    href: t.String(),
    actions: t.Array(t.String(), { uniqueItems: true }),
    count: t.Optional(
      t.Object(
        {
          value: t.Integer({ minimum: 0 }),
          precision: t.Literal('exact'),
          context: readId,
          target: readId,
        },
        closed,
      ),
    ),
  },
  closed,
);
export const entityPage = t.Object(
  {
    profile: t.Literal('entity-page-v1'),
    target: resolvedTarget,
    summary: resourceSummary,
    registry: typeDefinition,
    work: t.Nullable(workHeader),
    sections: t.Array(entitySection, { maxItems: sectionIds.length, uniqueItems: true }),
    mergedFacts: t.Optional(t.Object({
      origins: t.Array(t.Object({ resource: readId,work: workHeader,
        sections: t.Array(entitySection, { maxItems: sectionIds.length }) },closed), { maxItems: 4 }),
      nextCursor: t.Nullable(t.String()),
    },closed)),
    sourcePosition: readPosition,
  },
  closed,
);

const value = t.Union([
  t.Object({ kind: t.Literal('resource'), iri: t.String() }, closed),
  t.Object(
    {
      kind: t.Literal('literal'),
      lexical: t.String(),
      datatype: t.String(),
      language: t.Nullable(t.String()),
    },
    closed,
  ),
  t.Object({ kind: t.Literal('some-value') }, closed),
  t.Object({ kind: t.Literal('no-value') }, closed),
]);
const statement = t.Object(
  {
    kind: t.Literal('statement'),
    statement: readId,
    revision: readId,
    predicate: t.String(),
    value,
    relationDefinition: t.String(),
    speaker: t.String(),
    meaningKey: t.String(),
    qualifiers: t.Object(
      { applicability: t.Array(t.String()), interpretationDefinitions: t.Array(t.String()) },
      closed,
    ),
    sources: t.Array(t.String()),
    acceptance: t.Object(
      {
        context: t.String(),
        decision: readId,
        source: t.Union([t.Literal('local'), t.Literal('global'), t.Literal('inherited-global')]),
      },
      closed,
    ),
  },
  closed,
);
// Component properties are owner assertions, not identified rdf:Statements. Keep
// their exact typed values and revision without manufacturing Statement IDs.
const componentProperty = t.Object(
  {
    kind: t.Literal('component-property'),
    revision: readId,
    predicate: t.String(),
    value: t.Record(t.String(), t.Unknown()),
    qualifiers: t.Object(
      { applicability: t.Array(t.String()), interpretationDefinitions: t.Array(t.String()) },
      closed,
    ),
    sources: t.Array(t.String()),
  },
  closed,
);
export const subjectStatementPage = t.Object(
  {
    profile: t.Literal('subject-statements-v1'),
    resource: readId,
    acceptanceContext: t.String(),
    groups: t.Array(
      t.Object(
        { predicate: t.String(), items: t.Array(t.Union([statement, componentProperty])) },
        closed,
      ),
    ),
    nextCursor: t.Nullable(t.String()),
    sourcePosition: readPosition,
    count: t.Object(
      { value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() },
      closed,
    ),
  },
  closed,
);

/** Fixed descriptor inventory; one target resolve and its existing owner header.
 * Counts reuse the rating owner only when installed; no inventory-wide COUNT. */
export const ENTITY_PAGE_COST = {
  targets: 1,
  mergedOrigins: 4,
  maxSections: sectionIds.length,
  registryReads: 0,
  ratingReads: 1,
} as const;
