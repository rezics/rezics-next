import { t } from 'elysia';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import { readSubjectSummaryObservation, type SubjectSummary } from '../semantic/summaries.ts';
import {
  preparePublicationPage,
  type PublicationDependencies,
  type PublicationHead,
  type PublicationReadContext,
} from './publication.ts';

export const REALM_HOME_PUBLICATION_LIMIT = 12;
export type RealmHomePublication = Readonly<{ publication: PublicationHead; summary: SubjectSummary }>;
export type RealmHomePublicationPage = Readonly<{
  items: readonly RealmHomePublication[];
  next: string | null;
}>;

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
export const RealmHomePublicationQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ maxLength: 4096 })),
    languages: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 16 })),
  },
  closed,
);
export const RealmHomePublicationPageSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          publication: t.Object(
            {
              realmId: id,
              subjectId: id,
              publicationId: id,
              verdict: t.Literal('adopt'),
              subjectRevisionId: t.Null(),
              publishedAt: t.String({ format: 'date-time' }),
            },
            closed,
          ),
          summary: SubjectSummarySchema,
        },
        closed,
      ),
      { maxItems: REALM_HOME_PUBLICATION_LIMIT },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

/** The same bounded reader serves the initial home and its publication-only
 * continuation. Its cursor is the ordinary native publication cursor at limit12.
 * There is no refill, second raw page, Subject HTTP call or unavailable count.
 */
export function createRealmHomePublicationObservationReader(deps: PublicationDependencies) {
  return async (
    realmId: string,
    context: PublicationReadContext,
    query: { cursor?: string; languages?: readonly string[] } = {},
  ): Promise<RealmHomePublicationObservation | null> => {
    requireAccessDeadline(context.deadline);
    const selection = await preparePublicationPage(deps, realmId, context, {
      limit: REALM_HOME_PUBLICATION_LIMIT,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    if (!selection) return null;
    const ids = [...new Set(selection.page.items.map((item) => item.subjectId))];
    const observation = await readSubjectSummaryObservation(
      { pool: deps.pool, access: deps.access, routeKey: deps.routeKey, ...context },
      ids,
      { languages: query.languages ?? [] },
    );
    // Semantic owns the source/label/media projection and each native home
    // witness. Publication owns exact selected heads and the container binding.
    // Both protocols release their connections before the other authority runs.
    const items: RealmHomePublication[] = [];
    for (const publication of selection.page.items) {
      const summary = observation.summaries.get(publication.subjectId);
      if (summary) items.push({ publication, summary });
    }
    return {
      page: { items, next: selection.page.next },
      async current() {
        requireAccessDeadline(context.deadline);
        return (await observation.current()) && (await selection.current());
      },
    };
  };
}

export type RealmHomePublicationObservation = Readonly<{
  page: RealmHomePublicationPage;
  current: () => Promise<boolean>;
}>;

export function createRealmHomePublicationReader(deps: PublicationDependencies) {
  const observe = createRealmHomePublicationObservationReader(deps);
  return async (
    realmId: string,
    context: PublicationReadContext,
    query: { cursor?: string; languages?: readonly string[] } = {},
  ): Promise<RealmHomePublicationPage | null> => {
    const observation = await observe(realmId, context, query);
    if (!observation) return null;
    if (!(await observation.current())) throw new AccessUnavailableError('contention');
    requireAccessDeadline(context.deadline);
    return observation.page;
  };
}

export function realmHomePublicationResponse(page: RealmHomePublicationPage) {
  return {
    items: page.items.map(({ publication, summary }) => ({
      publication: { ...publication, publishedAt: new Date(publication.publishedAt).toISOString() },
      summary,
    })),
    next: page.next,
  };
}
