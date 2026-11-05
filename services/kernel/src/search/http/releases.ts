import { activeRelease } from '../../semantic/definitions.ts';
import type { Resource, AccessCheck } from '../../request/access.ts';
import { t } from 'elysia';
import { createSearchService } from '../service.ts';
import { searchHit, createCatalogueResponseAdapter } from './catalogue.ts';
const object = { additionalProperties: false } as const;
const releaseSearchHit = t.Object(
  { ...searchHit.properties, matchEvidence: t.Optional(searchHit.properties.matchEvidence) },
  object,
);
const releaseSearchGroup = t.Union([
  t.Object(
    {
      kind: t.Literal('work'),
      id: t.String({ format: 'uuid' }),
      work: releaseSearchHit,
      releases: t.Array(releaseSearchHit, { minItems: 1, maxItems: 3 }),
      next: t.Union([t.String(), t.Null()]),
    },
    object,
  ),
  t.Object(
    {
      kind: t.Literal('release'),
      id: t.String({ format: 'uuid' }),
      release: releaseSearchHit,
      workLink: t.Union([
        t.Literal('missing'),
        t.Literal('unknown'),
        t.Literal('conflicting'),
        t.Literal('unavailable'),
        t.Literal('unproven'),
      ]),
    },
    object,
  ),
]);
export const releaseGroupsResponse = t.Object(
  {
    status: t.Union([t.Literal('ready'), t.Literal('preparing')]),
    groups: t.Array(releaseSearchGroup, { maxItems: 20 }),
    next: t.Union([t.String(), t.Null()]),
    as_of: t.String({ format: 'date-time' }),
  },
  object,
);
export const releaseChildrenResponse = t.Object(
  {
    status: t.Union([t.Literal('ready'), t.Literal('preparing')]),
    children: t.Array(releaseSearchHit, { maxItems: 20 }),
    next: t.Union([t.String(), t.Null()]),
    as_of: t.String({ format: 'date-time' }),
  },
  object,
);

type ReleasePage = Awaited<ReturnType<ReturnType<typeof createSearchService>['releaseGroups']>>;
export async function releaseResponse(
  page: ReleasePage,
  adapter: ReturnType<typeof createCatalogueResponseAdapter>,
  authorize: (resource: Resource) => Promise<AccessCheck>,
  languages: readonly string[],
  active: Awaited<ReturnType<typeof activeRelease>>,
) {
  const { fill, publicBases } = adapter;
  if ('groups' in page) {
    const cards = page.groups.flatMap((group) =>
      group.kind === 'work' ? [group.work, ...group.releases] : [group.release],
    );
    const enriched = publicBases(await fill({ subjects: cards }, authorize, languages, active), languages, active);
    const byId = new Map(enriched.subjects.map((card) => [card.id, card]));
    return {
      ...page,
      groups: page.groups.map((group) =>
        group.kind === 'work'
          ? {
              ...group,
              work: byId.get(group.work.id)!,
              releases: group.releases.map((card) => byId.get(card.id)!),
            }
          : { ...group, release: byId.get(group.release.id)! },
      ),
    };
  }
  const enriched = publicBases(
    await fill({ subjects: page.children }, authorize, languages, active),
    languages,
    active,
  );
  return { ...page, children: enriched.subjects };
}
